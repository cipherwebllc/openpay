import { describe, it, expect, vi } from 'vitest';
import { encodePacked, getAddress, type Address, type Hex } from 'viem';
import {
  signUsdcPermit,
  getCircleUserOpGasPrice,
  prepareAndSignCircleUserOp,
  broadcastCircleUserOp,
  buildCircleSmartAccountClient,
  entryPoint08Address,
  type CircleSmartAccountBundle,
} from '@/lib/smartAccount/circleAccount';
import { assertCirclePaymasterDeployed } from '@/lib/circlePermit';
import { resolveDeployment } from '@/lib/tokens';

// 重い account builder (permissionless to7702SimpleSmartAccount + viem
// createBundlerClient) はモックせず、bundle を直接組んで orchestration 関数を単体検証する。
const TOKEN = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'); // USDC Arb Sepolia
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966'); // v0.8 testnet
const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const CHAIN_ID = 421614;

function fakeBundle(
  bundlerOverrides: Record<string, unknown> = {},
): CircleSmartAccountBundle {
  const deployment = resolveDeployment('usdc', CHAIN_ID)!;
  return {
    provider: 'circle',
    entryPointVersion: '0.8',
    account: {} as CircleSmartAccountBundle['account'],
    bundlerClient: {
      request: vi.fn(),
      estimateUserOperationGas: vi.fn(),
      sendUserOperation: vi.fn(),
      waitForUserOperationReceipt: vi.fn(),
      ...bundlerOverrides,
    } as unknown as CircleSmartAccountBundle['bundlerClient'],
    chainId: CHAIN_ID,
    deployment,
    paymasterAddress: PAYMASTER,
  };
}

// readContract を functionName でルーティングするモック publicClient。
function fakePublicClient(opts: {
  domainChainId?: bigint;
  verifyingContract?: Address;
  nonce?: bigint;
  code?: Hex | undefined;
}) {
  return {
    readContract: vi.fn(async (params: { functionName: string }) => {
      if (params.functionName === 'eip712Domain') {
        return [
          '0x0f',
          'USD Coin',
          '2',
          opts.domainChainId ?? BigInt(CHAIN_ID),
          opts.verifyingContract ?? TOKEN,
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          [],
        ];
      }
      if (params.functionName === 'nonces') return opts.nonce ?? 0n;
      throw new Error(`unexpected readContract ${params.functionName}`);
    }),
    getCode: vi.fn(async () => opts.code),
    getChainId: vi.fn(async () => CHAIN_ID),
  } as unknown as Parameters<typeof signUsdcPermit>[0]['publicClient'];
}

describe('signUsdcPermit', () => {
  it('deadline=MAX / spender=paymaster で署名し paymasterData を組む', async () => {
    const sig = `0x${'ab'.repeat(65)}` as Hex;
    const signTypedData = vi.fn(async (_params: unknown) => sig);
    const walletClient = {
      signTypedData,
    } as unknown as Parameters<typeof signUsdcPermit>[0]['walletClient'];
    const publicClient = fakePublicClient({});
    const bundle = fakeBundle();

    const permitAmount = 5_000_000n;
    const res = await signUsdcPermit({
      publicClient,
      walletClient,
      bundle,
      owner: OWNER,
      permitAmount,
    });

    // signTypedData に渡った message を検証
    const call = signTypedData.mock.calls[0][0] as unknown as {
      primaryType: string;
      message: {
        owner: Address;
        spender: Address;
        value: bigint;
        deadline: bigint;
      };
    };
    expect(call.primaryType).toBe('Permit');
    expect(call.message.spender).toBe(PAYMASTER);
    expect(call.message.owner).toBe(OWNER);
    expect(call.message.value).toBe(permitAmount);
    expect(call.message.deadline).toBe(2n ** 256n - 1n);

    // paymasterData は encodePacked(uint8(0), token, amount, sig)
    expect(res.permitSignature).toBe(sig);
    expect(res.paymasterData).toBe(
      encodePacked(
        ['uint8', 'address', 'uint256', 'bytes'],
        [0, TOKEN, permitAmount, sig],
      ),
    );
  });

  it('permit domain の chainId drift で throw (revert 早期切り分け)', async () => {
    const walletClient = {
      signTypedData: vi.fn(),
    } as unknown as Parameters<typeof signUsdcPermit>[0]['walletClient'];
    const publicClient = fakePublicClient({ domainChainId: 8453n });
    await expect(
      signUsdcPermit({
        publicClient,
        walletClient,
        bundle: fakeBundle(),
        owner: OWNER,
        permitAmount: 1_000_000n,
      }),
    ).rejects.toThrow(/chainId/);
  });
});

