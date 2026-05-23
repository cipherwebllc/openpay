import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { CCTP_V2_TOKEN_MESSENGER_ABI } from '@/lib/crossChain/cctp';
import {
  executeCctpTransfer,
  executeGatewayTransfer,
  type CrossChainProgress,
} from '@/lib/crossChain/execute';
import {
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_POLYGON,
} from '@/lib/crossChain/types';
import {
  GATEWAY_MINTER_ADDRESS,
} from '@/lib/crossChain/config';
import {
  CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
} from '@/lib/crossChain/cctp';

// execute.ts は wagmi 非依存で walletClient / publicClient を引数で受ける純粋
// 関数。本テストは vitest mock objects を渡して call sequence + 戻り値を検証。

const ACCOUNT = getAddress('0x1234567890123456789012345678901234567890');
const RECIPIENT = getAddress('0x000000000000000000000000000000000000aBcd');
const SOURCE_TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const DEST_TOKEN = getAddress('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582');

// args type を明示することで mock.calls[idx][0] が unknown ではなく実型として
// 推論される (TS2493 回避)。test fixture なので overkill 気味だが、安全な assertion
// を書くために必要。
function makeWalletClient(opts: {
  signature: Hex;
  txHashes: Hex[]; // sendTransaction / writeContract で順番に返す
}) {
  let i = 0;
  return {
    chain: { id: 84532 },
    signTypedData: vi.fn(async (_args: Record<string, unknown>) => opts.signature),
    sendTransaction: vi.fn(async (_args: Record<string, unknown>) => {
      const h = opts.txHashes[i++];
      if (!h) throw new Error('test: ran out of txHashes');
      return h;
    }),
    writeContract: vi.fn(async (_args: Record<string, unknown>) => {
      const h = opts.txHashes[i++];
      if (!h) throw new Error('test: ran out of txHashes');
      return h;
    }),
  };
}

