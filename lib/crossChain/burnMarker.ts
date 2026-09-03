// A1: CCTP burn の再開安全化 — burn-intent marker と、再開時の「burn したか」判定。
//
// 何を解いているか (2 つの事故):
//   (i)  burn() が broadcast 済なのに hash を永続化する前に reject / タブ閉じ → 再開時に
//        「burnTxHash が無い = 未 burn」と誤判定して **二重 burn (二重支払い)**。
//   (ii) hash は残ったが tx が revert / 置換された → Iris attestation が永久に出ず **恒久 wedge**。
//
// 対処: broadcast の直前に「送るつもり」(= marker) を fail-closed で永続化し、再開時は
//   nonce (pending vs latest) + gap + DepositForBurn log の有界走査 という **on-chain の事実**
//   だけで分岐する。曖昧な状態は自動で再 burn せず wait / manual (人間の二段確認) に倒す。
//
// 本 module は純粋ロジック + RPC 読み取りのみ (送金しない)。決定表そのものは
// classifyBurnState() に閉じてあり、RPC mock 無しで全行テストできる。

import { decodeEventLog, getAddress, pad, type Address, type Hex, type PublicClient } from 'viem';
import {
  CCTP_V2_DEPOSIT_FOR_BURN_EVENT,
  CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0,
} from './cctp';

export type BurnSlot = 'merchant' | 'fee';

/** burn broadcast の直前に永続化する「送るつもり」marker。resume state (JSON) に入るので
 *  bigint は 10 進文字列で持つ。 */
export interface BurnIntentMarker {
  v: 1;
  /** source chain id (走査範囲 / block time の解決に使う) */
  chainId: number;
  /** marker 書込時の head。RPC 障害で取れなければ null (= 走査範囲不明 → manual に倒す) */
  block: string | null;
  /** getTransactionCount(sender,'latest')。null は同上 */
  nonceLatest: number | null;
  /** getTransactionCount(sender,'pending')。観測値の記録用 (判定は再開時の実測を使う) */
  noncePending: number | null;
  /** marker 書込時刻 (Date.now) */
  at: number;
  depositor: Address;
  burnToken: Address;
  mintRecipient: Address;
  /** atomic 10 進 */
  amount: string;
  destinationDomain: number;
}

// ---- chain 別の時間パラメータ -------------------------------------------------

/** chain id → 平均 block time (ms)。未知 chain は既定 2s = fail-closed 側 (cap が小さくなり
 *  manual に倒れる)。数値は設計 §5 の表と同一。 */
const BLOCK_TIME_MS: Readonly<Record<number, number>> = {
  1: 12_000,
  11155111: 12_000,
  137: 2_000,
  80002: 2_000,
  8453: 2_000,
  84532: 2_000,
  43114: 2_000,
  43113: 2_000,
  10: 2_000,
  11155420: 2_000,
  130: 1_000,
  1301: 1_000,
  480: 2_000,
  4801: 2_000,
  146: 1_000,
  57054: 1_000,
  1329: 400,
  1328: 400,
  999: 1_000,
  998: 1_000,
  42161: 250,
  421614: 250,
};

export const DEFAULT_BLOCK_TIME_MS = 2_000;

export function blockTimeMs(chainId: number): number {
  return BLOCK_TIME_MS[chainId] ?? DEFAULT_BLOCK_TIME_MS;
}

/** 走査 horizon = 2 時間。これを超えて古い marker は走査せず manual (後日の手動照合で足りる。
 *  attestation は永久有効なので資金は失われない)。 */
const SCAN_HORIZON_MS = 2 * 60 * 60 * 1000;
/** getLogs の 1 回あたり最大 block 数 (縮小前の初期値)。 */
export const SCAN_CHUNK_SIZES = [2000, 1000, 500, 250, 100] as const;
/** 1 回の走査で許す getLogs 呼び出し数の上限。超えたら走査を打ち切って RANGE
 *  (= manual)。RPC コストの絶対上限を設計時に固定する。 */
export const MAX_SCAN_CALLS = 24;
/** 走査 span の絶対上限 (block)。高速 chain (Arbitrum 0.25s 等) では 2 時間 horizon が
 *  この値を超えるので、こちらで頭を押さえる (設計 §5 の "clamp" 列)。 */
