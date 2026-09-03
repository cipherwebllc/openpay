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
  | { status: 'range' }
  /** provider の rate limit で走査できなかった。時間を置けば同じ走査が通るので
   *  manual (人間の二段確認) ではなく wait に倒す (D6)。 */
  | { status: 'ratelimited' };

// provider が「範囲が広すぎる」を返したかの判定。message / code の表現は provider ごとに
// バラバラなので実測ベースの部分一致で拾う。ここで拾えなかった error は transport 障害として
// throw する (「log 無し = 未 broadcast」に潰すと二重 burn になるため、握り潰さない)。
// ⚠ 'limit exceeded' は Alchemy 等の **rate limit** (-32005) の文面でもある。rate limit を
// 「範囲超過 → manual」に落とすと、時間を置けば解決する一過性の障害で買い手に explorer 確認を
// 強いることになるため、判定は必ず rate limit を先に見る (isRateLimitError → isRangeError)。
const RANGE_ERROR_PATTERNS = [
  'block range',
  // QuickNode: "eth_getLogs is limited to a 10,000 blocks range" (複数形・語順が別)
  'blocks range',
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

// rate limit (一過性) の判定。JSON-RPC code -32005 / HTTP 429 と、主要 provider の文面。
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate-limit',
  'ratelimit',
  'too many requests',
  'exceeded its compute units',
  'compute units per second',
  'request limit reached',
  'throttled',
  'over quota',
];
const RATE_LIMIT_CODES = new Set([-32005, 429]);

/** error の全 message 系フィールド (viem は details / shortMessage / metaMessages に
 *  provider の生文面を分けて入れる) を 1 本の小文字テキストに畳む。 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const visit = (e: unknown, depth: number): void => {
    if (depth > 4 || e === null || typeof e !== 'object') return;
    const rec = e as {
      message?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      metaMessages?: unknown;
      cause?: unknown;
    };
    for (const v of [rec.message, rec.details, rec.shortMessage]) {
      if (typeof v === 'string') parts.push(v.toLowerCase());
    }
    // viem は provider の生 error を metaMessages (string[]) に積む。
    if (Array.isArray(rec.metaMessages)) {
      for (const v of rec.metaMessages) {
        if (typeof v === 'string') parts.push(v.toLowerCase());
      }
    }
    visit(rec.cause, depth + 1);
  };
  visit(error, 0);
  return parts.join(' | ');
}

/** error chain 上の JSON-RPC code / HTTP status を集める。 */
function errorCodes(error: unknown): number[] {
  const codes: number[] = [];
  const visit = (e: unknown, depth: number): void => {
    if (depth > 4 || e === null || typeof e !== 'object') return;
    const rec = e as { code?: unknown; status?: unknown; cause?: unknown };
    for (const v of [rec.code, rec.status]) {
      if (typeof v === 'number') codes.push(v);
    }
    visit(rec.cause, depth + 1);
  };
  visit(error, 0);
  return codes;
}

export function isRateLimitError(error: unknown): boolean {
  if (errorCodes(error).some((c) => RATE_LIMIT_CODES.has(c))) return true;
  const text = errorText(error);
  return RATE_LIMIT_PATTERNS.some((p) => text.includes(p));
}

export function isRangeError(error: unknown): boolean {
  // rate limit が先 ('limit exceeded' は両方の文面に現れる)。
  if (isRateLimitError(error)) return false;
  const text = errorText(error);
  return RANGE_ERROR_PATTERNS.some((p) => text.includes(p));
}

/** tx / receipt が「その RPC からは見えない」= not found を表す error か。
 *  transport 障害と区別するため viem の error name のみで判定する。 */
