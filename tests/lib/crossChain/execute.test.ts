import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  pad,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import { logger } from '@/lib/logger';
import { CCTP_V2_TOKEN_MESSENGER_ABI } from '@/lib/crossChain/cctp';
import {
  CrossChainBurnUnresolvedError,
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
  CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0,
  CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
} from '@/lib/crossChain/cctp';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';

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
  __resetContractDeployedCacheForTest();
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
    // assertContractDeployed (CCTP/Gateway 存在確認) 用。default は deploy 済扱い。
    getCode: vi.fn(async () => '0x60016000' as Hex),
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
      commitBurnIntent: () => {},
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
        commitBurnIntent: () => {},
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
      commitBurnIntent: () => {},
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
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
        commitBurnIntent: () => {},
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
        commitBurnIntent: () => {},
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
        commitBurnIntent: () => {},
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
      commitBurnIntent: () => {},
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
        commitBurnIntent: () => {},
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
      commitBurnIntent: () => {},
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
      commitBurnIntent: () => {},
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
      commitBurnIntent: () => {},
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
        commitBurnIntent: () => {},
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

  it('CCTP resume-landed + fee mint 失敗: merchant callback は fee mint より前に発火 (ordering guard)', async () => {
    // merchant mint は landed 済 (resume.mintTxHash 在り)、fee mint 未了。fee mint の
    // sendTransaction を hash 切れで throw させ、merchant callback が fee mint より「前」に
    // 発火していることを fence する (callback を fee mint の後ろに動かすとこの test は落ちる)。
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: [], // 最初の sendTransaction (= fee mint) で throw
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
        commitBurnIntent: () => {},
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
      }),
    ).rejects.toThrow();

    expect(merchantMints).toEqual([
      { mintTxHash: '0xmint_m_prev', burnTxHash: '0xburn_m_prev' },
    ]);
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
      commitBurnIntent: () => {},
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
    };
    const destPublic = makePublicClient();
    const mockFetch = vi.fn();

    await expect(
      executeCctpTransfer({
        commitBurnIntent: () => {},
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
    };
    const destPublic = makePublicClient();
    const steps: Array<Record<string, unknown>> = [];

    await expect(
      executeCctpTransfer({
        commitBurnIntent: () => {},
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
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
        commitBurnIntent: () => {},
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
      getCode: vi.fn(async () => '0x60016000' as Hex),
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
      commitBurnIntent: () => {},
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

// 2026-06-11 (REM-15 / money-path P2): txAlreadySucceeded は transport 障害を「tx 未着」と
// 誤判定しない。従来の getTransactionReceipt(...).catch(()=>null) は RPC ダウン / timeout を
// false (=未着) に潰し、landed 済 mint の再 broadcast (既消費 attestation で必ず revert) を
// 誘発していた。未発見 (TransactionReceiptNotFoundError) のみ false、それ以外は throw して
// resume 再試行に倒す (feeVerify.ts CR-2 と同じ区別)。
describe('lib/crossChain/execute: resume の receipt 障害区別 (transport vs not-found)', () => {
  // viem の TransactionReceiptNotFoundError 様 (name プロパティを持つ Error)。
  function notFoundError(): Error {
    const e = new Error('Transaction receipt with hash "0x..." could not be found.');
    e.name = 'TransactionReceiptNotFoundError';
    return e;
  }

  it('CCTP resume: getTransactionReceipt が not-found → 再 broadcast 経路 (従来挙動)', async () => {
    // 前回 broadcast した merchant mint が未 mine (not-found) → landed=false → 再 poll + 再 mint。
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_retry'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = {
      getBlockNumber: vi.fn(),
      getTransactionReceipt: vi.fn(async () => {
        throw notFoundError();
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
      getCode: vi.fn(async () => '0x60016000' as Hex),
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
      commitBurnIntent: () => {},
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

    // not-found は landed=false 扱い → 再 poll + 再 mint (従来の catch(()=>null) と同じ結果)。
    expect(destPublic.getTransactionReceipt).toHaveBeenCalledWith({ hash: '0xmint_old' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.mintTxHash).toBe('0xmint_retry');
  });

  it('CCTP resume: getTransactionReceipt が一般 Error (network) → throw・再 broadcast しない', async () => {
    // RPC 一時障害は「未着」と区別できないので false に潰さず throw。landed 済 mint の
    // 再 broadcast (= 必ず revert・失敗表示) を防ぎ、resume 再試行に倒す。
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_retry'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = {
      getBlockNumber: vi.fn(),
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('fetch failed: ECONNREFUSED'); // name は既定の "Error"
      }),
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

    await expect(
      executeCctpTransfer({
        commitBurnIntent: () => {},
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
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    // transport 障害は throw に伝播 → 再 poll / 再 mint へ進まない (再 broadcast しない)。
    expect(mockFetch).not.toHaveBeenCalled();
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });
});

// 2026-06-11 (REM-15): feeReceiver が burn address (zero / 0x...dEaD placeholder) のまま
// 走ると利用料分の USDC が永久焼失する。該当時は fee ブリッジ自体を skip (顧客が fee 分を
// 保持する安全側) し warn する。merchant 経路は通常完走。
describe('lib/crossChain/execute: feeReceiver burn-address ガード', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  for (const burnAddr of [zeroAddress, getAddress('0x000000000000000000000000000000000000dEaD')]) {
    it(`Gateway: feeReceiver=${burnAddr} → fee burn せず merchant のみ完走・warn`, async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const walletClient = makeWalletClient({
        signature: '0xsig',
        txHashes: ['0xmint_m'], // merchant mint のみ (fee mint は出ない)
      });
      const sourcePublic = makePublicClient({ blockNumber: 100n });
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
        valueAtomic: 9_900_000n,
        feeReceiver: burnAddr,
        feeAmount: 100_000n, // >0 だが burn address なので skip
        fetch: mockFetch as unknown as typeof fetch,
      });

      // sign / mint は merchant の 1 本だけ (fee 系は出ない = 焼失しない)
      expect(walletClient.signTypedData).toHaveBeenCalledTimes(1);
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
      expect(result.mintTxHash).toBe('0xmint_m');
      expect(result.feeMintTxHash).toBeUndefined();
      // warn が 1 回発火 (event 名 + feeReceiver fields)
      expect(warnSpy).toHaveBeenCalledWith('cross-chain.fee.burn-address-receiver', {
        feeReceiver: burnAddr,
      });
    });

    it(`CCTP: feeReceiver=${burnAddr} → fee burn/mint せず merchant のみ完走・warn`, async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const walletClient = makeWalletClient({
        signature: '0x',
        // approve, burn_m, mint_m のみ (fee 系 tx は出ない)
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
        commitBurnIntent: () => {},
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
        feeReceiver: burnAddr,
        feeAmount: 100_000n,
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
      });

      // approve は valueAtomic + feeAmount (guard は bridgeFee を false にするだけで feeAmount は
      // 触らない)。fee burn は出ないので余分な allowance は orphaned で無害 (既存の orphaned
      // approve 許容と同じ)。焼失するのは「fee を実際に burn/mint した時」だけなので skip で十分。
      const approveArg = walletClient.writeContract.mock.calls[0][0] as unknown as {
        args: [Address, bigint];
      };
      expect(approveArg.args[1]).toBe(10_000_000n);
      // burn 1 + mint 1 = sendTransaction 2 回 (fee 系なし → 焼失しない)
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledTimes(1); // merchant poll のみ
      expect(result.feeBurnTxHash).toBeUndefined();
      expect(result.feeMintTxHash).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith('cross-chain.fee.burn-address-receiver', {
        feeReceiver: burnAddr,
      });
    });
  }
});

// 2026-06-11 (REM-15): resume の merchant / fee attestation poll を Promise.allSettled で
// 並列化し、一方が timeout で throw しても他方の burn 済資金の mint を巻き込まないことを担保。
// fee 側は merchant の attestation 可用性に依存しない (逆も同様)。
describe('lib/crossChain/execute: CCTP resume の attestation poll 非直列化 (巻き添え解消)', () => {
  // burnHash 別に Iris レスポンスを出し分ける fetch stub。Iris URL は
  // `?transactionHash=<burnHash>` を含むので URL で判定する。`fail` 指定の hash は
  // 常に pending を返し → poll が timeout で throw する。
  function makeIrisFetch(opts: { failHashes: Hex[] }) {
    return vi.fn(async (url: string) => {
      const failing = opts.failHashes.some((h) => url.includes(`transactionHash=${h}`));
      if (failing) {
        return new Response(
          JSON.stringify({ messages: [{ status: 'pending_confirmations' }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
        }),
        { status: 200 },
      );
    });
  }

  // timeout を確実に踏むための now (呼ばれるたびに大きく進む)。
  function fastForwardNow() {
    let t = 0;
    return vi.fn(() => {
      const cur = t;
      t += 100_000;
      return cur;
    });
  }

  const RESUME_BOTH_BURNED = {
    approveTxHash: '0xapprove_prev' as Hex,
    burnTxHash: '0xburn_m_prev' as Hex,
    feeBurnTxHash: '0xburn_f_prev' as Hex,
  };

  it('(a) merchant poll reject + fee poll 成功 → fee mint を broadcast し feeMintTxHash persist 後に throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_f'], // fee mint のみ broadcast される
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    // merchant burn (0xburn_m_prev) の poll は fail、fee burn (0xburn_f_prev) は成功。
    const mockFetch = makeIrisFetch({ failHashes: ['0xburn_m_prev'] });
    const steps: Array<Record<string, unknown>> = [];

    await expect(
      executeCctpTransfer({
        commitBurnIntent: () => {},
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
        resume: RESUME_BOTH_BURNED,
        onStep: (s) => steps.push({ ...s }),
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: {
          sleep: vi.fn(async () => undefined),
          now: fastForwardNow(),
          timeoutMs: 90_000,
        },
      }),
    ).rejects.toThrow(/timeout/);

    // fee mint は broadcast され feeMintTxHash が persist された (merchant timeout の巻き添えに
    // ならず、取得できた fee 資金は着金させる)。
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1); // fee mint のみ
    expect(steps.some((s) => s.feeMintTxHash === '0xmint_f')).toBe(true);
    // merchant mint は broadcast されていない (poll が取得できなかった)。
    expect(steps.some((s) => s.mintTxHash === '0xmint_f')).toBe(false);
  });

  it('(b) fee poll reject + merchant poll 成功 → merchant mint + onMerchantMint 完了後に throw', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xmint_m'], // merchant mint のみ broadcast される
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    // fee burn (0xburn_f_prev) の poll は fail、merchant burn は成功。
    const mockFetch = makeIrisFetch({ failHashes: ['0xburn_f_prev'] });
    const merchantMints: Array<{ mintTxHash: string; burnTxHash?: string }> = [];
    const steps: Array<Record<string, unknown>> = [];

    await expect(
      executeCctpTransfer({
        commitBurnIntent: () => {},
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
        resume: RESUME_BOTH_BURNED,
        onStep: (s) => steps.push({ ...s }),
        onMerchantMint: (i) => merchantMints.push(i),
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: {
          sleep: vi.fn(async () => undefined),
          now: fastForwardNow(),
          timeoutMs: 90_000,
        },
      }),
    ).rejects.toThrow(/timeout/);

    // merchant mint は broadcast + 会計 callback 発火 (fee timeout の巻き添えにならない)。
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1); // merchant mint のみ
    expect(steps.some((s) => s.mintTxHash === '0xmint_m')).toBe(true);
    expect(merchantMints).toEqual([
      { mintTxHash: '0xmint_m', burnTxHash: '0xburn_m_prev' },
    ]);
    // fee mint は broadcast されていない。
    expect(steps.some((s) => s.feeMintTxHash === '0xmint_m')).toBe(false);
  });

  it('(c) 両 poll reject → 即 throw・mint 系 sendTransaction 不発', async () => {
    const walletClient = makeWalletClient({
      signature: '0x',
      txHashes: ['0xshould_not_be_used'],
    });
    const sourcePublic = makePublicClient();
    const destPublic = makePublicClient();
    // 両 burn とも poll fail。
    const mockFetch = makeIrisFetch({
      failHashes: ['0xburn_m_prev', '0xburn_f_prev'],
    });
    const switchChainAsync = trackSwitch();

    await expect(
      executeCctpTransfer({
        commitBurnIntent: () => {},
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
        valueAtomic: 9_900_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 100_000n,
        resume: RESUME_BOTH_BURNED,
        fetch: mockFetch as unknown as typeof fetch,
        pollOptions: {
          sleep: vi.fn(async () => undefined),
          now: fastForwardNow(),
          timeoutMs: 90_000,
        },
      }),
    ).rejects.toThrow(/timeout/);

    // どちらの attestation も取得できないので mint は 1 本も broadcast しない。
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    // 両 reject なら chain switch せず即 throw する (dest への switch は呼ばれない)。
    expect(switchChainAsync).not.toHaveBeenCalledWith({ chainId: 80002 });
  });
});

// ============================================================================
// A1: burn の再開安全化 (二重 burn / 恒久 wedge の同時封鎖)
// ============================================================================

// scanForBurnLog が受理する DepositForBurn log を実 ABI レイアウトで組み立てる。
function makeDepositForBurnLog(hash: Hex) {
  return {
    address: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    topics: [
      CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0,
      pad(SOURCE_TOKEN, { size: 32 }),
      pad(ACCOUNT, { size: 32 }),
      pad('0x03e8', { size: 32 }),
    ],
    data: encodeAbiParameters(
      [
        { name: 'amount', type: 'uint256' },
        { name: 'mintRecipient', type: 'bytes32' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'destinationTokenMessenger', type: 'bytes32' },
        { name: 'destinationCaller', type: 'bytes32' },
        { name: 'maxFee', type: 'uint256' },
        { name: 'hookData', type: 'bytes' },
      ],
      [
        9_900_000n,
        pad(RECIPIENT, { size: 32 }),
        CIRCLE_DOMAIN_POLYGON,
        pad('0x00', { size: 32 }),
        pad('0x00', { size: 32 }),
        1000n,
        '0x',
      ],
    ),
    transactionHash: hash,
    blockNumber: 1_010n,
  };
}

const IRIS_OK = () =>
  new Response(
    JSON.stringify({
      messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }],
    }),
    { status: 200 },
  );