export const MAX_SCAN_SPAN_BLOCKS = 24_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** head − marker.block がこれを超えたら走査せず RANGE (→ manual)。 */
export function burnScanCapBlocks(chainId: number): number {
  const byTime = Math.round(SCAN_HORIZON_MS / blockTimeMs(chainId));
  return Math.min(byTime, MAX_SCAN_SPAN_BLOCKS);
}

/** 「まだ間もない」を除外するための最小 block gap (≒60 秒相当)。 */
export function minGapBlocks(chainId: number): number {
  return clamp(Math.round(60_000 / blockTimeMs(chainId)), 3, 500);
}

/** reorg で marker.block より低い高さに再収容されるケースを拾うための遡り margin
 *  (≒2 分相当)。margin で過去の burn が範囲に入っても、受理条件の nonce 下限が弾く。 */
export function reorgMarginBlocks(chainId: number): number {
  return clamp(Math.round(120_000 / blockTimeMs(chainId)), 8, 600);
}

/** 「未 broadcast」と結論するために必要な最小経過時間。 */
export const MIN_GAP_MS = 90_000;

// ---- marker の生成 -----------------------------------------------------------

export interface BuildBurnMarkerArgs {
  client: PublicClient;
  chainId: number;
  depositor: Address;
  burnToken: Address;
  mintRecipient: Address;
  amount: bigint;
  destinationDomain: number;
  now?: () => number;
}

/** broadcast 直前に書く marker を作る。head / nonce の取得は失敗しても null で続行する
 *  — ここで throw すると「RPC が一瞬落ちた」だけで marker 無しのまま burn する (= 現行の
 *  二重 burn バグに戻る) 経路が復活するため。null は再開側で「走査範囲・同定不能」と解釈し、
 *  自動再 burn を禁止して manual に倒す (安全側)。 */
export async function buildBurnMarker(
  args: BuildBurnMarkerArgs,
): Promise<BurnIntentMarker> {
  const now = args.now ?? Date.now;
  let block: string | null = null;
  let nonceLatest: number | null = null;
  let noncePending: number | null = null;
  try {
    block = (await args.client.getBlockNumber()).toString();
  } catch {
    // RPC 障害の波及を marker 書込そのものに広げない (block=null → 再開時 manual)。
    block = null;
  }
  try {
    nonceLatest = await args.client.getTransactionCount({
      address: args.depositor,
      blockTag: 'latest',
    });
  } catch {
    nonceLatest = null;
  }
  try {
    noncePending = await args.client.getTransactionCount({
      address: args.depositor,
      blockTag: 'pending',
    });
  } catch {
    noncePending = null;
  }
  return {
    v: 1,
    chainId: args.chainId,
    block,
    nonceLatest,
    noncePending,
    at: now(),
    depositor: getAddress(args.depositor),
    burnToken: getAddress(args.burnToken),
    mintRecipient: getAddress(args.mintRecipient),
    amount: args.amount.toString(),
    destinationDomain: args.destinationDomain,
  };
}

// ---- DepositForBurn log の有界走査 -------------------------------------------

export type BurnScanResult =
  /** 走査できた: matches は「marker と完全一致し、かつ marker 以降の nonce で成功した」burn tx */
  | { status: 'ok'; matches: Hex[] }
  /** 走査範囲が chain 別 cap / call 上限を超えた。throw せず manual に倒すための signal */
  | { status: 'range' };

// provider が「範囲が広すぎる」を返したかの判定。message / code の表現は provider ごとに
// バラバラなので実測ベースの部分一致で拾う。ここで拾えなかった error は transport 障害として
// throw する (「log 無し = 未 broadcast」に潰すと二重 burn になるため、握り潰さない)。
const RANGE_ERROR_PATTERNS = [
  'block range',
  'range is too large',
  'range too large',
  'too many blocks',
  'exceed maximum block range',
  'query returned more than',
  'more than 10000 results',
  'limit exceeded',
  'response size exceeded',
  'query timeout exceeded',
  'log response size exceeded',
];