function isNotFoundError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return (
    name === 'TransactionNotFoundError' ||
    name === 'TransactionReceiptNotFoundError'
  );
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
      // rate limit は「時間を置けば同じ走査が通る」一過性の障害。chunk を縮めても
      // 解決しないので縮小 loop に入れず、wait に倒すための signal を返す (D6)。
      if (isRateLimitError(error)) return { status: 'ratelimited' };
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
  // この 2 本も RPC なので getLogs と同じ call 予算 (MAX_SCAN_CALLS) に載せる —
  // 載せないと「1 chunk で 100 件マッチ = 200 call」のように上限が実質無効になり、
  // provider の rate limit / コスト上限を踏む (D5)。
  const matches: Hex[] = [];
  for (const hash of hashes) {
    if (calls + 2 > MAX_SCAN_CALLS) return { status: 'range' };
    let tx: { nonce: number; from: Address };
    try {
      calls += 1;
      tx = await args.client.getTransaction({ hash });
    } catch (error) {
      if (isRateLimitError(error)) return { status: 'ratelimited' };
      // reorg 等でこの候補だけが消えた場合は「一致しなかった」として飛ばす。走査全体を
      // throw で落とすと、他の候補で確定できたはずの判定まで巻き添えになる (D5)。
      // transport 障害は握り潰さず throw する (未 burn に潰さない)。
      if (!isNotFoundError(error)) throw error;
      continue;
    }
    if (tx.nonce < marker.nonceLatest) continue;
    if (tx.from.toLowerCase() !== marker.depositor.toLowerCase()) continue;
    let receipt: { status: string };
    try {
      calls += 1;
      receipt = await args.client.getTransactionReceipt({ hash });
    } catch (error) {
      if (isRateLimitError(error)) return { status: 'ratelimited' };
      if (!isNotFoundError(error)) throw error;
      continue;
    }
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
  /** P: getTransactionCount(pending) > getTransactionCount(latest)。
   *  **undefined = 未計測**。「計測していない」を「mempool は空」に潰すと、二段確認だけで
   *  mempool 滞留中の再 burn が通ってしまうため、両者を型で区別する (D1)。 */
  pendingAhead: boolean | undefined;
  /** N: latest > marker.nonceLatest (marker 以降にこの送信者の tx が mined) */
  nonceAdvanced: boolean;
  /** G: head − marker.block ≥ minGapBlocks かつ now − marker.at ≥ MIN_GAP_MS */
  gapSatisfied: boolean;
  /** G の時間成分のみ: now − marker.at ≥ MIN_GAP_MS。marker.block が無く block gap を
   *  測れない row 4 でも「marker からの最小経過時間」だけは判定できるので分けて持つ。
   *  marker 自体が無い (旧 state) 場合は基準時刻が無いので false。 */
  timeGapSatisfied: boolean;
  /** L: log 走査結果 (走査していなければ undefined) */
  scan: BurnScanResult | undefined;
  /** flag: row 9 / 12 / 18 の **自動** 再 burn を許すか (既定 OFF) */
  autoReburnEnabled: boolean;
  /** 買い手が manual パネルの二段確認を通したか (armManualReburn) */
  allowManualReburn: boolean;
}

/** manual に落ちた状態を、買い手の二段確認 (explorer で USDC が減っていないことを確認) で
 *  再 burn に開けてよいか。人間の申告は「on-chain を実際に見た上での補助」に限る (掟 15):
 *
 *   1. mempool が空であることを **実測済み** (pendingAhead === false)。未計測 (undefined)
 *      は開けない — row 3 (旧 state) / row 4 (marker.block 欠落) は決定表の上で
 *      pendingAhead 判定より **前** に返るため、計測しないまま override すると
 *      「mempool に burn が居るのに再 burn」= 二重支払いが成立してしまう (D1)。
 *   2. log 走査をしたなら「一致 0」であること。'range' (cap 超過) / 'ratelimited' は
 *      **見ていない** のと同じなので開けない。marker.block/nonce 欠落で走査自体を
 *      行わなかった (scan === undefined) 場合だけは 1. と 3. を代わりの根拠にする。
 *   3. marker があるなら marker からの最小経過時間 (MIN_GAP_MS) が経過していること
 *      — broadcast 直後は pending nonce に反映されない窓があるため。marker が無い
 *      旧 state は基準時刻が存在しないので、この条件は課さない (課すと恒久 wedge)。
 */
function canManuallyReburn(input: ClassifyBurnStateInput): boolean {
  if (input.pendingAhead !== false) return false;
  if (input.scan !== undefined) {
    if (input.scan.status !== 'ok') return false;
    if (input.scan.matches.length > 0) return false;
  }
  if (input.marker && !input.timeGapSatisfied) return false;
  return true;
}

