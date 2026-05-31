import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import { CCTP_V2_TOKEN_MESSENGER_ABI } from '@/lib/crossChain/cctp';
import {
  ensureWalletChain,
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

// execute.ts の ensureWalletChain は switchChainAsync 後に walletClient.getChainId()
// が target に揃うまで poll する。実 wallet では getChainId は switch を反映するので、
// mock も両者を 1 つの mutable chain state で連動させる。mockChainId は trackSwitch()
// で更新され、makeWalletClient / 各 inline mock の getChainId が読む。beforeEach で
// reset (getChainId は switch 後にしか呼ばれないので初期値は実質 sentinel)。
let mockChainId = 0;
beforeEach(() => {
  mockChainId = 0;
});

// switchChainAsync の mock。呼ばれた chainId を mockChainId に反映し、後続の
// getChainId poll が target に揃う (= 実 wallet の switch 成功を模す)。
function trackSwitch() {
  return vi.fn(async ({ chainId }: { chainId: number }) => {
    mockChainId = chainId;
  });
}

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
    getChainId: vi.fn(async () => mockChainId),
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
    // resume の landed 検証 (txAlreadySucceeded) 用。default は成功扱い。
    getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
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
    const switchChainAsync = trackSwitch();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0xatt', signature: '0xattsig' }),
          { status: 200 },
        ),
    );
    const progress: CrossChainProgress[] = [];
    const merchantMints: Array<{ mintTxHash: string; burnTxHash?: string }> = [];

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
      onMerchantMint: (i) => merchantMints.push(i),
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

    // merchant mint 確定で onMerchantMint が発火 (会計ログ用・Gateway は burnTxHash 無し)
    expect(merchantMints).toEqual([{ mintTxHash: '0xminthash01' }]);

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
      switchChainAsync: trackSwitch(),
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
        switchChainAsync: trackSwitch(),
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
    const switchChainAsync = trackSwitch();
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
    const merchantMints: Array<{ mintTxHash: string; burnTxHash?: string }> = [];

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
      onMerchantMint: (i) => merchantMints.push(i),
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

    // merchant mint 確定で onMerchantMint が発火 (会計ログ用・CCTP は burnTxHash 付き)
    expect(merchantMints).toEqual([
      { mintTxHash: '0xreceive01', burnTxHash: '0xburn01' },
    ]);

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
      getChainId: vi.fn(async () => mockChainId),
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
        switchChainAsync: trackSwitch(),
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
      switchChainAsync: trackSwitch(),
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
        switchChainAsync: trackSwitch(),
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
      getChainId: vi.fn(async () => mockChainId),
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
        switchChainAsync: trackSwitch(),
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
      getChainId: vi.fn(async () => mockChainId),
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
        switchChainAsync: trackSwitch(),
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
        switchChainAsync: trackSwitch(),
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
      getChainId: vi.fn(async () => mockChainId),
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
        switchChainAsync: trackSwitch(),
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
        switchChainAsync: trackSwitch(),
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
        switchChainAsync: trackSwitch(),
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

