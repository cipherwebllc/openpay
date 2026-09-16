// CCTP V2 Fast Transfer adapter — pre-deposit 不要、per-tx burn-and-mint。
// Gateway (pre-deposit 必須、<500ms) と対比される walk-in 向け path。
//
// Flow: source chain で approve + depositForBurn → iris-api polling →
//       destination chain で receiveMessage。
//
// minFinalityThreshold = 1000 (CONFIRMED) で Fast Transfer (~8-20 秒)、
// 2000 (FINALIZED) で V1 互換の Standard (~13-19 分)。default は Fast。

import {
  decodeEventLog,
  size,
  slice,
  type PublicClient,
  encodeFunctionData,
  getAddress,
  pad,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem';
import { isMainnet } from '../env';
import type { CircleDomain, FetchLike } from './types';

// 全 EVM chain で同一 deterministic address (Circle docs 確認済)。
export const CCTP_V2_TOKEN_MESSENGER_MAINNET: Address =
  '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_V2_MESSAGE_TRANSMITTER_MAINNET: Address =
  '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
export const CCTP_V2_TOKEN_MESSENGER_TESTNET: Address =
  '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
export const CCTP_V2_MESSAGE_TRANSMITTER_TESTNET: Address =
  '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';

export const CCTP_V2_TOKEN_MESSENGER_ADDRESS: Address = isMainnet
  ? CCTP_V2_TOKEN_MESSENGER_MAINNET
  : CCTP_V2_TOKEN_MESSENGER_TESTNET;
export const CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS: Address = isMainnet
  ? CCTP_V2_MESSAGE_TRANSMITTER_MAINNET
  : CCTP_V2_MESSAGE_TRANSMITTER_TESTNET;

// env override: NEXT_PUBLIC_CIRCLE_IRIS_API_URL
export const CCTP_IRIS_API_MAINNET = 'https://iris-api.circle.com';
export const CCTP_IRIS_API_TESTNET = 'https://iris-api-sandbox.circle.com';

const irisOverride = (
  process.env.NEXT_PUBLIC_CIRCLE_IRIS_API_URL ?? ''
).trim();
if (irisOverride.length > 0 && !irisOverride.includes('://')) {
  throw new Error(
    `NEXT_PUBLIC_CIRCLE_IRIS_API_URL must be a fully-qualified URL ` +
      `(got: "${irisOverride}")`,
  );
}

export const CCTP_IRIS_API_BASE_URL: string =
  irisOverride.length > 0
    ? irisOverride
    : isMainnet
      ? CCTP_IRIS_API_MAINNET
      : CCTP_IRIS_API_TESTNET;

// FinalityThresholds.sol: 500=min allowed / 1000=CONFIRMED (Fast) / 2000=FINALIZED.
export const CCTP_FINALITY_FAST = 1000;
export const CCTP_FINALITY_STANDARD = 2000;

// Gateway と同様の 10 bps cap (Circle 公開 fee rate は変動するため buyer 視点の
// max 保護として渡す)。
const DEFAULT_CCTP_MAX_FEE_BPS = 10n;
const MIN_CCTP_MAX_FEE_ATOMIC = 1000n;

export const CCTP_V2_TOKEN_MESSENGER_ABI = [
  {
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    name: 'depositForBurn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const CCTP_V2_MESSAGE_TRANSMITTER_ABI = [
  {
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    name: 'receiveMessage',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// TokenMessengerV2.depositForBurn が出す event。中断再開時に「burn を broadcast したか」を
// on-chain の事実で確かめるための唯一の手掛かり (lib/crossChain/burnMarker.ts の log 走査)。
// indexed は burnToken / depositor / minFinalityThreshold の 3 本なので、getLogs の
// args でこの 3 本まで絞り込める (残りは data を decode して照合する)。
// ⚠ CCTP v1 の同名 event は先頭に `uint64 indexed nonce` を持つ別物 (topic0 が異なる)。
// v1 の topic0 を誤って使うと「log 無し = 未 broadcast」と誤判定して二重 burn になるため、
// tests/lib/crossChain/cctp.test.ts が Base mainnet の実ログ fixture で topic0 を pin する。
export const CCTP_V2_DEPOSIT_FOR_BURN_EVENT = parseAbiItem(
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
);

// keccak256("DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)")
export const CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0: Hex =
  '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5';

// 1 tx で複数 message を burn しうるため messages は array (Circle iris OpenAPI 由来)。
export interface CctpIrisMessage {
  status: 'complete' | 'pending_confirmations' | string;
  message?: Hex;
  attestation?: Hex;
  eventNonce?: string;
}

export interface CctpIrisResponse {
  messages: CctpIrisMessage[];
}

export interface BuildDepositForBurnArgs {
  value: bigint;
  destinationDomain: CircleDomain;
  recipient: Address;
  burnToken: Address;
  overrides?: BuildDepositForBurnOverrides;
}

export interface BuildDepositForBurnOverrides {
  maxFee?: bigint;
  maxFeeBps?: bigint;
  minFinalityThreshold?: number;
  destinationCaller?: Hex;
}

const PERMISSIONLESS_DESTINATION_CALLER: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// gateway.ts と同じ実装を循環 import 回避のため module 内で再定義。
function addressToBytes32(addr: Address): Hex {
  return pad(getAddress(addr), { size: 32 });
}

function computeCctpMaxFee(
  value: bigint,
  ov: BuildDepositForBurnOverrides,
): bigint {
  if (ov.maxFee !== undefined) return ov.maxFee;
  const bps = ov.maxFeeBps ?? DEFAULT_CCTP_MAX_FEE_BPS;
  const computed = (value * bps) / 10000n;
  return computed < MIN_CCTP_MAX_FEE_ATOMIC
    ? MIN_CCTP_MAX_FEE_ATOMIC
    : computed;
}

// 会計ログ用の bridge fee **上限** 見積 (実 charge ではない・実 fee ≤ これ)。calldata と
// 同じ既定 (overrides 無し) で算出し、ログ値が calldata と drift しないようにする。記録は
// reported/unreconciled 扱い、実 charge は mint receipt 照合 (B-3) で確定する。
export function estimateCctpMaxFee(value: bigint): bigint {
  return computeCctpMaxFee(value, {});
}

// 事前に erc20.approve(TOKEN_MESSENGER_ADDRESS, value) が必要。
export function encodeDepositForBurnCalldata(
  args: BuildDepositForBurnArgs,
): Hex {
  const ov = args.overrides ?? {};
  const maxFee = computeCctpMaxFee(args.value, ov);
  const minFinalityThreshold = ov.minFinalityThreshold ?? CCTP_FINALITY_FAST;
  const destinationCaller =
    ov.destinationCaller ?? PERMISSIONLESS_DESTINATION_CALLER;
  const mintRecipient = addressToBytes32(args.recipient);

  return encodeFunctionData({
    abi: CCTP_V2_TOKEN_MESSENGER_ABI,
    functionName: 'depositForBurn',
    args: [
      args.value,
      args.destinationDomain,
      mintRecipient,
      getAddress(args.burnToken),
      destinationCaller,
      maxFee,
      minFinalityThreshold,
    ],
  });
}

export function encodeReceiveMessageCalldata(
  message: Hex,
  attestation: Hex,
): Hex {
  return encodeFunctionData({
    abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI,
    functionName: 'receiveMessage',
    args: [message, attestation],
  });
}

// 単発 fetch (通常は pollIrisAttestation を使う)。
export async function fetchIrisAttestation(
  sourceDomain: CircleDomain,
  sourceTxHash: Hex,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<CctpIrisResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CCTP_IRIS_API_BASE_URL;
  const url = `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`;
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `iris API GET /v2/messages HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as CctpIrisResponse;
}

export interface PollIrisAttestationOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** default 2000 (poll interval ms) */
  intervalMs?: number;
  /** default 90000 (Fast Transfer L2 typical 8-20s に対する余裕) */
  timeoutMs?: number;
  /** test 用 (default setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** test 用 (default Date.now) */
  now?: () => number;
}

// "complete" status の最初の message を返す (single-recipient transfer 想定)。
// timeout 超過時は throw (caller の UI で再試行 or standard fallback 提示)。
export async function pollIrisAttestation(
  sourceDomain: CircleDomain,
  sourceTxHash: Hex,
  opts: PollIrisAttestationOptions = {},
): Promise<CctpIrisMessage> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 90_000;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const startTime = now();

  while (true) {
    const response = await fetchIrisAttestation(sourceDomain, sourceTxHash, {
      fetch: opts.fetch,
      baseUrl: opts.baseUrl,
    });
    const ready = response.messages.find(
      (m) => m.status === 'complete' && m.message && m.attestation,
    );
    if (ready) return ready;

    if (now() - startTime > timeout) {
      throw new Error(
        `iris attestation polling timeout (${timeout}ms) for tx ${sourceTxHash} on domain ${sourceDomain}`,
      );
    }
    await sleep(interval);
  }
}

// Forwarding は opt-in。既存 depositForBurn の ABI / fee 計算は変更しない。
export const CCTP_FORWARD_HOOK_DATA: Hex =
  '0x636374702d666f72776172640000000000000000000000000000000000000000';
export const CCTP_FORWARD_ABI = [parseAbiItem(
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
)] as const;
export function encodeForwardDepositForBurnCalldata(
  args: Omit<BuildDepositForBurnArgs, 'overrides'> & { maxFee: bigint },
): Hex {
  return encodeFunctionData({ abi: CCTP_FORWARD_ABI, functionName: 'depositForBurnWithHook', args: [
    args.value + args.maxFee, args.destinationDomain, addressToBytes32(args.recipient),
    args.burnToken, PERMISSIONLESS_DESTINATION_CALLER, args.maxFee, CCTP_FINALITY_FAST,
    CCTP_FORWARD_HOOK_DATA,
  ] });
}

export interface CctpBurnFee {
  finalityThreshold: number;
  minimumFee: number;
  forwardFee: { low: number; med: number; high: number };
}
/** JSON-safe、支払いと経路を含めて固定する。API 応答を実行認可に流用しない。 */
export interface AcceptedQuote {
  readonly sourceDomain: CircleDomain;
  readonly destDomain: CircleDomain;
  readonly sourceChainId: number;
  readonly destChainId: number;
  readonly recipient: Address;
  readonly valueAtomic: string;
  readonly minimumFeeBpsX1000: number;
  readonly forwardFeeAtomic: string;
  readonly maxFeeAtomic: string;
  readonly grossAtomic: string;
  readonly quotedAt: number;
  readonly expiresAt: number;
}
export async function fetchCctpBurnFees(
  src: CircleDomain, dst: CircleDomain,
  opts: { forward: true; fetch?: FetchLike; baseUrl?: string },
): Promise<CctpBurnFee> {
  const res = await (opts.fetch ?? fetch)(`${opts.baseUrl ?? CCTP_IRIS_API_BASE_URL}/v2/burn/USDC/fees/${src}/${dst}?forward=true`, { method: 'GET', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Circle fees HTTP ${res.status}`);
  const rows = await res.json() as CctpBurnFee[];
  const fee = rows.find((r) => r.finalityThreshold === CCTP_FINALITY_FAST);
  // 壊れた見積が過少承認・過大 burn に波及しないよう、fallback を作らず停止する。
  if (!fee || !Number.isFinite(fee.minimumFee) || fee.minimumFee < 0 ||
      !Number.isSafeInteger(fee.forwardFee?.high) || fee.forwardFee.high < 0) {
    throw new Error('Invalid Circle forwarding quote');
  }
  return fee;
}
export function computeForwardMaxFee(amount: bigint, quote: CctpBurnFee): bigint {
  const bps = Math.round(quote.minimumFee * 1000);
  if (amount < 0n || !Number.isSafeInteger(bps) || bps < 0 ||
      !Number.isSafeInteger(quote.forwardFee.high) || quote.forwardFee.high < 0) throw new Error('Invalid fee inputs');
  return BigInt(quote.forwardFee.high) + (amount * BigInt(bps) + 9_999_999n) / 10_000_000n;
}
export function acceptForwardQuote(
  binding: Pick<AcceptedQuote, 'sourceDomain' | 'destDomain' | 'sourceChainId' | 'destChainId' | 'recipient' | 'valueAtomic'>,
  fee: CctpBurnFee, now = Date.now(),
): AcceptedQuote {
  const maxFee = computeForwardMaxFee(BigInt(binding.valueAtomic), fee);
  return Object.freeze({ sourceChainId: binding.sourceChainId, destChainId: binding.destChainId,
    sourceDomain: binding.sourceDomain, destDomain: binding.destDomain, recipient: binding.recipient,
    valueAtomic: binding.valueAtomic, minimumFeeBpsX1000: Math.round(fee.minimumFee * 1000),
    forwardFeeAtomic: String(fee.forwardFee.high), maxFeeAtomic: String(maxFee),
    grossAtomic: String(BigInt(binding.valueAtomic) + maxFee), quotedAt: now, expiresAt: now + 300_000 });
}

export interface CctpForwardMessage extends CctpIrisMessage {
  forwardTxHash?: Hex;
  destinationMintTxHash?: Hex;
  forwardState?: string;
  delayReason?: string | null;
  decodedMessage?: { nonce?: Hex; sourceDomain?: string; destinationDomain?: string };
}
/** 一回の Iris 観測。継続/timeout は executor が永続状態とともに管理する。 */
export async function pollIrisForward(sourceDomain: CircleDomain, hash: Hex,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<CctpForwardMessage | undefined> {
  // Iris の接続停止を回復 poll 全体へ波及させない。既存 attestation 経路は変更しない。
  const fetchImpl = opts.fetch ?? fetch;
  const response = await fetchIrisAttestation(sourceDomain, hash, { ...opts,
    fetch: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  // 当経路は burn 1 本。複数 message の曖昧な nonce を決済へ持ち込まない。
  if (response.messages.length !== 1) return undefined;
  const message = response.messages[0] as CctpForwardMessage;
  return { ...message, forwardTxHash: message.forwardTxHash ?? message.destinationMintTxHash };
}

export const CCTP_MESSAGE_RECEIVED_EVENT = parseAbiItem(
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
);
export const CCTP_MINT_AND_WITHDRAW_EVENT = parseAbiItem(
  'event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)',
);
export const CCTP_MESSAGE_RECEIVED_TOPIC0 = '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c';
export const CCTP_MINT_AND_WITHDRAW_TOPIC0 = '0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63';
export const ARC_USDC_ADDRESS: Address = '0x3600000000000000000000000000000000000000';

export function decodeBurnMessageBody(body: Hex) {
  if (size(body) < 228) throw new Error('Truncated BurnMessageV2');
  return {
    version: Number(BigInt(slice(body, 0, 4))),
    burnToken: slice(body, 4, 36), mintRecipient: slice(body, 36, 68),
    amount: BigInt(slice(body, 68, 100)), messageSender: slice(body, 100, 132),
    maxFee: BigInt(slice(body, 132, 164)), feeExecuted: BigInt(slice(body, 164, 196)),
    expirationBlock: BigInt(slice(body, 196, 228)), hookData: size(body) === 228 ? '0x' as Hex : slice(body, 228),
  };
}

/** bounded scan、カーソルは成功した窓のみ進める。RPC 障害を「mint なし」にしない。 */
export async function findForwardMintByNonce(destClient: PublicClient, args: {
  nonce: Hex; sourceDomain: CircleDomain; fromBlock: bigint;
}): Promise<{ hashes: Hex[]; nextBlock: bigint; scannedToBlock: bigint }> {
  const head = await destClient.getBlockNumber();
  if (args.fromBlock > head) return { hashes: [], nextBlock: args.fromBlock, scannedToBlock: head };
  let span = 2000n;
  while (true) {
    const end = args.fromBlock + span - 1n < head ? args.fromBlock + span - 1n : head;
    try {
      const logs = await destClient.getLogs({ address: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
        event: CCTP_MESSAGE_RECEIVED_EVENT, args: { nonce: args.nonce },
        fromBlock: args.fromBlock, toBlock: end, strict: true });
      return { hashes: [...new Set(logs.filter((l) => !l.removed && l.args.sourceDomain === args.sourceDomain)
        .map((l) => l.transactionHash).filter((h): h is Hex => !!h))],
      // 12-block overlap prevents short reorgs from skipping a later canonical mint.
      scannedToBlock: end,
      nextBlock: end === head ? (head > 12n ? head - 12n : 0n) : end + 1n };
    } catch (error) {
      // provider の range/rate 制限を回復全体の失敗へ波及させない。有界に縮めて再試行。
      if (span <= 100n) throw error;
      span = span / 2n < 100n ? 100n : span / 2n;
    }
  }
}

export interface VerifyForwardMintArgs {
  destClient: PublicClient; txHash: Hex; sourceDomain: CircleDomain; nonce: Hex;
  mintRecipient: Address; mintToken: Address; minAmount: bigint;
  burnToken: Address; grossAmount: bigint; maxFee: bigint;
  messageSender?: Address;
}
export type ForwardMintVerification =
  | { ok: true; verifiedNetAtomic: bigint; feeCollectedAtomic: bigint; blockNumber: bigint }
  | { ok: false; reason: string };
export async function verifyForwardMint(args: VerifyForwardMintArgs): Promise<ForwardMintVerification> {
  let receipt;
  try {
    receipt = await args.destClient.getTransactionReceipt({ hash: args.txHash });
  } catch (error) {
    // 未 mine/replaced 候補が nonce 探索を永久に遮断する波及を断つ。RPC 障害は区別する。
    if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return { ok: false, reason: 'not-found' };
    throw error;
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'reverted' };
  const logs = [...receipt.logs].sort((a, b) => a.logIndex - b.logIndex);
  let previousMessageIndex = -1;
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.address.toLowerCase() !== CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS.toLowerCase() ||
        log.topics[0] !== CCTP_MESSAGE_RECEIVED_TOPIC0) continue;
    const start = previousMessageIndex + 1;
    previousMessageIndex = i;
    try {
      const { args: message } = decodeEventLog({ abi: [CCTP_MESSAGE_RECEIVED_EVENT], ...log });
      if (message.nonce.toLowerCase() !== args.nonce.toLowerCase() || message.sourceDomain !== args.sourceDomain) continue;
      const body = decodeBurnMessageBody(message.messageBody);
      if (message.sender.toLowerCase() !== addressToBytes32(CCTP_V2_TOKEN_MESSENGER_ADDRESS).toLowerCase() ||
          body.version !== 1 || body.burnToken.toLowerCase() !== addressToBytes32(args.burnToken).toLowerCase() ||
          body.mintRecipient.toLowerCase() !== addressToBytes32(args.mintRecipient).toLowerCase() ||
          body.amount !== args.grossAmount || body.maxFee !== args.maxFee ||
          body.feeExecuted > args.maxFee || body.hookData !== CCTP_FORWARD_HOOK_DATA ||
          (args.messageSender && body.messageSender.toLowerCase() !== addressToBytes32(args.messageSender).toLowerCase())) {
        return { ok: false, reason: 'message-mismatch' };
      }
      const net = body.amount - body.feeExecuted;
      if (net < args.minAmount || args.mintToken.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) return { ok: false, reason: 'amount-or-token' };
      // CCTP は mint を emit してから MessageReceived を emit する。前の配送境界を越えて
      // 別 message の mint を借用する偽成功を防ぐ (実 receipt の log 順序で pin)。
      const mints = logs.slice(start, i).filter((l) => l.address.toLowerCase() === CCTP_V2_TOKEN_MESSENGER_ADDRESS.toLowerCase() && l.topics[0] === CCTP_MINT_AND_WITHDRAW_TOPIC0);
      if (mints.length !== 1) return { ok: false, reason: 'mint-binding' };
      const { args: mint } = decodeEventLog({ abi: [CCTP_MINT_AND_WITHDRAW_EVENT], ...mints[0] });
      if (mint.mintRecipient.toLowerCase() !== args.mintRecipient.toLowerCase() ||
          mint.mintToken.toLowerCase() !== args.mintToken.toLowerCase() || mint.amount !== net || mint.feeCollected !== body.feeExecuted) return { ok: false, reason: 'mint-mismatch' };
      return { ok: true, verifiedNetAtomic: net, feeCollectedAtomic: mint.feeCollected, blockNumber: receipt.blockNumber };
    } catch {
      // malformed log を決済成功へ伝播しない。RPC 障害は上の receipt read から伝播する。
      return { ok: false, reason: 'malformed-message' };
    }
  }
  return { ok: false, reason: 'message-not-found' };
}