function makePublicClient(opts: { blockNumber?: bigint } = {}) {
  return {
    getBlockNumber: vi.fn(async () => opts.blockNumber ?? 1000n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  };
}

describe('lib/crossChain/execute.executeGatewayTransfer', () => {
  it('full happy path: switch → sign → attest → switch → mint → wait', async () => {
    const walletClient = makeWalletClient({
      signature: '0xsignature1',
      txHashes: ['0xminthash01'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 500n });
    const destPublic = makePublicClient();
    const switchChainAsync = vi.fn(async (_args: { chainId: number }) => undefined);
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0xatt', signature: '0xattsig' }),
          { status: 200 },
        ),
    );
    const progress: CrossChainProgress[] = [];

    const result = await executeGatewayTransfer({
      walletClient: walletClient as unknown as Parameters<
        typeof executeGatewayTransfer
      >[0]['walletClient'],
      sourcePublicClient: sourcePublic as unknown as Parameters<
        typeof executeGatewayTransfer
      >[0]['sourcePublicClient'],
      destPublicClient: destPublic as unknown as Parameters<
        typeof executeGatewayTransfer
      >[0]['destPublicClient'],
      switchChainAsync,
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destToken: DEST_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1_000_000n,
      fetch: mockFetch as unknown as typeof fetch,
      onProgress: (p) => progress.push(p),
    });

    // call sequence
    expect(switchChainAsync).toHaveBeenCalledTimes(2);
    expect(switchChainAsync.mock.calls[0][0]).toEqual({ chainId: 84532 });
    expect(switchChainAsync.mock.calls[1][0]).toEqual({ chainId: 80002 });

    expect(sourcePublic.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(walletClient.signTypedData).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);

    // mint tx は GatewayMinter address に飛ぶ
    const sendArgs = walletClient.sendTransaction.mock.calls[0][0] as unknown as {
      to: string;
      data: string;
    };
    expect(sendArgs.to).toBe(GATEWAY_MINTER_ADDRESS);
    expect(sendArgs.data.startsWith('0x')).toBe(true);

    expect(destPublic.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: '0xminthash01',
    });

    // result
    expect(result.path).toBe('gateway');
    expect(result.mintTxHash).toBe('0xminthash01');
    expect(result.signature).toBe('0xsignature1');
    expect(result.attestation).toBe('0xatt');
    expect(result.attestationSignature).toBe('0xattsig');
    expect(result.destChainId).toBe(80002);

    // progress
    const kinds = progress.map((p) => p.kind);
    expect(kinds).toEqual([
      'switch_chain',
      'sign',
      'attest',
      'switch_chain',
      'dest_tx_pending',
    ]);
  });

  it('overrides で sourceSigner / salt / maxFee 上書きが BurnIntent に流れる', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 0n });
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0x', signature: '0x' }),
          { status: 200 },
        ),
    );

    const otherSigner = getAddress(
      '0x9999999999999999999999999999999999999999',
    );
    const fixedSalt: Hex =
      '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    await executeGatewayTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destToken: DEST_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1_000_000n,
      overrides: { sourceSigner: otherSigner, salt: fixedSalt, maxFee: 7777n },
      fetch: mockFetch as unknown as typeof fetch,
    });

    const typedDataArg = walletClient.signTypedData.mock.calls[0][0] as unknown as {
      message: { maxFee: bigint; spec: { salt: Hex; sourceSigner: Hex } };
    };
    expect(typedDataArg.message.maxFee).toBe(7777n);
    expect(typedDataArg.message.spec.salt).toBe(fixedSalt);
    // sourceSigner は bytes32 化される
    expect(typedDataArg.message.spec.sourceSigner).toContain(
      otherSigner.slice(2).toLowerCase(),
    );
  });

  it('attestation API が non-2xx で throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );

    await expect(
      executeGatewayTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destToken: DEST_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1_000_000n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 429/);
    // mint まで到達しない
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('lib/crossChain/execute.executeCctpTransfer', () => {
  it('full happy path: switch → approve → burn → poll → switch → receive → wait', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xapprove01', '0xburn01', '0xreceive01'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const switchChainAsync = vi.fn(async (_args: { chainId: number }) => undefined);
    // 1st iris call returns complete immediately
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [
              {
                status: 'complete',
                message: '0xmsg',
                attestation: '0xirisAtt',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const progress: CrossChainProgress[] = [];

    const result = await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync,
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1_000_000n,
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async (_ms: number) => undefined), now: () => 0 },
      onProgress: (p) => progress.push(p),
    });

    // approve は writeContract、burn と receive は sendTransaction
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    const approveArg = walletClient.writeContract.mock.calls[0][0] as unknown as {
      address: Address;
      functionName: string;
      args: [Address, bigint];
    };
    expect(approveArg.address).toBe(SOURCE_TOKEN);
    expect(approveArg.functionName).toBe('approve');
    expect(approveArg.args[0]).toBe(CCTP_V2_TOKEN_MESSENGER_ADDRESS);
    expect(approveArg.args[1]).toBe(1_000_000n);

    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
    const burnArg = walletClient.sendTransaction.mock.calls[0][0] as unknown as {
      to: Address;
    };
    expect(burnArg.to).toBe(CCTP_V2_TOKEN_MESSENGER_ADDRESS);

    const receiveArg = walletClient.sendTransaction.mock.calls[1][0] as unknown as {
      to: Address;
    };
    expect(receiveArg.to).toBe(CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS);

    // switch 2 回 (source → dest)
    expect(switchChainAsync).toHaveBeenCalledTimes(2);

    // wait は source (approve + burn) + dest (receive) = 3 回
    expect(sourcePublic.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(destPublic.waitForTransactionReceipt).toHaveBeenCalledTimes(1);

    // result
    expect(result.path).toBe('cctp-v2');
    expect(result.approveTxHash).toBe('0xapprove01');
    expect(result.burnTxHash).toBe('0xburn01');
    expect(result.mintTxHash).toBe('0xreceive01');
    expect(result.attestationMessage).toBe('0xmsg');
    expect(result.attestationSignature).toBe('0xirisAtt');
    expect(result.destChainId).toBe(80002);

    // progress
    const kinds = progress.map((p) => p.kind);
    expect(kinds).toEqual([
      'switch_chain',
      'approve',
      'source_tx_pending',
      'poll_attestation',
      'switch_chain',
      'dest_tx_pending',
    ]);
  });

  it('approve 失敗 → 後段 (burn / poll / receive) 全 skip', async () => {
    const walletClient = {
      chain: { id: 84532 },
      signTypedData: vi.fn(),
      sendTransaction: vi.fn(),
      writeContract: vi.fn(async () => {
        throw new Error('approve rejected');
      }),
    };
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/approve rejected/);
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('CCTP overrides (maxFee / minFinalityThreshold) が calldata に反映', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xa', '0xb', '0xc'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0x', attestation: '0x' }],
          }),
          { status: 200 },
        ),
    );

    await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1_000_000n,
      overrides: { maxFee: 99_999n, minFinalityThreshold: 2000 },
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async (_ms: number) => undefined), now: () => 0 },
    });

    // burn calldata を decode して maxFee 99_999 + minFinality 2000 が反映確認
    const burnArg = walletClient.sendTransaction.mock.calls[0][0] as unknown as {
      to: Address;
      data: Hex;
    };
    expect(burnArg.to).toBe(CCTP_V2_TOKEN_MESSENGER_ADDRESS);
    const decoded = decodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      data: burnArg.data,
    });
    expect(decoded.functionName).toBe('depositForBurn');
    // [amount, destDomain, mintRecipient, burnToken, destCaller, maxFee, minFinality]
    expect(decoded.args[5]).toBe(99_999n);
    expect(decoded.args[6]).toBe(2000);
  });
});