// 2026-05-24 regression — wagmi walletClient.chain は switchChainAsync 後でも
// closure 内 stale reference のまま残り、viem writeContract/sendTransaction が
// "current chain mismatch" エラーを投げる事象。execute.ts は明示的に
// chainObjectForId(sourceChainId/destChainId) で Chain object を解決し、tx に
// 渡すよう改修した。本テストは「walletClient.chain が dest を指している状態でも
// source-chain tx は source Chain object で送信される」ことを担保する。
describe('lib/crossChain/execute: chain resolution from chainId (stale walletClient.chain regression)', () => {
  it('CCTP V2: walletClient.chain が dest を指していても approve / burn は source Chain object で発火', async () => {
    // walletClient.chain は dest (polygonAmoy) を指す = switchChainAsync 直前の
    // stale state (実環境で wagmi useWalletClient closure が陥る状態)。
    let sendCallIdx = 0;
    const walletClient = {
      chain: polygonAmoy, // ← dest を指す (= stale)
      getChainId: vi.fn(async () => mockChainId),
      signTypedData: vi.fn(),
      sendTransaction: vi.fn(async (_args: Record<string, unknown>) => {
        const hashes: Hex[] = ['0xburn', '0xreceive'];
        return hashes[sendCallIdx++];
      }),
      writeContract: vi.fn(
        async (_args: Record<string, unknown>) => '0xapprove' as Hex,
      ),
    };
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [
              { status: 'complete', message: '0xmsg', attestation: '0xatt' },
            ],
          }),
          { status: 200 },
        ),
    );

    await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: baseSepolia.id, // ← source = base sepolia
      destChainId: polygonAmoy.id,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1n,
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
    });

    // approve は source chain object (baseSepolia) で送信される
    const approveArg = walletClient.writeContract.mock.calls[0][0] as unknown as {
      chain: { id: number };
    };
    expect(approveArg.chain.id).toBe(baseSepolia.id);

    // burn も source chain object
    const burnArg = walletClient.sendTransaction.mock.calls[0][0] as unknown as {
      chain: { id: number };
    };
    expect(burnArg.chain.id).toBe(baseSepolia.id);

    // receive (mint on dest) は dest chain object (polygonAmoy)
    const receiveArg = walletClient.sendTransaction.mock.calls[1][0] as unknown as {
      chain: { id: number };
    };
    expect(receiveArg.chain.id).toBe(polygonAmoy.id);
  });

  it('Gateway: walletClient.chain が source を指していても dest mint は dest Chain object で発火', async () => {
    // walletClient.chain は source (baseSepolia) を指す = source switchChain 完了後の stale state。
    const walletClient = {
      chain: baseSepolia, // ← source を指す
      getChainId: vi.fn(async () => mockChainId),
      signTypedData: vi.fn(async (_args: Record<string, unknown>) => '0xsig'),
      sendTransaction: vi.fn(
        async (_args: Record<string, unknown>) => '0xmint' as Hex,
      ),
      writeContract: vi.fn(),
    };
    const sourcePublic = makePublicClient({ blockNumber: 100n });
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0xatt', signature: '0xattsig' }),
          { status: 200 },
        ),
    );

    await executeGatewayTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: baseSepolia.id,
      destChainId: polygonAmoy.id,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destToken: DEST_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1n,
      fetch: mockFetch as unknown as typeof fetch,
    });

    // mint は dest chain object (polygonAmoy) で送信される
    const mintArg = walletClient.sendTransaction.mock.calls[0][0] as unknown as {
      chain: { id: number };
    };
    expect(mintArg.chain.id).toBe(polygonAmoy.id);
  });

  it('CCTP V2: supportedChains に無い chainId を渡すと defensive throw', async () => {
    // 9999 は viem/chains に無い → chainObjectForId が undefined → execute.ts が throw。
    // 通常は CROSS_CHAIN_TARGETS 経由でしか入らないので到達しないが、safety net として
    // 「silent に wrong chain で tx 送信する」事故を防ぐ最後の壁。
    const walletClient = {
      chain: baseSepolia,
      signTypedData: vi.fn(),
      sendTransaction: vi.fn(),
      writeContract: vi.fn(),
    };
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: vi.fn(async () => undefined),
        account: ACCOUNT,
        sourceChainId: 9999, // ← unknown
        destChainId: polygonAmoy.id,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1n,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/source chainId 9999 is not in supportedChains/);
    // approve まで到達しない (chain 解決の段階で throw)
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });
});

// 2026-05-27 案A′: OpenPay 利用料を cross-chain でも徴収する。merchant 本送金に
// 加えて feeReceiver 宛にもう 1 本ブリッジし、利用料を dest チェーンに着金させる。
const FEE_RECEIVER = getAddress('0x00000000000000000000000000000000000fee01');