export function isRangeError(error: unknown): boolean {
  const parts: string[] = [];
  const visit = (e: unknown, depth: number): void => {
    if (depth > 4 || e === null || typeof e !== 'object') return;
    const rec = e as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const v of [rec.message, rec.details, rec.shortMessage]) {
      if (typeof v === 'string') parts.push(v.toLowerCase());
    }
    visit(rec.cause, depth + 1);
  };
  visit(error, 0);
  const text = parts.join(' | ');
  return RANGE_ERROR_PATTERNS.some((p) => text.includes(p));
}

export interface ScanForBurnLogArgs {
  client: PublicClient;
  marker: BurnIntentMarker;
  /** 現 head (呼出側が 1 回だけ取得して gap 判定と共有する) */
  head: bigint;
  /** source chain の CCTP TokenMessenger */
  tokenMessenger: Address;
}

/** marker に一致する成功済 DepositForBurn を有界に探す。
 *  受理条件 (すべて AND、設計 §5):
 *    1. address = TokenMessenger / topic0 = v2 DepositForBurn
 *    2. indexed burnToken / depositor が marker と一致
 *    3. decode した amount / destinationDomain / mintRecipient が marker と一致
 *    4. tx.nonce >= marker.nonceLatest かつ tx.from = depositor
 *       ← 過去の同額 burn を構造的に排除する要 (過去 burn は必ず nonce < marker.nonceLatest)
 *    5. receipt.status = 'success'
 *  「最古を採る」ような選択は一切しない。0 / 1 / 複数 をそのまま返し、複数は呼出側で manual。 */