// manual 決定。reburnable は「その row の性質上開けてよいか (byRow)」と「実測が揃っているか
// (canManuallyReburn)」の AND。UI はこの値でだけ二段確認ボタンを出す。
function manualDecision(
  row: number,
  reason: string,
  byRow: boolean,
  input: ClassifyBurnStateInput,
): BurnDecision {
  return {
    action: 'manual',
    row,
    reason,
    reburnable: byRow && canManuallyReburn(input),
  };
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
  // row 3: marker 導入前の旧 state で hash が revert / 未発見 → 走査範囲不明。
  // 二段確認で開けるのは mempool 空を実測できている場合だけ (canManuallyReburn)。
  if (!marker) {
    return applyManualOverride(
      manualDecision(3, 'legacy state without burn marker', true, input),
      input,
    );
  }

  // row 4: 走査範囲 (marker.block) / 同定条件 (marker.nonceLatest) が欠けている。
  if (marker.block === null || marker.nonceLatest === null) {
    return applyManualOverride(
      manualDecision(4, 'marker without block/nonce baseline', true, input),
      input,
    );
  }
  // row 22 (D6): provider の rate limit で走査できなかった。時間を置けば同じ走査が通るので
  // manual (人間の二段確認) ではなく wait。一過性の障害を買い手の explorer 確認に転嫁しない。
  if (scan?.status === 'ratelimited') {
    return { action: 'wait', row: 22, reason: 'burn log scan rate limited' };
  }
  // row 20: cap 超過 / call 上限。throw せず manual (恒久 wedge 回避)。走査を **していない**
  // ので二段確認でも開かない (canManuallyReburn の 2.) — 開けるのはサポート経由の照合。
  if (scan?.status === 'range') {
    return applyManualOverride(
      manualDecision(20, 'scan range exceeded cap', true, input),
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
    return manualDecision(hash ? 15 : 6, 'multiple matching burns', false, input);
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
      manualDecision(
        hash ? 19 : 8,
        'nonce advanced without a matching burn',
        true,
        input,
      ),
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
    manualDecision(row, `${reason} (auto re-burn flag off)`, true, input),
    input,
  );
}

// ---- 買い手が貼り付けた burn tx hash の検証 (D4) ------------------------------

/** 0x + 64 hex だけを受理する (explorer から貼るときの前後空白は落とす)。 */
export function normalizeBurnTxHash(input: string): Hex | undefined {
  const t = input.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(t) ? (t.toLowerCase() as Hex) : undefined;
}

export type BurnTxVerification =
  | { ok: true; hash: Hex }
  | {
      ok: false;
      /** format=書式不正 / notfound=この chain に無い / reverted=失敗 tx /
       *  mismatch=この決済の burn ではない (金額・宛先・chain・送信者・nonce のいずれかが不一致) */
      reason: 'format' | 'notfound' | 'reverted' | 'mismatch';
    };

/** 「burn は着弾したが hash が resume state に残らなかった」(決定表 row 4 / 20) 買い手の
 *  自己救済経路。買い手が explorer から貼った tx hash を **on-chain の事実だけ** で検証し、
 *  marker と一致したときだけ採用する。人間の申告 (「これが私の burn です」) は入口に過ぎず、
 *  採否は receipt と DepositForBurn log が決める (掟 15)。
 *
 *  受理条件 (すべて AND、§5 の候補受理条件と同一):
 *    1. receipt が取得でき status === 'success'
 *    2. その receipt の log に TokenMessenger / v2 DepositForBurn topic0 のものがある
 *    3. その log の burnToken / depositor / amount / destinationDomain / mintRecipient が
 *       marker と一致 (depositor は tx 送信者でもある)
 *    4. marker.nonceLatest が判っていれば tx.nonce >= marker.nonceLatest
 *       (= marker より前の「過去の同額 burn」を貼っても採用されない) */
export async function verifyBurnTxHash(args: {
  client: PublicClient;
  hash: Hex;
  marker: BurnIntentMarker;
  tokenMessenger: Address;
}): Promise<BurnTxVerification> {
  const { marker } = args;
  let receipt: {
    status: string;
    from?: Address;
    logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
  };
  try {
    receipt = (await args.client.getTransactionReceipt({
      hash: args.hash,
    })) as unknown as typeof receipt;
  } catch (error) {
    if (isNotFoundError(error)) return { ok: false, reason: 'notfound' };
    throw error; // transport 障害は「無かった」に潰さない
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'reverted' };
  if (
    receipt.from &&
    receipt.from.toLowerCase() !== marker.depositor.toLowerCase()
  ) {
    return { ok: false, reason: 'mismatch' };
  }

  const messenger = getAddress(args.tokenMessenger).toLowerCase();
  const wantRecipient = pad(getAddress(marker.mintRecipient), {
    size: 32,
  }).toLowerCase();
  const wantAmount = BigInt(marker.amount);
  const matched = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== messenger) return false;
    if (log.topics[0]?.toLowerCase() !== CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0) {
      return false;
    }
    let a: {
      burnToken: Address;
      amount: bigint;
      depositor: Address;
      mintRecipient: Hex;
      destinationDomain: number;
    };
    try {
      a = decodeEventLog({
        abi: [CCTP_V2_DEPOSIT_FOR_BURN_EVENT],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }).args as unknown as typeof a;
    } catch {
      // 同 topic0 で decode できない log は「一致しない」として無視する
      // (走査対象外の別 event を掴んで誤採用しないための隔離)。
      return false;
    }
    return (
      a.amount === wantAmount &&
      a.destinationDomain === marker.destinationDomain &&
      a.mintRecipient.toLowerCase() === wantRecipient &&
      a.burnToken.toLowerCase() === marker.burnToken.toLowerCase() &&
      a.depositor.toLowerCase() === marker.depositor.toLowerCase()
    );
  });
  if (!matched) return { ok: false, reason: 'mismatch' };

  if (marker.nonceLatest !== null) {
    let tx: { nonce: number; from: Address };
    try {
      tx = await args.client.getTransaction({ hash: args.hash });
    } catch (error) {
      if (isNotFoundError(error)) return { ok: false, reason: 'notfound' };
      throw error;
    }
    if (tx.from.toLowerCase() !== marker.depositor.toLowerCase()) {
      return { ok: false, reason: 'mismatch' };
    }
    // marker より前の burn (= 過去の同額送金) を貼っても採用しない。
    if (tx.nonce < marker.nonceLatest) return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, hash: args.hash };
}

// manual を買い手の二段確認で開ける。「開けてよいか」は manualDecision が
// canManuallyReburn (mempool 実測 + 走査結果 + gap) で既に決めているので、ここでは
// reburnable フラグだけを見る。
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