describe('lib/crossChain/execute: OpenPay 利用料ブリッジ (案A′)', () => {
  it('Gateway: feeReceiver 宛に 2 本目の burn intent を出し、result に feeMintTxHash', async () => {
    const walletClient = makeWalletClient({
      signature: '0xsig',
      txHashes: ['0xmint_m', '0xmint_f'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 100n });
    const destPublic = makePublicClient();
    let n = 0;
    const mockFetch = vi.fn(async () => {
      n++;
      return new Response(
        JSON.stringify({ attestation: `0xatt${n}`, signature: `0xattsig${n}` }),
        { status: 200 },
      );
    });
    const progress: CrossChainProgress[] = [];

    const result = await executeGatewayTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destToken: DEST_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 9_900_000n, // merchant (amount - fee)
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n, // 1% of 10 USDC
      fetch: mockFetch as unknown as typeof fetch,
      onProgress: (p) => progress.push(p),
    });

    // 2 sign + 2 attest + 2 mint
    expect(walletClient.signTypedData).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);

    // 1 本目 = merchant (value 9_900_000, recipient RECIPIENT)
    const m = (
      walletClient.signTypedData.mock.calls[0][0] as unknown as {
        message: { spec: { value: bigint; destinationRecipient: Hex } };
      }
    ).message.spec;
    expect(m.value).toBe(9_900_000n);
    expect(m.destinationRecipient.toLowerCase()).toContain(
      RECIPIENT.slice(2).toLowerCase(),
    );
    // 2 本目 = fee (value 100_000, recipient FEE_RECEIVER)
    const f = (
      walletClient.signTypedData.mock.calls[1][0] as unknown as {
        message: { spec: { value: bigint; destinationRecipient: Hex } };
      }
    ).message.spec;
    expect(f.value).toBe(100_000n);
    expect(f.destinationRecipient.toLowerCase()).toContain(
      FEE_RECEIVER.slice(2).toLowerCase(),
    );

    // mint は merchant → fee の順
    expect(result.mintTxHash).toBe('0xmint_m');
    expect(result.feeMintTxHash).toBe('0xmint_f');

    // progress に fee step が含まれる
    const kinds = progress.map((p) => p.kind);
    expect(kinds).toContain('fee_sign');
    expect(kinds).toContain('fee_attest');
    expect(kinds).toContain('fee_dest_tx_pending');
  });

  it('CCTP: approve=total・feeReceiver 宛に 2 本目 burn、result に feeBurn/feeMint hash', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      // 呼び出し順: approve, burn_m, burn_f, mint_m, mint_f
      txHashes: ['0xapprove', '0xburn_m', '0xburn_f', '0xmint_m', '0xmint_f'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
          }),
          { status: 200 },
        ),
    );

    const result = await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 9_900_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
    });

    // approve は merchant + fee 合算 (= 10 USDC)
    const approveArg = walletClient.writeContract.mock.calls[0][0] as unknown as {
      args: [Address, bigint];
    };
    expect(approveArg.args[1]).toBe(10_000_000n);

    // burn 2 本 + mint 2 本 = sendTransaction 4 回
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(4);

    // burn_m: amount 9_900_000, mintRecipient RECIPIENT
    const burnM = decodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      data: (
        walletClient.sendTransaction.mock.calls[0][0] as unknown as { data: Hex }
      ).data,
    });
    expect(burnM.args[0]).toBe(9_900_000n);
    expect((burnM.args[2] as string).toLowerCase()).toContain(
      RECIPIENT.slice(2).toLowerCase(),
    );
    // burn_f: amount 100_000, mintRecipient FEE_RECEIVER
    const burnF = decodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      data: (
        walletClient.sendTransaction.mock.calls[1][0] as unknown as { data: Hex }
      ).data,
    });
    expect(burnF.args[0]).toBe(100_000n);
    expect((burnF.args[2] as string).toLowerCase()).toContain(
      FEE_RECEIVER.slice(2).toLowerCase(),
    );

    // 2 burn の attestation polling → fetch 2 回
    expect(mockFetch).toHaveBeenCalledTimes(2);

    expect(result.approveTxHash).toBe('0xapprove');
    expect(result.burnTxHash).toBe('0xburn_m');
    expect(result.feeBurnTxHash).toBe('0xburn_f');
    expect(result.mintTxHash).toBe('0xmint_m');
    expect(result.feeMintTxHash).toBe('0xmint_f');
  });

  it('CCTP resume: burn 済なら approve/burn を skip し mint だけ実行', async () => {
    // resume state: 両 burn 済・mint 未了 → approve/burn skip、mint 2 本だけ。
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_m', '0xmint_f'], // sendTransaction = mint のみ
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
          }),
          { status: 200 },
        ),
    );
    const steps: Array<Record<string, unknown>> = [];

    const result = await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 9_900_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      resume: {
        approveTxHash: '0xapprove_prev',
        burnTxHash: '0xburn_m_prev',
        feeBurnTxHash: '0xburn_f_prev',
      },
      onStep: (s) => steps.push({ ...s }),
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
    });

    // approve / burn は再実行されない
    expect(walletClient.writeContract).not.toHaveBeenCalled();
    // mint 2 本だけ
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
    // burn hash は resume の値を引き継ぐ
    expect(result.burnTxHash).toBe('0xburn_m_prev');
    expect(result.mintTxHash).toBe('0xmint_m');
    expect(result.feeMintTxHash).toBe('0xmint_f');
    // onStep に mint 完了が記録される
    expect(steps.at(-1)?.mintTxHash).toBe('0xmint_m');
    expect(steps.at(-1)?.feeMintTxHash).toBe('0xmint_f');
  });

  it('CCTP resume: merchant mint 済なら fee mint だけ実行', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_f'], // fee mint のみ
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
          }),
          { status: 200 },
        ),
    );

    const merchantMints: Array<{ mintTxHash: string; burnTxHash?: string }> = [];

    const result = await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 9_900_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      resume: {
        approveTxHash: '0xapprove_prev',
        burnTxHash: '0xburn_m_prev',
        feeBurnTxHash: '0xburn_f_prev',
        mintTxHash: '0xmint_m_prev',
      },
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
      onMerchantMint: (i) => merchantMints.push(i),
    });

    // merchant mint 済なので fee poll のみ (1 回)、fee mint のみ (1 回)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.mintTxHash).toBe('0xmint_m_prev');
    expect(result.feeMintTxHash).toBe('0xmint_f');
    // merchant mint を再実行していないので attestation は再取得されない
    expect(result.attestationMessage).toBeUndefined();
    // resume で merchant mint が landed 済でも、会計ログ callback は (fee mint より前に)
    // 確定済 merchant 着金を 1 度発火する (income を取りこぼさない)。
    expect(merchantMints).toEqual([
      { mintTxHash: '0xmint_m_prev', burnTxHash: '0xburn_m_prev' },
    ]);
  });

  it('CCTP: fee mint が失敗しても merchant mint の会計 callback は発火済 (income を取りこぼさない)', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      // approve, burn_m, burn_f, mint_m まで成功、fee mint (mint_f) は hash 切れで throw。
      txHashes: ['0xapprove', '0xburn_m', '0xburn_f', '0xmint_m'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [
              { status: 'complete', message: '0xmsg', attestation: '0xatt' },
            ],
          }),
          { status: 200 },
        ),
    );
    const merchantMints: Array<{ mintTxHash: string; burnTxHash?: string }> = [];

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: trackSwitch(),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 9_900_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 100_000n,
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
        onMerchantMint: (i) => merchantMints.push(i),
      }),
    ).rejects.toThrow();

    // fee mint で throw する前に merchant mint の会計 callback は発火済。
    expect(merchantMints).toEqual([
      { mintTxHash: '0xmint_m', burnTxHash: '0xburn_m' },
    ]);
  });

  it('Gateway: onMerchantMint が throw しても決済 flow は中断しない (audit は隔離)', async () => {
    const walletClient = makeWalletClient({
      signature: '0xsig',
      txHashes: ['0xminthash01'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 500n });
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attestation: '0xatt', signature: '0xattsig' }),
          { status: 200 },
        ),
    );

    const result = await executeGatewayTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
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
      onMerchantMint: () => {
        throw new Error('audit log boom');
      },
    });

    // callback の例外は fireMerchantMint で握り潰され、merchant mint は確定して result が返る。
    expect(result.mintTxHash).toBe('0xminthash01');
  });

  it('Gateway resume: attestation 済なら再 sign せず mint だけ実行', async () => {
    const walletClient = makeWalletClient({
      signature: '0xshould_not_be_used',
      txHashes: ['0xmint_m', '0xmint_f'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 100n });
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    const result = await executeGatewayTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destToken: DEST_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 9_900_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      resume: {
        merchantAttestation: { attestation: '0xattM', signature: '0xsigM' },
        feeAttestation: { attestation: '0xattF', signature: '0xsigF' },
      },
      fetch: mockFetch as unknown as typeof fetch,
    });

    // 再 sign / attestation 取得はしない (二重 debit 防止)
    expect(walletClient.signTypedData).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    // mint 2 本だけ
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
    expect(result.attestation).toBe('0xattM');
    expect(result.mintTxHash).toBe('0xmint_m');
    expect(result.feeMintTxHash).toBe('0xmint_f');
  });

  it('feeAmount=0 では fee ブリッジを skip (従来挙動)', async () => {
    const walletClient = makeWalletClient({
      signature: '0xsig',
      txHashes: ['0xmint'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 100n });
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ attestation: '0x', signature: '0x' }), {
          status: 200,
        }),
    );

    const result = await executeGatewayTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destToken: DEST_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1_000_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 0n, // fee なし → skip
      fetch: mockFetch as unknown as typeof fetch,
    });

    expect(walletClient.signTypedData).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.feeMintTxHash).toBeUndefined();
  });

  it('CCTP: feeAmount=0 では approve=valueAtomic のみ・burn/mint 各 1 本 (Phase 1 既定経路)', async () => {
    // Phase 1 (alpha) では fee=0 が常態。fee bridge を skip し、approve は
    // valueAtomic + 0 = valueAtomic のみ (誤って +feeAmount しないこと)、
    // burn/mint は merchant 宛 1 本ずつ、attestation polling も 1 回だけ。
    const walletClient = makeWalletClient({
      signature: '0x',
      // approve, burn_m, mint_m の 3 tx のみ (fee 系なし)
      txHashes: ['0xapprove', '0xburn_m', '0xmint_m'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
          }),
          { status: 200 },
        ),
    );

    const result = await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 10_000_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 0n, // fee なし → fee bridge skip
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
    });

    // approve は valueAtomic のみ (誤って +feeAmount すると 10_000_000 を超える)
    const approveArg = walletClient.writeContract.mock.calls[0][0] as unknown as {
      args: [Address, bigint];
    };
    expect(approveArg.args[1]).toBe(10_000_000n);

    // burn 1 本 + mint 1 本 = sendTransaction 2 回 (fee 系なし)
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);

    // 唯一の burn は merchant 宛・全額
    const burnM = decodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      data: (
        walletClient.sendTransaction.mock.calls[0][0] as unknown as { data: Hex }
      ).data,
    });
    expect(burnM.args[0]).toBe(10_000_000n);
    expect((burnM.args[2] as string).toLowerCase()).toContain(
      RECIPIENT.slice(2).toLowerCase(),
    );

    // attestation polling は merchant burn の 1 回だけ
    expect(mockFetch).toHaveBeenCalledTimes(1);

    expect(result.feeBurnTxHash).toBeUndefined();
    expect(result.feeMintTxHash).toBeUndefined();
  });
});

