import { describe, it, expect, vi } from 'vitest';
import { encodePacked, getAddress, type Address, type Hex } from 'viem';
import {
  signUsdcPermit,
  getCircleUserOpGasPrice,
  estimateCircleUserOp,
  sendCircleUserOperation,
  buildCircleSmartAccountClient,
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
});

describe('estimateCircleUserOp', () => {
  it('postOp が Circle 下限 (15000) 未満なら 15000 に引上げる', async () => {
    const estimateUserOperationGas = vi.fn(async () => ({
      callGasLimit: 50_000n,
      verificationGasLimit: 60_000n,
      preVerificationGas: 40_000n,
      paymasterVerificationGasLimit: 20_000n,
      paymasterPostOpGasLimit: 11_360n, // bundler 推定 (下限未満)
    }));
    const bundle = fakeBundle({ estimateUserOperationGas });
    const got = await estimateCircleUserOp({
      bundle,
      calls: [{ to: TOKEN, data: '0x' }],
      paymasterData: '0xdead',
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });
    expect(got.paymasterPostOpGasLimit).toBe(15_000n);
    // estimate には Circle 下限が渡る
    expect(estimateUserOperationGas).toHaveBeenCalledWith(
      expect.objectContaining({
        paymaster: PAYMASTER,
        paymasterData: '0xdead',
        paymasterPostOpGasLimit: 15_000n,
      }),
    );
  });

  it('postOp が下限以上ならその値を保持する', async () => {
    const estimateUserOperationGas = vi.fn(async () => ({
      callGasLimit: 1n,
      verificationGasLimit: 1n,
      preVerificationGas: 1n,
      paymasterVerificationGasLimit: 1n,
      paymasterPostOpGasLimit: 22_000n,
    }));
    const got = await estimateCircleUserOp({
      bundle: fakeBundle({ estimateUserOperationGas }),
      calls: [],
      paymasterData: '0x',
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });
    expect(got.paymasterPostOpGasLimit).toBe(22_000n);
  });
});

describe('sendCircleUserOperation', () => {
  it('完全な gas セット + paymaster + paymasterData で送信し hash を返す', async () => {
    const request = vi.fn(async () => ({
      standard: { maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x8' },
    }));
    const estimateUserOperationGas = vi.fn(async () => ({
      callGasLimit: 50_000n,
      verificationGasLimit: 60_000n,
      preVerificationGas: 40_000n,
      paymasterVerificationGasLimit: 20_000n,
      paymasterPostOpGasLimit: 16_000n,
    }));
    const sendUserOperation = vi.fn(async (_params: unknown) => '0xhash' as Hex);
    const bundle = fakeBundle({
      request,
      estimateUserOperationGas,
      sendUserOperation,
    });
    const calls = [{ to: TOKEN, data: '0xabc' as Hex }];
    const hash = await sendCircleUserOperation({
      bundle,
      calls,
      paymasterData: '0xpm' as Hex,
    });
    expect(hash).toBe('0xhash');
    const sent = sendUserOperation.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(sent.paymaster).toBe(PAYMASTER);
    expect(sent.paymasterData).toBe('0xpm');
    expect(sent.maxFeePerGas).toBe(16n);
    expect(sent.maxPriorityFeePerGas).toBe(8n);
    expect(sent.callGasLimit).toBe(50_000n);
    expect(sent.paymasterPostOpGasLimit).toBe(16_000n);
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
