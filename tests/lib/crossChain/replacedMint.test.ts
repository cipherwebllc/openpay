// 第 7 回レビュー A2: CCTP の宛先 mint (receiveMessage) の receipt が「送った hash」と別 tx
// (同じ nonce の置換 = wallet の高速化 / 取消) で返ったときの扱い。
// viem の waitForTransactionReceipt は置換を見つけると置換 tx の receipt で resolve する。status だけ
// 見ると「取消 tx の成功」を mint 成功と取り違え、会計通知を撃ち、再開記録まで消してしまう。
// 置換 tx 自身の log に「この message の受信 (nonce 一致)」と「期待 recipient への期待額の mint」が
// 揃うときだけ同内容 (高速化) として実際の hash で成功し、それ以外は throw して再開記録を残す。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import * as cctp from '@/lib/crossChain/cctp';
import {
  executeCctpTransfer,
  type CctpResumeState,
} from '@/lib/crossChain/execute';
import {
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_POLYGON,
} from '@/lib/crossChain/types';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';
import destinationReceipts from '../../fixtures/cctp/arc-forwarding/arc-testnet-destination-receipts.json';
import selfMintIris from '../../fixtures/cctp/arc-forwarding/iris-messages-domain0-nonce.json';

const ACCOUNT = getAddress('0x1234567890123456789012345678901234567890');
const RECIPIENT = getAddress('0x000000000000000000000000000000000000aBcd');
const FEE_RECEIVER = getAddress('0x00000000000000000000000000000000000fee01');
const OTHER = getAddress('0x0000000000000000000000000000000000000bad');
const SOURCE_TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const DEST_TOKEN = getAddress('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582');
const VALUE = 9_900_000n;
const FEE = 100_000n;

const h = (n: number): Hex => toHex(n, { size: 32 });
const APPROVE = h(1);
const BURN_M = h(2);
const BURN_F = h(3);
const MINT_M = h(4);
const MINT_F = h(5);
const MINT_M_REPLACEMENT = h(6);
const MINT_F_REPLACEMENT = h(7);
const MINT_M_RETRY = h(8);
const NONCE_M = h(0x101);
const NONCE_F = h(0x102);

// CCTP V2 message (header 148 bytes + BurnMessageV2 body)。header の nonce は byte 12..44。
function cctpMessage(nonce: Hex, recipient: Address, amount: bigint): Hex {
  const body = concat([
    toHex(1, { size: 4 }),
    pad(SOURCE_TOKEN),
    pad(recipient),
    toHex(amount, { size: 32 }),
    pad(ACCOUNT),
    toHex(0n, { size: 32 }),
    toHex(0n, { size: 32 }),
    toHex(0n, { size: 32 }),
  ]);
  return concat([
    toHex(1, { size: 4 }),
    toHex(CIRCLE_DOMAIN_BASE, { size: 4 }),
    toHex(CIRCLE_DOMAIN_POLYGON, { size: 4 }),
    nonce,
    pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS),
    pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS),
    pad('0x00'),
    toHex(1000, { size: 4 }),
    toHex(1000, { size: 4 }),
    body,
  ]);
}
const MESSAGE_M = cctpMessage(NONCE_M, RECIPIENT, VALUE);
const MESSAGE_F = cctpMessage(NONCE_F, FEE_RECEIVER, FEE);