// 2026-05-27 (LARP fix): viem の waitForTransactionReceipt は tx が revert しても
// throw せず status:'reverted' を返す。execute は status を検証して revert を
// 「成功」として扱わない (未着金決済を完了記録する事故を防ぐ)。
describe('lib/crossChain/execute: receipt status 検証 (revert を成功扱いしない)', () => {
  it('Gateway: mint が reverted → throw (成功記録しない)', async () => {
    const walletClient = makeWalletClient({
      signature: '0xsig',
      txHashes: ['0xmint'],
    });
    const sourcePublic = makePublicClient({ blockNumber: 100n });
    const destPublic = {
      getBlockNumber: vi.fn(),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })),
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
        switchChainAsync: trackSwitch(),
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
    ).rejects.toThrow(/revert/);
  });

  it('CCTP: burn が reverted → throw (mint へ進まない)', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xapprove', '0xburn'],
    });
    // approve は success、burn で reverted を返す
    let call = 0;
    const sourcePublic = {
      getBlockNumber: vi.fn(async () => 1000n),
      waitForTransactionReceipt: vi.fn(async () => {
        call += 1;
        return { status: call === 1 ? 'success' : 'reverted' };
      }),
    };
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: trackSwitch(),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1_000_000n,
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
      }),
    ).rejects.toThrow(/revert/);
    // burn revert で attestation polling に進まない
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// 2026-05-27 (codex review P1): burn hash は broadcast 直後・receipt 待ち前に
// 永続化される。receipt 待ち中の失敗 (tab close / RPC down) で burn hash が
// 失われると、再開時に再 burn = 二重支払いになるため。
describe('lib/crossChain/execute: burn hash を receipt 待ち前に永続化 (二重支払い防止)', () => {
  it('CCTP: burn broadcast 後に receipt が失敗しても burnTxHash は onStep 済', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xapprove', '0xburn'],
    });
    const sourcePublic = {
      getBlockNumber: vi.fn(async () => 1000n),
      // approve の receipt は成功、burn の receipt 待ちで RPC が落ちる想定。
      waitForTransactionReceipt: vi.fn(
        async ({ hash }: { hash: Hex }) => {
          if (hash === '0xburn') throw new Error('rpc connection lost');
          return { status: 'success' };
        },
      ),
    };
    const destPublic = makePublicClient();
    const steps: Array<Record<string, unknown>> = [];

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: trackSwitch(),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1_000_000n,
        onStep: (s) => steps.push({ ...s }),
        fetch: vi.fn() as unknown as typeof fetch,
        pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
      }),
    ).rejects.toThrow(/rpc connection lost/);

    // burn の broadcast 直後に burnTxHash が永続化されている (receipt 失敗より前)。
    // → 再開時は再 burn せず保存済 hash の attestation を poll する。
    expect(steps.some((s) => s.burnTxHash === '0xburn')).toBe(true);
  });
});