describe('getCircleUserOpGasPrice', () => {
  it('pimlico_getUserOperationGasPrice standard tier を bigint で返す', async () => {
    const request = vi.fn(async () => ({
      standard: {
        maxFeePerGas: '0x3b9aca00', // 1e9
        maxPriorityFeePerGas: '0x1dcd6500', // 5e8
      },
    }));
    const bundle = fakeBundle({ request });
    const got = await getCircleUserOpGasPrice(bundle);
    expect(got.maxFeePerGas).toBe(1_000_000_000n);
    expect(got.maxPriorityFeePerGas).toBe(500_000_000n);
    expect(request).toHaveBeenCalledWith({
      method: 'pimlico_getUserOperationGasPrice',
      params: [],
    });
  });

  it('ceiling 超過の gas price は GasCongestedError で弾く (P2: Circle 送信経路の上限ガード)', async () => {
    // arbSepolia (421614) の既定 ceiling は 1000 gwei。これを超える standard gas は署名/送信前に
    // 拒否し、送信時スパイクで顧客 USDC が permit 上限まで過大 pull されるのを防ぐ。
    const request = vi.fn(async () => ({
      standard: {
        maxFeePerGas: `0x${(2000n * 10n ** 9n).toString(16)}`, // 2000 gwei > 1000 ceiling
        maxPriorityFeePerGas: '0x1dcd6500',
      },
    }));
    await expect(
      getCircleUserOpGasPrice(fakeBundle({ request })),
    ).rejects.toThrow(/gas_congested/);
  });
});

// 本番の送信は prepare+sign → (pending store に保存) → broadcast に分かれる (lib/smartAccount/circleSend.ts)。
// 旧「素の送信」helper (sendCircleUserOperation・estimateCircleUserOp) は本番から呼ばれず削除した
// (第 7 回レビュー A15) ので、Circle 下限の強制と同一 op の broadcast はここで現行の境界に対して固定する。
const SENDER = getAddress('0x2222222222222222222222222222222222222222');

function preparedOp(postOp: bigint | undefined) {
  return {
    sender: SENDER,
    nonce: 0n,
    callData: '0xabc' as Hex,
    callGasLimit: 50_000n,
    verificationGasLimit: 60_000n,
    preVerificationGas: 40_000n,
    maxFeePerGas: 16n,
    maxPriorityFeePerGas: 8n,
    paymaster: PAYMASTER,
    paymasterData: '0xpm' as Hex,
    paymasterVerificationGasLimit: 20_000n,
    paymasterPostOpGasLimit: postOp,
    signature: '0x' as Hex,
  };
}