function messageReceivedLog(nonce: Hex, sourceDomain: number = CIRCLE_DOMAIN_BASE) {
  return {
    address: cctp.CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
    topics: encodeEventTopics({
      abi: [cctp.CCTP_MESSAGE_RECEIVED_EVENT],
      args: { caller: ACCOUNT, nonce, finalityThresholdExecuted: 1000 },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [sourceDomain, pad(cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS), '0x'],
    ),
  };
}

function mintAndWithdrawLog(recipient: Address, net: bigint, feeCollected: bigint) {
  return {
    address: cctp.CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    topics: encodeEventTopics({
      abi: [cctp.CCTP_MINT_AND_WITHDRAW_EVENT],
      args: { mintRecipient: recipient, mintToken: DEST_TOKEN },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [net, feeCollected],
    ),
  };
}

type Log = ReturnType<typeof messageReceivedLog>;
const minedReceipt = (transactionHash: Hex, logs: Log[] = []) => ({
  status: 'success' as const,
  transactionHash,
  blockNumber: 1000n,
  logs,
});

let mockChainId = 0;
beforeEach(() => {
  mockChainId = 0;
  __resetContractDeployedCacheForTest();
});
afterEach(() => vi.restoreAllMocks());

function makeWalletClient(txHashes: Hex[]) {
  let i = 0;
  const next = async () => {
    const hash = txHashes[i++];
    if (!hash) throw new Error('test: ran out of txHashes');
    return hash;
  };
  return {
    getChainId: vi.fn(async () => mockChainId),
    sendTransaction: vi.fn(next),
    writeContract: vi.fn(next),
  };
}

// 送った hash の receipt は transactionHash = 送った hash (置換なし)。置換は replacements で差し替える。
function makeDestClient(replacements: Map<Hex, ReturnType<typeof minedReceipt>>) {
  return {
    getBlockNumber: vi.fn(async () => 1000n),
    getCode: vi.fn(async () => '0x60016000' as Hex),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) =>
      replacements.get(hash) ?? minedReceipt(hash),
    ),
    // resume の landed 検証: 置換で消えた元の hash は「未発見」(viem の TransactionReceiptNotFoundError)。
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      if (replacements.has(hash)) {
        throw Object.assign(new Error(`receipt not found: ${hash}`), {
          name: 'TransactionReceiptNotFoundError',
        });
      }
      return minedReceipt(hash);
    }),
  };
}

function makeSourceClient() {
  return {
    getBlockNumber: vi.fn(async () => 1000n),
    getCode: vi.fn(async () => '0x60016000' as Hex),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => minedReceipt(hash)),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => minedReceipt(hash)),
  };
}

// burn hash ごとに対応する message を返す Iris。
const irisFetch = vi.fn(async (url: string) => {
  const message = url.includes(BURN_F) ? MESSAGE_F : MESSAGE_M;
  return new Response(
    JSON.stringify({ messages: [{ status: 'complete', message, attestation: '0xa77e' }] }),
    { status: 200 },
  );
});

function args(opts: {
  wallet: ReturnType<typeof makeWalletClient>;
  dest: ReturnType<typeof makeDestClient>;
  withFee?: boolean;
  resume?: CctpResumeState;
  onStep?: (state: CctpResumeState) => void;
  onMerchantMint?: (info: { mintTxHash?: Hex; burnTxHash?: Hex }) => void;
}) {
  return {
    commitBurnIntent: () => {},
    walletClient: opts.wallet as never,
    sourcePublicClient: makeSourceClient() as never,
    destPublicClient: opts.dest as never,
    switchChainAsync: vi.fn(async ({ chainId }: { chainId: number }) => {
      mockChainId = chainId;
    }),
    account: ACCOUNT,
    sourceChainId: 84532,
    destChainId: 80002,
    sourceDomain: CIRCLE_DOMAIN_BASE,
    destDomain: CIRCLE_DOMAIN_POLYGON,
    sourceToken: SOURCE_TOKEN,
    recipient: RECIPIENT,
    valueAtomic: VALUE,
    ...(opts.withFee ? { feeReceiver: FEE_RECEIVER, feeAmount: FEE } : {}),
    resume: opts.resume,
    onStep: opts.onStep,
    onMerchantMint: opts.onMerchantMint,
    fetch: irisFetch as unknown as typeof fetch,
    pollOptions: { sleep: vi.fn(async () => undefined), now: () => 0 },
  };
}