// 2026-05-27 (codex review 2nd round P2): mint hash も broadcast 直後に永続化し、
// resume では保存済 hash を on-chain 検証 (landed なら skip / revert・未 mine なら再 mint)。
// 「mint が landed したのに receipt 観測前に中断 → resume で同 attestation を再 mint →
// 既消費で revert → stuck」を防ぐ。
describe('lib/crossChain/execute: mint hash を broadcast 時に永続化 + resume で landed 検証', () => {
  it('CCTP: mint broadcast 後に receipt が失敗しても mintTxHash は onStep 済', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xapprove', '0xburn', '0xmint'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = {
      getBlockNumber: vi.fn(),
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error('rpc lost during mint');
      }),
    };
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
          }),
          { status: 200 },
        ),
    );
    const steps: Array<Record<string, unknown>> = [];

    await expect(
      executeCctpTransfer({
        walletClient: walletClient as never,
        sourcePublicClient: sourcePublic as never,
        destPublicClient: destPublic as never,
        switchChainAsync: trackSwitch(),
        account: ACCOUNT,
        sourceChainId: 84532,
        destChainId: 80002,
        destDomain: CIRCLE_DOMAIN_POLYGON,
        sourceDomain: CIRCLE_DOMAIN_BASE,
        sourceToken: SOURCE_TOKEN,
        recipient: RECIPIENT,
        valueAtomic: 1_000_000n,
        onStep: (s) => steps.push({ ...s }),
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
      }),
    ).rejects.toThrow(/rpc lost during mint/);

    expect(steps.some((s) => s.mintTxHash === '0xmint')).toBe(true);
  });

  it('CCTP resume: 永続済 mintTxHash が revert 済なら再 poll + 再 mint する', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_retry'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = {
      getBlockNumber: vi.fn(),
      // 前回 broadcast した mint は revert 済 → landed=false → 再 mint されるべき。
      getTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    };
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
          }),
          { status: 200 },
        ),
    );

    const result = await executeCctpTransfer({
      walletClient: walletClient as never,
      sourcePublicClient: sourcePublic as never,
      destPublicClient: destPublic as never,
      switchChainAsync: trackSwitch(),
      account: ACCOUNT,
      sourceChainId: 84532,
      destChainId: 80002,
      destDomain: CIRCLE_DOMAIN_POLYGON,
      sourceDomain: CIRCLE_DOMAIN_BASE,
      sourceToken: SOURCE_TOKEN,
      recipient: RECIPIENT,
      valueAtomic: 1_000_000n,
      resume: {
        approveTxHash: '0xa',
        burnTxHash: '0xb',
        mintTxHash: '0xmint_old',
      },
      fetch: mockFetch as unknown as typeof fetch,
      pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
    });

    // 前回 mint が revert 済なので attestation を再 poll し再 mint する。
    expect(destPublic.getTransactionReceipt).toHaveBeenCalledWith({
      hash: '0xmint_old',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.mintTxHash).toBe('0xmint_retry');
  });
});