function notFoundError(): Error {
  const e = new Error('Transaction receipt not found');
  e.name = 'TransactionReceiptNotFoundError';
  return e;
}

// marker を持つ resume state から再開する CCTP 実行の共通 fixture。
function makeA1Fixture(opts: {
  /** source chain の probe が返す既定値 (hash 個別指定が無い場合) */
  receipt?: 'success' | 'reverted' | 'notfound';
  /** hash ごとの receipt。merchant / fee の hash 取り違えを検出できるようにするため、
   *  fixture は「どの hash を問い合わせたか」で応答を変える (全 hash 同一応答だと
   *  fee の hash で merchant の判定をしていても test が通ってしまう)。 */
  receiptByHash?: Record<string, 'success' | 'reverted' | 'notfound'>;
  noncePending?: number;
  nonceLatest?: number;
  head?: bigint;
  logs?: unknown[];
  txByHash?: Record<string, { nonce: number; from: Address }>;
  txHashes?: Hex[];
}) {
  const walletClient = makeWalletClient({
    signature: '0x',
    txHashes: opts.txHashes ?? ['0xapprove', '0xburn_new', '0xmint_m'],
  });
  const receiptQueries: Hex[] = [];
  const sourcePublic = {
    getBlockNumber: vi.fn(async () => opts.head ?? 1_100n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    receiptQueries,
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      receiptQueries.push(hash);
      const explicit = opts.receiptByHash?.[hash];
      const status =
        explicit ??
        // 走査で拾った候補 tx は成功済 burn として扱う (scan の受理条件 5)
        (opts.txByHash?.[hash] ? 'success' : (opts.receipt ?? 'success'));
      if (status === 'notfound') throw notFoundError();
      return { status };
    }),
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) =>
      blockTag === 'pending' ? (opts.noncePending ?? 5) : (opts.nonceLatest ?? 5),
    ),
    getLogs: vi.fn(async () => opts.logs ?? []),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = opts.txByHash?.[hash];
      if (!tx) throw new Error(`test: no tx for ${hash}`);
      return tx;
    }),
    getCode: vi.fn(async () => '0x60016000' as Hex),
  };
  const destPublic = makePublicClient();
  return { walletClient, sourcePublic, destPublic };
}