function signingBundle(postOp: bigint | undefined) {
  const request = vi.fn(async () => ({
    standard: { maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x8' },
  }));
  const prepareUserOperation = vi.fn(async (_params: unknown) => preparedOp(postOp));
  const signUserOperation = vi.fn(async (_op: unknown) => `0x${'11'.repeat(65)}` as Hex);
  const bundle = fakeBundle({ request, prepareUserOperation });
  (bundle as { account: unknown }).account = { signUserOperation };
  return { bundle, prepareUserOperation, signUserOperation };
}

describe('prepareAndSignCircleUserOp (Circle 下限は署名前に強制)', () => {
  it('postOp が Circle 下限 (15000) 未満なら 15000 に引き上げた op に署名する', async () => {
    const { bundle, prepareUserOperation, signUserOperation } = signingBundle(11_360n);
    const calls = [{ to: TOKEN, data: '0xabc' as Hex }];
    const { signedUserOp, userOpHash } = await prepareAndSignCircleUserOp({
      bundle,
      calls,
      paymasterData: '0xpm' as Hex,
    });
    // prepare には paymaster・paymasterData・Circle 下限・standard tier の gas price が渡る。
    expect(prepareUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        calls,
        paymaster: PAYMASTER,
        paymasterData: '0xpm',
        paymasterPostOpGasLimit: 15_000n,
        maxFeePerGas: 16n,
        maxPriorityFeePerGas: 8n,
      }),
    );
    // 署名は下限を適用した op に対して行う (署名後に書き換えない)。
    expect(signUserOperation.mock.calls[0][0]).toMatchObject({ paymasterPostOpGasLimit: 15_000n });
    expect(signedUserOp.paymasterPostOpGasLimit).toBe('0x3a98');
    expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('postOp が下限以上ならその値のまま署名する', async () => {
    const { bundle, signUserOperation } = signingBundle(22_000n);
    const { signedUserOp } = await prepareAndSignCircleUserOp({
      bundle,
      calls: [],
      paymasterData: '0x' as Hex,
    });
    expect(signUserOperation.mock.calls[0][0]).toMatchObject({ paymasterPostOpGasLimit: 22_000n });
    expect(signedUserOp.paymasterPostOpGasLimit).toBe('0x55f0');
  });

  it('postOp の見積が無いときも下限で署名する', async () => {
    const { bundle, signUserOperation } = signingBundle(undefined);
    await prepareAndSignCircleUserOp({ bundle, calls: [], paymasterData: '0x' as Hex });
    expect(signUserOperation.mock.calls[0][0]).toMatchObject({ paymasterPostOpGasLimit: 15_000n });
  });
});

describe('broadcastCircleUserOp (保存済みの署名済み op をそのまま送る)', () => {
  it('raw eth_sendUserOperation に同じ op と EntryPoint v0.8 を渡し、再試行しない', async () => {
    const request = vi.fn(async (..._args: unknown[]) => `0x${'ab'.repeat(32)}` as Hex);
    const signedUserOp = { sender: SENDER, nonce: '0x0', signature: '0x11' };
    const hash = await broadcastCircleUserOp({
      bundle: fakeBundle({ request }),
      signedUserOp,
    });
    expect(hash).toBe(`0x${'ab'.repeat(32)}`);
    expect(request).toHaveBeenCalledWith(
      { method: 'eth_sendUserOperation', params: [signedUserOp, entryPoint08Address] },
      { retryCount: 0 },
    );
  });
});

describe('buildCircleSmartAccountClient', () => {
  it('USDC 以外の deployment を拒否する', async () => {
    const jpyc = resolveDeployment('jpyc', 80002)!; // Polygon Amoy JPYC
    await expect(
      buildCircleSmartAccountClient({
        walletClient: {} as never,
        publicClient: fakePublicClient({}) as never,
        chainId: 80002,
        deployment: jpyc,
      }),
    ).rejects.toThrow(/USDC 専用/);
  });
});

describe('assertCirclePaymasterDeployed (C3 guard)', () => {
  it('allowlist アドレスに code が無ければ throw', async () => {
    const publicClient = fakePublicClient({ code: '0x' });
    await expect(
      assertCirclePaymasterDeployed(publicClient as never, CHAIN_ID),
    ).rejects.toThrow(/contract code/);
  });

  it('登録済 codehash と不一致の code なら throw (B1: 信頼境界 codehash 検証)', async () => {
    // CHAIN_ID (421614=Arb Sepolia) は CIRCLE_PAYMASTER_CODEHASH 登録済。任意の
    // 非空 code は実 paymaster の codehash と一致しないので keccak256 不一致で弾く。
    // (一致 path = 実 bytecode は scripts/verify-circle-codehash.mjs が全 chain で on-chain 検証済。)
    const publicClient = fakePublicClient({ code: '0x6080604052' });
    await expect(
      assertCirclePaymasterDeployed(publicClient as never, CHAIN_ID),
    ).rejects.toThrow(/codehash/);
  });
});