describe('lib/crossChain/execute: 各 step 失敗時の挙動', () => {
  it('Gateway: switchChainAsync fail (source switch) → sign/attest 到達せず throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();
    const switchChain = vi.fn(async (_args: { chainId: number }) => {
      throw new Error('user rejected chain switch');
    });

    await expect(
      executeGatewayTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: switchChain,
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destToken: DEST_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/user rejected chain switch/);
    // sign / attest / mint 全 skip
    expect(walletClient.signTypedData).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('Gateway: getBlockNumber fail (source RPC down) → sign 到達せず throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint'],
    });
    const sourcePublic = {
      getBlockNumber: vi.fn(async () => {
        throw new Error('rpc connection refused');
      }),
      waitForTransactionReceipt: vi.fn(),
    };
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeGatewayTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destToken: DEST_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/rpc connection refused/);
    expect(walletClient.signTypedData).not.toHaveBeenCalled();
  });

  it('Gateway: signTypedData fail (user reject) → attestation API 呼ばれない', async () => {
    const walletClient = {
      chain: { id: 84532 },
      signTypedData: vi.fn(async () => {
        throw new Error('User denied message signature');
      }),
      sendTransaction: vi.fn(),
      writeContract: vi.fn(),
    };
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeGatewayTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destToken: DEST_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/User denied message signature/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('Gateway: mint sendTransaction fail (wallet reject) → result 返らず throw', async () => {
    const walletClient = {
      chain: { id: 80002 },
      signTypedData: vi.fn(async () => '0xsig'),
      sendTransaction: vi.fn(async () => {
        throw new Error('Transaction rejected by user');
      }),
      writeContract: vi.fn(),
    };
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0x', signature: '0x' }),
          { status: 200 },
        ),
    );

    await expect(
      executeGatewayTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destToken: DEST_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Transaction rejected by user/);
    // attestation は取得済み (sign + fetch は呼ばれた)
    expect(walletClient.signTypedData).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // wait は到達しない
    expect(destPublic.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('Gateway: waitForTransactionReceipt fail (tx revert on chain) → throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint01'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = {
      getBlockNumber: vi.fn(),
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error('Transaction reverted: insufficient gas');
      }),
    };
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0x', signature: '0x' }),
          { status: 200 },
        ),
    );

    await expect(
      executeGatewayTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destToken: DEST_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/insufficient gas/);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('CCTP: approve 成功 + burn 失敗 → poll/receive 到達せず (orphaned approve は許容)', async () => {
    // approve は成功するが depositForBurn 直後の sendTransaction で reject。
    // 既に source chain の USDC allowance は GatewayMinter に許可済 = orphaned。
    // 本 plan §6 で「approve 残置は許容、buyer は次回 fresh approve で上書き」と documented。
    const walletClient = {
      chain: { id: 84532 },
      signTypedData: vi.fn(),
      sendTransaction: vi.fn(async () => {
        throw new Error('burn tx rejected');
      }),
      writeContract: vi.fn(async () => '0xapprove01' as Hex),
    };
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/burn tx rejected/);
    // approve は呼ばれた (allowance は付与済 = orphaned)
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    // burn 失敗で poll / receive 到達せず
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('CCTP: iris attestation timeout → mint 到達せず throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xapprove', '0xburn'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    // attestation が常に pending → polling timeout
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'pending_confirmations' }],
          }),
          { status: 200 },
        ),
    );

    let t = 0;
    const nowMock = vi.fn(() => {
      const cur = t;
      t += 100_000;
      return cur;
    });

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: {
          sleep: vi.fn(async (_ms: number) => undefined),
          now: nowMock,
          timeoutMs: 90_000,
        },
      }),
    ).rejects.toThrow(/timeout/);
    // approve + burn は完了、mint (sendTransaction 2 回目) は到達せず
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1); // burn のみ
  });

  it('CCTP: iris response messages array が empty → polling 継続して timeout', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xa', '0xb'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    let t = 0;
    const nowMock = vi.fn(() => {
      const cur = t;
      t += 50_000;
      return cur;
    });

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async (_args: { chainId: number }) => undefined),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: {
          sleep: vi.fn(async (_ms: number) => undefined),
          now: nowMock,
          timeoutMs: 90_000,
        },
      }),
    ).rejects.toThrow(/timeout/);
  });
});