const A1_MARKER = {
  v: 1 as const,
  chainId: 84532,
  block: '1000',
  nonceLatest: 5,
  noncePending: 5,
  at: 0,
  depositor: ACCOUNT,
  burnToken: SOURCE_TOKEN,
  mintRecipient: RECIPIENT,
  amount: '9900000',
  destinationDomain: CIRCLE_DOMAIN_POLYGON,
};

function runA1(
  fx: ReturnType<typeof makeA1Fixture>,
  over: Partial<Parameters<typeof executeCctpTransfer>[0]> = {},
) {
  return executeCctpTransfer({
    walletClient: fx.walletClient as never,
    sourcePublicClient: fx.sourcePublic as never,
    destPublicClient: fx.destPublic as never,
    switchChainAsync: trackSwitch(),
    account: ACCOUNT,
    sourceChainId: 84532,
    destChainId: 80002,
    destDomain: CIRCLE_DOMAIN_POLYGON,
    sourceDomain: CIRCLE_DOMAIN_BASE,
    sourceToken: SOURCE_TOKEN,
    recipient: RECIPIENT,
    valueAtomic: 9_900_000n,
    commitBurnIntent: () => {},
    fetch: vi.fn(async () => IRIS_OK()) as unknown as typeof fetch,
    pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
    // gap 充足 (marker.at=0 + MIN_GAP_MS 超え) を既定にする
    now: () => 200_000,
    ...over,
  });
}