// 2026-05-27 (testnet 実機): Base Sepolia 受取 → OP Sepolia 支払元の CCTP で
// approve が "current chain of the wallet (84532) does not match target (11155420)"
// で abort。switchChainAsync は resolve したが injected provider の eth_chainId が
// 新 chain を報告するまでに lag があり、viem writeContract の chain assert に間に
// 合わなかったのが原因。ensureWalletChain は switch 後 live chainId が target に
// 揃うまで bounded poll してこのレースを閉じる。
describe('lib/crossChain/execute.ensureWalletChain (switch 後 chainId 確認 poll)', () => {
  it('switch 直後は旧 chain でも poll で target に揃えば resolve する (race 解消)', async () => {
    // getChainId: early-check=旧, poll1=旧 (まだ lag), poll2=target。
    const seq = [84532, 84532, 11155420];
    let idx = 0;
    const walletClient = {
      getChainId: vi.fn(async () => seq[Math.min(idx++, seq.length - 1)]),
    };
    const switchChainAsync = vi.fn(async (_a: { chainId: number }) => undefined);

    vi.useFakeTimers();
    try {
      const p = ensureWalletChain(walletClient as never, switchChainAsync, 11155420);
      await vi.advanceTimersByTimeAsync(150 * 3);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 11155420 });
    // early-check 1 + poll 2 = 3 回 getChainId を見て揃ったところで止まる。
    expect(walletClient.getChainId).toHaveBeenCalledTimes(3);
  });

  it('既に target chain なら switchChainAsync を呼ばず即 return (不要な popup 回避)', async () => {
    const walletClient = { getChainId: vi.fn(async () => 11155420) };
    const switchChainAsync = vi.fn(async (_a: { chainId: number }) => undefined);

    await expect(
      ensureWalletChain(walletClient as never, switchChainAsync, 11155420),
    ).resolves.toBeUndefined();

    expect(switchChainAsync).not.toHaveBeenCalled();
    expect(walletClient.getChainId).toHaveBeenCalledTimes(1);
  });

  it('switch 後も target に揃わなければ bounded poll 後に明示 throw する', async () => {
    // getChainId が永遠に旧 chain を返す = wallet が実際には switch していない。
    const walletClient = { getChainId: vi.fn(async () => 84532) };
    const switchChainAsync = vi.fn(async (_a: { chainId: number }) => undefined);

    vi.useFakeTimers();
    try {
      const p = ensureWalletChain(walletClient as never, switchChainAsync, 11155420);
      p.catch(() => {}); // unhandled rejection 抑制
      await vi.advanceTimersByTimeAsync(150 * 25);
      await expect(p).rejects.toThrow(/eth_chainId が一致しません/);
    } finally {
      vi.useRealTimers();
    }
  });
});