describe('cctpReceiptShowsMint (置換 receipt の同内容判定)', () => {
  // 実測 (Arc testnet・supervisor capture): self-mint の receiveMessage receipt と、同じ nonce の Iris message。
  const captured = destinationReceipts.receipts.find(
    (r) => r.nonce === selfMintIris.response.messages[0].eventNonce,
  )!;
  const capturedLogs = captured.logs.map((l) => ({
    address: l.address as Address,
    topics: l.topics as Hex[],
    data: l.data as Hex,
  }));
  const capturedMessage = selfMintIris.response.messages[0].message as Hex;
  const capturedBody = selfMintIris.response.messages[0].decodedMessage.decodedMessageBody;
  const expected = {
    message: capturedMessage,
    recipient: getAddress(capturedBody.mintRecipient),
    amount: BigInt(capturedBody.amount),
  };

  it('実測の self-mint receipt は、その message の mint として認める', () => {
    expect(destinationReceipts.messageTransmitterV2.toLowerCase()).toBe(
      cctp.CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS.toLowerCase(),
    );
    expect(cctp.cctpReceiptShowsMint(capturedLogs, expected)).toBe(true);
  });

  it.each([
    ['recipient 違い', { ...expected, recipient: OTHER }],
    ['金額違い', { ...expected, amount: expected.amount + 1n }],
    [
      '別の message (nonce 違い)',
      {
        ...expected,
        message: concat([
          capturedMessage.slice(0, 2 + 12 * 2) as Hex,
          h(0xdead),
          `0x${capturedMessage.slice(2 + 44 * 2)}` as Hex,
        ]),
      },
    ],
    ['header に満たない message', { ...expected, message: '0x1234' as Hex }],
  ])('%s なら認めない', (_label, exp) => {
    expect(cctp.cctpReceiptShowsMint(capturedLogs, exp)).toBe(false);
  });

  it('取消 (log なし) は認めない', () => {
    expect(cctp.cctpReceiptShowsMint([], expected)).toBe(false);
  });

  it('MessageReceived だけ・MintAndWithdraw だけでは認めない (両方そろって同内容)', () => {
    const onlyMessage = capturedLogs.filter(
      (l) => l.topics[0] === cctp.CCTP_MESSAGE_RECEIVED_TOPIC0,
    );
    const onlyMint = capturedLogs.filter(
      (l) => l.topics[0] === cctp.CCTP_MINT_AND_WITHDRAW_TOPIC0,
    );
    expect(onlyMessage).toHaveLength(1);
    expect(onlyMint).toHaveLength(1);
    expect(cctp.cctpReceiptShowsMint(onlyMessage, expected)).toBe(false);
    expect(cctp.cctpReceiptShowsMint(onlyMint, expected)).toBe(false);
  });
});