describe('lib/crossChain/execute: A1 burn 再開安全化', () => {
  it('marker 書込に失敗したら burn を broadcast しない (fail-closed)', async () => {
    const fx = makeA1Fixture({});
    const boom = new Error('storage blocked');
    await expect(
      runA1(fx, {
        commitBurnIntent: () => {
          throw boom;
        },
      }),
    ).rejects.toThrow('storage blocked');
    // approve までは走るが burn (sendTransaction) は 0 回。
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(fx.walletClient.writeContract).toHaveBeenCalledTimes(1); // approve のみ
  });

  it('marker は burn broadcast の前に書かれる (順序が逆転していない)', async () => {
    const order: string[] = [];
    const fx = makeA1Fixture({});
    fx.walletClient.sendTransaction = vi.fn(async () => {
      order.push('broadcast');
      return '0xburn_new' as Hex;
    }) as never;
    const steps: Array<Record<string, unknown>> = [];
    await runA1(fx, {
      commitBurnIntent: (m, slot) => {
        order.push(`commit:${slot}`);
        expect(m.v).toBe(1);
        expect(m.amount).toBe('9900000');
        expect(m.mintRecipient).toBe(RECIPIENT);
      },
      onStep: (s) => steps.push({ ...s }),
    });
    expect(order[0]).toBe('commit:merchant');
    expect(order[1]).toBe('broadcast');
    // marker は resume state にも載る (reload 後の排他 / 再判定のため)
    expect(steps.some((s) => s.burnIntent !== undefined)).toBe(true);
  });

  it('row 5: marker あり + mempool 有り → wait で止まり burn しない', async () => {
    const fx = makeA1Fixture({ noncePending: 6, nonceLatest: 5 });
    const progress: CrossChainProgress[] = [];
    await expect(
      runA1(fx, {
        resume: { approveTxHash: '0xa', burnIntent: A1_MARKER },
        onProgress: (p) => progress.push(p),
      }),
    ).rejects.toMatchObject({
      name: 'CrossChainBurnUnresolvedError',
      kind: 'wait',
      slot: 'merchant',
      row: 5,
    });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(fx.walletClient.writeContract).not.toHaveBeenCalled();
    expect(progress.map((p) => p.kind)).toEqual(['burn_probe', 'burn_unconfirmed']);
  });

  it('row 9: cold (nonce 不変・mempool 空・log 無し・gap 充足) は flag ON で 1 回だけ burn', async () => {
    const fx = makeA1Fixture({});
    const result = await runA1(fx, {
      resume: { approveTxHash: '0xa', burnIntent: A1_MARKER },
      allowAutoReburn: true,
    });
    // approve 1 + burn 1 + mint 1
    expect(fx.walletClient.writeContract).toHaveBeenCalledTimes(1);
    const burnCalls = fx.walletClient.sendTransaction.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    );
    expect(burnCalls).toHaveLength(1);
    expect(result.burnTxHash).toBe('0xburn_new');
  });

  it('row 9: flag OFF (既定) では再 burn せず manual に落ちる', async () => {
    const fx = makeA1Fixture({});
    await expect(
      runA1(fx, {
        resume: { approveTxHash: '0xa', burnIntent: A1_MARKER },
        allowAutoReburn: false,
      }),
    ).rejects.toMatchObject({ kind: 'manual', row: 9, reburnable: true });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('row 9: flag OFF + 二段確認 (allowManualReburn) なら burn する', async () => {
    const fx = makeA1Fixture({});
    const result = await runA1(fx, {
      resume: { approveTxHash: '0xa', burnIntent: A1_MARKER },
      allowAutoReburn: false,
      allowManualReburn: true,
    });
    expect(result.burnTxHash).toBe('0xburn_new');
  });

  it('row 10: gap 未充足 → wait (broadcast 直後の可能性)', async () => {
    const fx = makeA1Fixture({});
    await expect(
      runA1(fx, {
        resume: { approveTxHash: '0xa', burnIntent: A1_MARKER },
        allowAutoReburn: true,
        now: () => 1_000, // marker.at=0 から 1 秒しか経っていない
      }),
    ).rejects.toMatchObject({ kind: 'wait', row: 10 });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('row 12: hash が revert・log 無し・mempool 空 → flag ON で再 burn して mint まで完走', async () => {
    const fx = makeA1Fixture({
      receipt: 'reverted',
      txHashes: ['0xapprove', '0xburn_new', '0xmint_m'],
    });
    const result = await runA1(fx, {
      resume: {
        approveTxHash: '0xa',
        burnTxHash: '0xburn_reverted',
        burnIntent: A1_MARKER,
      },
      allowAutoReburn: true,
    });
    expect(result.burnTxHash).toBe('0xburn_new');
    expect(result.mintTxHash).toBe('0xmint_m');
  });

  it('row 12: flag OFF なら revert でも自動再 burn しない (manual)', async () => {
    const fx = makeA1Fixture({ receipt: 'reverted' });
    await expect(
      runA1(fx, {
        resume: {
          approveTxHash: '0xa',
          burnTxHash: '0xburn_reverted',
          burnIntent: A1_MARKER,
        },
        allowAutoReburn: false,
      }),
    ).rejects.toMatchObject({ kind: 'manual', row: 12 });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('row 13: revert 済でも一致 log 1 件なら再 burn せず adopt した hash で Iris poll', async () => {
    const adopted = '0xburn_adopted' as Hex;
    const mockFetch = vi.fn(async (_url: string) => IRIS_OK());
    const fx = makeA1Fixture({
      receipt: 'reverted',
      logs: [makeDepositForBurnLog(adopted)],
      txByHash: { [adopted]: { nonce: 5, from: ACCOUNT } },
      txHashes: ['0xmint_m'], // burn は起きないので mint だけ
    });
    const result = await runA1(fx, {
      resume: {
        approveTxHash: '0xa',
        burnTxHash: '0xburn_reverted',
        burnIntent: A1_MARKER,
      },
      allowAutoReburn: true,
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(result.burnTxHash).toBe(adopted);
    // approve も burn も行われない
    expect(fx.walletClient.writeContract).not.toHaveBeenCalled();
    // Iris は adopt した hash で引く
    expect(String(mockFetch.mock.calls[0][0])).toContain(adopted);
  });

  it('row 17: hash が notfound + mempool 有り → wait (再 burn 無し)', async () => {
    const fx = makeA1Fixture({ receipt: 'notfound', noncePending: 6, nonceLatest: 5 });
    await expect(
      runA1(fx, {
        resume: {
          approveTxHash: '0xa',
          burnTxHash: '0xburn_pending',
          burnIntent: A1_MARKER,
        },
        allowAutoReburn: true,
      }),
    ).rejects.toMatchObject({ kind: 'wait', row: 17 });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('row 20: 走査範囲 cap 超過 → manual (Iris timeout ではなく Unresolved 型)', async () => {
    const fx = makeA1Fixture({ receipt: 'notfound', head: 1_000_000n });
    const err = await runA1(fx, {
      resume: {
        approveTxHash: '0xa',
        burnTxHash: '0xburn_old',
        burnIntent: A1_MARKER,
      },
      allowAutoReburn: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CrossChainBurnUnresolvedError);
    expect(err).toMatchObject({ kind: 'manual', row: 20 });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(fx.sourcePublic.getLogs).not.toHaveBeenCalled();
  });

  it('row 21: probe 中の transport 障害は throw する (未 burn に潰さない)', async () => {
    const fx = makeA1Fixture({});
    fx.sourcePublic.getTransactionCount = vi.fn(async () => {
      throw new Error('RPC 503');
    }) as never;
    await expect(
      runA1(fx, {
        resume: { approveTxHash: '0xa', burnIntent: A1_MARKER },
        allowAutoReburn: true,
      }),
    ).rejects.toThrow('RPC 503');
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('fee burn も merchant と同じ決定表で判定される (fee slot だけ wait → 再 burn せず記録)', async () => {
    // 判定そのものは merchant と対称 (mempool 有り = row 5 の wait) だが、fee は付帯なので
    // 本送金を止めない (D3)。fee burn は broadcast されず、未確定として記録されるだけ。
    const feeMarker = {
      ...A1_MARKER,
      mintRecipient: FEE_RECEIVER,
      amount: '100000',
      nonceLatest: 6,
    };
    const fx = makeA1Fixture({
      receiptByHash: { '0xburn_m': 'success' },
      noncePending: 8,
      nonceLatest: 7,
      txHashes: ['0xmint_m'],
    });
    const result = await runA1(fx, {
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      resume: {
        approveTxHash: '0xa',
        burnTxHash: '0xburn_m',
        feeBurnIntent: feeMarker,
      },
      allowAutoReburn: true,
    });
    expect(result.feeBurnUnresolved).toMatchObject({ kind: 'wait', row: 5 });
    expect(result.feeBurnTxHash).toBeUndefined();
    expect(result.feeMintTxHash).toBeUndefined();
    // 送信は merchant mint の 1 本だけ (fee burn も approve も無い)
    expect(fx.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(fx.walletClient.writeContract).not.toHaveBeenCalled();
    expect(result.mintTxHash).toBe('0xmint_m');
  });

  it('fee burn も marker を書いてから broadcast する (merchant と完全対称)', async () => {
    const order: string[] = [];
    const fx = makeA1Fixture({
      txHashes: ['0xapprove', '0xburn_m', '0xburn_f', '0xmint_m', '0xmint_f'],
    });
    await runA1(fx, {
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      commitBurnIntent: (m, slot) => {
        order.push(`${slot}:${m.amount}:${m.mintRecipient}`);
      },
    });
    expect(order).toEqual([
      `merchant:9900000:${RECIPIENT}`,
      `fee:100000:${FEE_RECEIVER}`,
    ]);
  });

  it('後方互換 (row 2): marker 無し + burn 済 hash の旧 state は従来どおり mint に進む', async () => {
    const fx = makeA1Fixture({ receipt: 'success', txHashes: ['0xmint_m'] });
    const result = await runA1(fx, {
      resume: { approveTxHash: '0xapprove_prev', burnTxHash: '0xburn_prev' },
    });
    expect(result.burnTxHash).toBe('0xburn_prev');
    expect(result.mintTxHash).toBe('0xmint_m');
    // 旧 state では nonce / log 走査を一切行わない (RPC を増やさない)
    expect(fx.sourcePublic.getTransactionCount).not.toHaveBeenCalled();
    expect(fx.sourcePublic.getLogs).not.toHaveBeenCalled();
  });

  it('後方互換 (row 3): marker 無し + revert した hash は manual (勝手に再 burn しない)', async () => {
    const fx = makeA1Fixture({ receipt: 'reverted' });
    await expect(
      runA1(fx, {
        resume: { approveTxHash: '0xa', burnTxHash: '0xburn_prev' },
        allowAutoReburn: true,
      }),
    ).rejects.toMatchObject({ kind: 'manual', row: 3 });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('後方互換 (row 3): 二段確認済みでも mempool に tx が居るなら再 burn しない (D1)', async () => {
    // 旧 state (marker 無し) は決定表上 pendingAhead 判定より前に manual を返す。
    // 「二段確認さえ通れば burn」だと、mempool に burn が残っているのに再送金して
    // 二重支払いになる。legacy 経路でも nonce を実測して塞ぐ。
    const fx = makeA1Fixture({
      receiptByHash: { '0xburn_prev': 'reverted' },
      noncePending: 6,
      nonceLatest: 5,
    });
    const err = await runA1(fx, {
      resume: { approveTxHash: '0xa', burnTxHash: '0xburn_prev' },
      allowAutoReburn: true,
      allowManualReburn: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CrossChainBurnUnresolvedError);
    expect(err).toMatchObject({ kind: 'manual', row: 3, reburnable: false });
    expect(fx.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(fx.walletClient.writeContract).not.toHaveBeenCalled();
    // legacy 経路でも pending/latest nonce を実測している (未計測のまま開けない)
    expect(fx.sourcePublic.getTransactionCount).toHaveBeenCalledTimes(2);
  });

  it('D3: fee slot が未確定でも merchant の mint は進む (fee は二次通知として記録)', async () => {
    // merchant burn は成功済 (proceed)、fee burn hash は revert (flag OFF → manual)。
    // 付帯である利用料が本送金を人質に取らないこと = 掟 13。
    const fx = makeA1Fixture({
      receiptByHash: { '0xburn_m': 'success', '0xburn_f': 'reverted' },
      txHashes: ['0xmint_m'],
    });
    const steps: Array<Record<string, unknown>> = [];
    const progress: CrossChainProgress[] = [];
    const result = await runA1(fx, {
      feeReceiver: FEE_RECEIVER,
      feeAmount: 100_000n,
      resume: {
        approveTxHash: '0xa',
        burnTxHash: '0xburn_m',
        burnIntent: A1_MARKER,
        feeBurnTxHash: '0xburn_f',
        feeBurnIntent: {
          ...A1_MARKER,
          mintRecipient: FEE_RECEIVER,
          amount: '100000',
          nonceLatest: 6,
        },
      },
      onStep: (s) => steps.push({ ...s }),
      onProgress: (p) => progress.push(p),
      allowAutoReburn: false,
    });
    // merchant は attestation → mint まで完走する
    expect(result.mintTxHash).toBe('0xmint_m');
    expect(result.burnTxHash).toBe('0xburn_m');
    // fee は自動で再 burn しない (送信は merchant mint の 1 本だけ)
    expect(fx.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(fx.walletClient.writeContract).not.toHaveBeenCalled();
    // fee の未確定は結果と resume state の両方に残る
    expect(result.feeBurnUnresolved).toMatchObject({ kind: 'manual', row: 12 });
    expect(steps.some((s) => s.feeBurnUnresolved !== undefined)).toBe(true);
    expect(progress.map((p) => p.kind)).toContain('fee_burn_unconfirmed');
    // merchant / fee の hash を取り違えていない (両方それぞれ問い合わせている)
    expect(fx.sourcePublic.receiptQueries).toContain('0xburn_m');
    expect(fx.sourcePublic.receiptQueries).toContain('0xburn_f');
  });

  it('初回 (marker も hash も無い) は probe の RPC を打たずに従来どおり burn する', async () => {
    const fx = makeA1Fixture({});
    const progress: CrossChainProgress[] = [];
    await runA1(fx, { onProgress: (p) => progress.push(p) });
    // log 走査は無し。nonce 読みは marker 生成 (latest/pending の 2 本) のみで、
    // probe (再開判定) 由来の追加 RPC は発生しない。
    expect(fx.sourcePublic.getLogs).not.toHaveBeenCalled();
    expect(fx.sourcePublic.getTransactionCount).toHaveBeenCalledTimes(2);
    expect(fx.sourcePublic.getTransactionReceipt).not.toHaveBeenCalled();
    expect(progress.map((p) => p.kind)).toEqual([
      'switch_chain',
      'approve',
      'source_tx_pending',
      'poll_attestation',
      'switch_chain',
      'dest_tx_pending',
    ]);
  });
});