export async function scanForBurnLog(
  args: ScanForBurnLogArgs,
): Promise<BurnScanResult> {
  const { marker, head } = args;
  if (marker.block === null || marker.nonceLatest === null) {
    // 走査範囲 (block) も同定条件 4 (nonce 下限) も無い → 走査しても曖昧さが残る。
    return { status: 'range' };
  }
  const markerBlock = BigInt(marker.block);
  const cap = BigInt(burnScanCapBlocks(marker.chainId));
  if (head > markerBlock && head - markerBlock > cap) return { status: 'range' };

  const margin = BigInt(reorgMarginBlocks(marker.chainId));
  const fromBlock = markerBlock > margin ? markerBlock - margin : 0n;
  const toBlock = head > fromBlock ? head : fromBlock;

  const wantAmount = BigInt(marker.amount);
  const wantRecipient = pad(getAddress(marker.mintRecipient), {
    size: 32,
  }).toLowerCase();
  const messenger = getAddress(args.tokenMessenger).toLowerCase();

  const hashes = new Set<Hex>();
  let calls = 0;
  // chunk は 2000 から始め、provider が範囲エラーを返したら 1000→500→250→100 と縮小する
  // (公開 RPC は 100 なら通る実績: lib/jpyc/live.ts)。縮小は以降の chunk にも引き継ぐ。
  let sizeIdx = 0;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    if (calls >= MAX_SCAN_CALLS) return { status: 'range' };
    const size = BigInt(SCAN_CHUNK_SIZES[sizeIdx]);
    const chunkEnd = cursor + size - 1n > toBlock ? toBlock : cursor + size - 1n;
    let logs: Array<{ topics: readonly Hex[]; data: Hex; transactionHash: Hex | null; address: Address }>;
    try {
      calls += 1;
      logs = (await args.client.getLogs({
        address: args.tokenMessenger,
        event: CCTP_V2_DEPOSIT_FOR_BURN_EVENT,
        args: {
          burnToken: getAddress(marker.burnToken),
          depositor: getAddress(marker.depositor),
        },
        fromBlock: cursor,
        toBlock: chunkEnd,
      })) as unknown as typeof logs;
    } catch (error) {
      if (!isRangeError(error)) throw error;
      if (sizeIdx + 1 >= SCAN_CHUNK_SIZES.length) return { status: 'range' };
      sizeIdx += 1;
      continue; // 同じ cursor から、より小さい chunk で再試行
    }

    for (const log of logs) {
      if (log.transactionHash === null) continue;
      if (log.address.toLowerCase() !== messenger) continue;
      if (log.topics[0]?.toLowerCase() !== CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0) continue;
      const decoded = decodeEventLog({
        abi: [CCTP_V2_DEPOSIT_FOR_BURN_EVENT],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      const a = decoded.args as unknown as {
        burnToken: Address;
        amount: bigint;
        depositor: Address;
        mintRecipient: Hex;
        destinationDomain: number;
      };
      if (a.amount !== wantAmount) continue;
      if (a.destinationDomain !== marker.destinationDomain) continue;
      if (a.mintRecipient.toLowerCase() !== wantRecipient) continue;
      if (a.burnToken.toLowerCase() !== marker.burnToken.toLowerCase()) continue;
      if (a.depositor.toLowerCase() !== marker.depositor.toLowerCase()) continue;
      hashes.add(log.transactionHash);
    }
    cursor = chunkEnd + 1n;
  }

  // 条件 4 / 5 (tx.nonce・tx.from・receipt) は候補 tx だけに対して確認する。
  const matches: Hex[] = [];
  for (const hash of hashes) {
    const tx = await args.client.getTransaction({ hash });
    if (tx.nonce < marker.nonceLatest) continue;
    if (tx.from.toLowerCase() !== marker.depositor.toLowerCase()) continue;
    const receipt = await args.client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') continue;
    matches.push(hash);
  }
  return { status: 'ok', matches };
}

// ---- 決定表 (設計 §4) --------------------------------------------------------

export type BurnReceiptState = 'success' | 'reverted' | 'notfound';

export type BurnDecision =
  /** 新規 burn / 再 burn を行う */
  | { action: 'burn'; row: number; reason: string }
  /** 走査で一意特定した hash を採用する (再 burn しない) */
  | { action: 'adopt'; row: number; reason: string; hash: Hex }
  /** 既存 hash で従来どおり Iris poll → mint */
  | { action: 'proceed'; row: number; reason: string; hash: Hex }
  /** 判断保留 (mempool 滞留など)。時間を置いて再試行 */
  | { action: 'wait'; row: number; reason: string }
  /** 自動判定不能。買い手の二段確認 (explorer で自分の USDC を確認) を経てのみ再 burn */
  | { action: 'manual'; row: number; reason: string; reburnable: boolean };

export interface ClassifyBurnStateInput {
  /** burn-intent marker (旧 state / 初回は undefined) */
  marker: BurnIntentMarker | undefined;
  /** 永続化済 burn tx hash */
  hash: Hex | undefined;
  /** hash の receipt 状態 (hash が無ければ undefined) */
  receipt: BurnReceiptState | undefined;
  /** P: getTransactionCount(pending) > getTransactionCount(latest) */
  pendingAhead: boolean;
  /** N: latest > marker.nonceLatest (marker 以降にこの送信者の tx が mined) */
  nonceAdvanced: boolean;
  /** G: head − marker.block ≥ minGapBlocks かつ now − marker.at ≥ MIN_GAP_MS */
  gapSatisfied: boolean;
  /** L: log 走査結果 (走査していなければ undefined) */
  scan: BurnScanResult | undefined;
  /** flag: row 9 / 12 / 18 の **自動** 再 burn を許すか (既定 OFF) */
  autoReburnEnabled: boolean;
  /** 買い手が manual パネルの二段確認を通したか (armManualReburn) */
  allowManualReburn: boolean;
}

// manual に落ちた状態を、買い手の二段確認 (explorer で USDC が減っていないことを確認) で
// 再 burn に開けてよいか。「一致する成功 burn が実際に見つかっている (L≥2)」場合だけは
// 開けない — 人間の申告より on-chain の事実を優先する (掟 15 と同じ思想)。
function manualDecision(row: number, reason: string, reburnable: boolean): BurnDecision {
  return { action: 'manual', row, reason, reburnable };
}

/** 設計 §4 の決定表そのもの (純粋関数)。row 21 (transport 障害) は呼出側の probe が
 *  throw して到達しないため、ここには現れない。 */
export function classifyBurnState(
  input: ClassifyBurnStateInput,
): BurnDecision {
  const { marker, hash, receipt, scan } = input;
  const matches = scan?.status === 'ok' ? scan.matches : [];

  // row 2 / 11: 既存 hash が on-chain で成功済 → 従来どおり Iris poll へ (marker の有無を問わない)。
  if (hash && receipt === 'success') {
    return { action: 'proceed', row: marker ? 11 : 2, reason: 'burn tx succeeded', hash };
  }

  // row 1: 初回 (marker も hash も無い)。
  if (!marker && !hash) {
    return { action: 'burn', row: 1, reason: 'first burn' };
  }
  // row 3: marker 導入前の旧 state で hash が revert / 未発見 → 走査範囲不明なので再 burn 不可。
  if (!marker) {
    return applyManualOverride(
      manualDecision(3, 'legacy state without burn marker', true),
      input,
    );
  }

  // row 4: 走査範囲 (marker.block) / 同定条件 (marker.nonceLatest) が欠けている。
  if (marker.block === null || marker.nonceLatest === null) {
    return applyManualOverride(
      manualDecision(4, 'marker without block/nonce baseline', true),
      input,
    );
  }
  // row 20: cap 超過 / call 上限。throw せず manual (恒久 wedge 回避)。
  if (scan?.status === 'range') {
    return applyManualOverride(
      manualDecision(20, 'scan range exceeded cap', true),
      input,
    );
  }

  // row 5 / 14 / 17: この送信者の tx が mempool に居る → 絶対に再 burn しない。
  if (input.pendingAhead) {
    if (!hash) return { action: 'wait', row: 5, reason: 'pending tx in mempool' };
    if (receipt === 'reverted') {
      return { action: 'wait', row: 14, reason: 'reverted but a pending tx exists' };
    }
    if (matches.length === 0) {
      return { action: 'wait', row: 17, reason: 'burn tx not mined yet' };
    }
  }

  // row 6 / 15: 同定不能 (別タブ等での並行 burn 疑い)。人間の申告でも開けない。
  if (matches.length >= 2) {
    return manualDecision(hash ? 15 : 6, 'multiple matching burns', false);
  }
  // row 7 / 13 / 16: 一意特定 → 採用 (再 burn しない)。
  if (matches.length === 1) {
    const row = !hash ? 7 : receipt === 'reverted' ? 13 : 16;
    return { action: 'adopt', row, reason: 'unique matching burn found', hash: matches[0] };
  }

  // ここから L=0。
  // row 12: reverted receipt が読めた = その nonce は消費済で、同 nonce の置換 tx が成功して
  // mined した可能性は排除される。L=0 かつ mempool 空なので「USDC は動いていない」が確定。
  if (hash && receipt === 'reverted') {
    return gatedReburn(12, 'burn reverted, no matching burn on chain', input);
  }
  // row 8 / 19: nonce だけ進んで log 無し = 「revert した burn」と「無関係 tx」が区別できない。
  if (input.nonceAdvanced) {
    return applyManualOverride(
      manualDecision(hash ? 19 : 8, 'nonce advanced without a matching burn', true),
      input,
    );
  }
  // row 9 / 18: 未 broadcast / dropped と結論 (nonce 不変 + mempool 空 + log 無し + gap 充足)。
  if (input.gapSatisfied) {
    return gatedReburn(hash ? 18 : 9, 'cold: no broadcast observed', input);
  }
  // row 10: まだ間もない (broadcast 直後の可能性)。
  return { action: 'wait', row: 10, reason: 'too soon after marker' };
}

// 自動再 burn は flag が ON のときだけ。OFF の間は同じ状況を manual に落とし、買い手の
// 二段確認を経れば再 burn できる (設計 §9 Phase 1)。
function gatedReburn(
  row: number,
  reason: string,
  input: ClassifyBurnStateInput,
): BurnDecision {
  if (input.autoReburnEnabled) return { action: 'burn', row, reason };
  return applyManualOverride(
    manualDecision(row, `${reason} (auto re-burn flag off)`, true),
    input,
  );
}

// manual を買い手の二段確認で開ける。mempool 有りは既に wait で先に返っているので、ここに
// 来る manual は「mempool 空」が確認済み。
function applyManualOverride(
  decision: BurnDecision,
  input: ClassifyBurnStateInput,
): BurnDecision {
  if (
    decision.action === 'manual' &&
    decision.reburnable &&
    input.allowManualReburn
  ) {
    return { action: 'burn', row: decision.row, reason: `${decision.reason} (manual override)` };
  }
  return decision;
}