describe('executeCctpTransfer: 宛先 mint の置換 receipt (A2)', () => {
  it('merchant mint が取消に置換されたら成功にせず throw・再開記録 (mint hash) を残し、resume で再 mint できる', async () => {
    const wallet = makeWalletClient([APPROVE, BURN_M, MINT_M]);
    const dest = makeDestClient(new Map([[MINT_M, minedReceipt(MINT_M_REPLACEMENT)]]));
    let saved: CctpResumeState = {};
    const mints: Array<{ mintTxHash?: Hex; burnTxHash?: Hex }> = [];

    await expect(
      executeCctpTransfer(
        args({
          wallet,
          dest,
          onStep: (s) => {
            saved = { ...s };
          },
          onMerchantMint: (i) => mints.push(i),
        }),
      ),
    ).rejects.toThrow(/cctp mint/);

    // 会計通知を撃たない・再開記録は送った mint hash のまま残る。
    expect(mints).toEqual([]);
    expect(saved.burnTxHash).toBe(BURN_M);
    expect(saved.mintTxHash).toBe(MINT_M);

    // resume: 元の mint hash は未発見 → 再 poll + 再 mint して完走する。
    const retryWallet = makeWalletClient([MINT_M_RETRY]);
    const result = await executeCctpTransfer(
      args({
        wallet: retryWallet,
        dest,
        resume: saved,
        onStep: (s) => {
          saved = { ...s };
        },
        onMerchantMint: (i) => mints.push(i),
      }),
    );
    expect(result.mintTxHash).toBe(MINT_M_RETRY);
    expect(mints).toEqual([{ mintTxHash: MINT_M_RETRY, burnTxHash: BURN_M }]);
  });

  it.each([
    ['別 message (nonce 違い) の受信', [messageReceivedLog(h(0xbeef)), mintAndWithdrawLog(RECIPIENT, VALUE, 0n)]],
    ['別 source domain の受信', [messageReceivedLog(NONCE_M, CIRCLE_DOMAIN_POLYGON), mintAndWithdrawLog(RECIPIENT, VALUE, 0n)]],
    ['別 recipient への mint', [messageReceivedLog(NONCE_M), mintAndWithdrawLog(OTHER, VALUE, 0n)]],
    ['金額違いの mint', [messageReceivedLog(NONCE_M), mintAndWithdrawLog(RECIPIENT, VALUE - 1n, 0n)]],
  ])('merchant mint の置換が別内容 (%s) なら throw・再開記録を残す', async (_label, logs) => {
    const wallet = makeWalletClient([APPROVE, BURN_M, MINT_M]);
    const dest = makeDestClient(new Map([[MINT_M, minedReceipt(MINT_M_REPLACEMENT, logs)]]));
    let saved: CctpResumeState = {};
    const mints: unknown[] = [];
    await expect(
      executeCctpTransfer(
        args({ wallet, dest, onStep: (s) => { saved = { ...s }; }, onMerchantMint: (i) => mints.push(i) }),
      ),
    ).rejects.toThrow(/cctp mint/);
    expect(mints).toEqual([]);
    expect(saved.mintTxHash).toBe(MINT_M);
  });

  it('merchant mint の同内容置換 (高速化) は成功・再開記録/会計通知/結果の hash は実際に mine された hash', async () => {
    const wallet = makeWalletClient([APPROVE, BURN_M, MINT_M]);
    const dest = makeDestClient(
      new Map([
        [
          MINT_M,
          minedReceipt(MINT_M_REPLACEMENT, [
            // CCTP V2 は手数料を差し引いた額を mint し、手数料を feeCollected に出す。
            mintAndWithdrawLog(RECIPIENT, VALUE - 1_000n, 1_000n),
            messageReceivedLog(NONCE_M),
          ]),
        ],
      ]),
    );
    const steps: CctpResumeState[] = [];
    const mints: Array<{ mintTxHash?: Hex; burnTxHash?: Hex }> = [];
    const result = await executeCctpTransfer(
      args({ wallet, dest, onStep: (s) => steps.push({ ...s }), onMerchantMint: (i) => mints.push(i) }),
    );
    expect(result.mintTxHash).toBe(MINT_M_REPLACEMENT);
    expect(mints).toEqual([{ mintTxHash: MINT_M_REPLACEMENT, burnTxHash: BURN_M }]);
    // broadcast 直後は送った hash を保存し (中断対策・従来どおり)、確定後に実 hash へ更新する。
    expect(steps.some((s) => s.mintTxHash === MINT_M)).toBe(true);
    expect(steps.at(-1)?.mintTxHash).toBe(MINT_M_REPLACEMENT);
  });

  it('fee mint が取消に置換されたら throw (merchant mint の会計通知は済み)・fee mint の再開記録を残す', async () => {
    const wallet = makeWalletClient([APPROVE, BURN_M, BURN_F, MINT_M, MINT_F]);
    const dest = makeDestClient(new Map([[MINT_F, minedReceipt(MINT_F_REPLACEMENT)]]));
    let saved: CctpResumeState = {};
    const mints: Array<{ mintTxHash?: Hex; burnTxHash?: Hex }> = [];
    await expect(
      executeCctpTransfer(
        args({ wallet, dest, withFee: true, onStep: (s) => { saved = { ...s }; }, onMerchantMint: (i) => mints.push(i) }),
      ),
    ).rejects.toThrow(/cctp fee mint/);
    expect(mints).toEqual([{ mintTxHash: MINT_M, burnTxHash: BURN_M }]);
    expect(saved.mintTxHash).toBe(MINT_M);
    expect(saved.feeMintTxHash).toBe(MINT_F);
  });

  it('fee mint の同内容置換は成功・feeMintTxHash は実際に mine された hash', async () => {
    const wallet = makeWalletClient([APPROVE, BURN_M, BURN_F, MINT_M, MINT_F]);
    const dest = makeDestClient(
      new Map([
        [
          MINT_F,
          minedReceipt(MINT_F_REPLACEMENT, [
            mintAndWithdrawLog(FEE_RECEIVER, FEE, 0n),
            messageReceivedLog(NONCE_F),
          ]),
        ],
      ]),
    );
    const steps: CctpResumeState[] = [];
    const result = await executeCctpTransfer(
      args({ wallet, dest, withFee: true, onStep: (s) => steps.push({ ...s }) }),
    );
    expect(result.mintTxHash).toBe(MINT_M);
    expect(result.feeMintTxHash).toBe(MINT_F_REPLACEMENT);
    expect(steps.at(-1)?.feeMintTxHash).toBe(MINT_F_REPLACEMENT);
  });
});
