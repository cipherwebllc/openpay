'use client';

// 「決済の控え」をブラウザ LocalStorage に保存する。
//
// OpenPay はノンカストディ設計のため、売上の真正性はチェーン上の tx にあり、
// この履歴はあくまで「同じブラウザで処理した決済の閲覧/CSV エクスポート用補助」。
// 端末が変われば履歴も消えるし、端末紛失で第三者が読めば内容は閲覧可能 (rotate
// なし)。NonCustodialNotice (full) でユーザに毎回その性質を明示する。
//
// 設計判断:
// - LocalStorage は origin scope。XSS が無ければ他オリジンから読めない。
//   ~500B/entry × 1000 = 500KB ≪ 5MB 上限。
// - bigint は JSON シリアライズできないため string 化して保存。
// - `id` で dedupe — React StrictMode の二重 effect / mutation onSuccess 再呼出を吸収。
// - FIFO 1000 件 cap — 古いものから削除。
// - cross-tab 同期:
//     LocalStorage の `storage` event は他タブのみ発火する仕様。自タブの再描画は
//     CustomEvent (`openpay:history-changed`) で別経路で通知する。
// - corrupt JSON / schema mismatch:
//     load 時に valid entries のみ復元、不正値は静かに脱落 (UI 全滅より部分復元)。

import { safeGet, safeSet } from './storage';
import { logger } from './logger';
import type { GasMode, PayMode } from './fee';
import type {
  CircleVerificationStatus,
  PaymentFlow,
  PaymentProvider,
  PaymentResult,
} from './paymentLog';
import { pad } from './pad';
import type { TokenSymbol } from './tokens';

export const HISTORY_STORAGE_KEY = 'openpay:history:v1';
export const HISTORY_CHANGED_EVENT = 'openpay:history-changed';
export const HISTORY_MAX_ENTRIES = 1000;
// 自由入力 (CheckoutForm の params.description 経由) を 1000 文字で truncate。
// 1000 件 × 1000 文字 ≒ 1 MB 上限 (UTF-8 換算で max ~3 MB)、LocalStorage 5 MB に
// 収まる。悪意 URL からの肥大化攻撃を構造的に防止。
export const HISTORY_NOTE_MAX_LENGTH = 1000;
// errorMessage は呼出元に依らず buildHistoryEntry で必ず cap される (Sentry / LocalStorage
// 肥大化対策、 stack trace で巨大化する error.message を抑える)。
export const HISTORY_ERROR_MESSAGE_MAX_LENGTH = 500;

// HistoryEntry は decimals / display symbol を保持しないため (raw wei + asset slug
// のみ)、UI / CSV 出力時に lookup する。lib/tokens.ts の TokenDeployment と同一
// 値を維持する必要があり、 token を増やすときは両方を更新する。
export const HISTORY_ASSET_DECIMALS: Record<TokenSymbol, number> = {
  jpyc: 18,
  usdc: 6,
};

export const HISTORY_ASSET_DISPLAY: Record<TokenSymbol, string> = {
  jpyc: 'JPYC',
  usdc: 'USDC',
};

// schema version 管理:
//
// LocalStorage に書かれた entry が将来 schema 変更を生き残るための infrastructure。
//
// 設計:
//   - すべての entry に schemaVersion field を必須 (新規 build は LATEST_SCHEMA_VERSION)。
//   - 既存 LocalStorage entry (Phase 2 初期版で schemaVersion を持たない) は
//     migrateToLatest で「unversioned = v1」と判定して v1 stamp して取込む。
//   - 将来 v2 → v3 等の schema 変更時は MIGRATIONS[from] = (entry) => migrated_entry
//     を 1 行追加するだけで chain migration が走る (migrateToLatest が低→高に repeatedly apply)。
//   - LATEST_SCHEMA_VERSION より大きい version は user の browser が我々の build より
//     新しい (= rollback 後の旧版が新版 entry を読む) ケース → 安全に drop。
//   - 不明な intermediate version (e.g. v3 がいたら v2 migration が必要だが無い) も drop。
//
// 既存 user データ救済の証拠は tests/lib/history.test.ts:「unversioned legacy 読込」群を参照。

// v2 (2026-05-30): Circle Paymaster (USDC ガスレス) 対応で provider 次元と Circle 監査
// フィールドを追加。legacy(v1) は MIGRATIONS[1] で新フィールド=null backfill (drop しない)。
// v3 (2026-06-01): fee/gas データ分離 (会計精度・freee 前提)。feeAmount を OpenPay 利用
// 手数料 (= サービス料、alpha/将来とも 0) のみに純化し、ネットワーク手数料相当額を
// networkFeeEquivalent に分離。売上総額 saleAmount を追加 (split / 着金控除と区別し
// GMV 集計の基礎にする)。legacy(v2) は MIGRATIONS[2] で null backfill + 内訳不明印
// (feeBreakdownVersion=0)。
export const LATEST_SCHEMA_VERSION = 3 as const;

// fee/gas 内訳セマンティクスの版。schemaVersion とは独立: migration は schemaVersion を
// 昇格させるが、migrate された旧 entry の feeAmount は依然 conflated (利用手数料 + ガス
// reimbursement) で内訳不明のまま。native に v3 で記録した entry のみ「分離済」とみなす。
export const FEE_BREAKDOWN_VERSION = 1 as const;
// legacy / migrated entry の印 (利用手数料・網手数料の集計から除外する判定に使う)。
export const FEE_BREAKDOWN_UNKNOWN = 0 as const;

/** どの paymaster 系統で送ったか。legacy(v1) entry は記録が無いため null。
 * SoT は lib/paymentLog.ts の PaymentProvider (history→paymentLog の一方向 import)。 */
export type HistoryProvider = PaymentProvider;

/** Circle 徴収額 (circlePaymasterNetUsdc) の検証ステータス。
 * - verified: on-chain receipt から server/offline verifier が再計算した確定値
 * - client-reported: client が receipt から算出 (改竄可能性あり・参考値)
 * - unreconciled: receipt 照合不能 (txHash 解決不可・binding 不一致 等)
 * SoT は lib/paymentLog.ts の CircleVerificationStatus。 */
export type CircleVerification = CircleVerificationStatus;

export type HistoryEntry = {
  /** schema version. 新規 entry は常に LATEST_SCHEMA_VERSION を持つ。 */
  schemaVersion: number;
  /** dedupe 用一意キー。tx hash があれば `${flow}-${hash}`、無ければ uuid。 */
  id: string;
  /** 取込時刻 (Date.now())。チェーン上 block time とは別物 (UI 表示用)。 */
  ts: number;
  flow: PaymentFlow;
  status: PaymentResult;
  chainId: number;
  /** "base" | "arbitrum" | "optimism" | "polygon"。URL 復元等で使う。 */
  chainSlug: string;
  asset: TokenSymbol;
  tokenAddress: string;
  /** 「JPYC ガスレス決済 (customer 負担)」等の表示識別子に。 */
  payMode: PayMode;
  /** standard モードでは概念がないため null。gasless のみ意味あり。 */
  gasMode: GasMode | null;
  merchant: string;
  /** bigint 文字列化 (raw wei)。decimal 化は表示時に formatTokenAmount。 */
  merchantAmount: string;
  customer: string | null;
  feeReceiver: string | null;
  feeAmount: string | null;
  txHash: string | null;
  userOpHash: string | null;
  /** receipt の blockNumber を文字列化したもの (UI 表示 + Explorer リンク用)。 */
  blockNumber: string | null;
  errorMessage: string | null;
  /**
   * 店舗名。 **現状は常に空文字** (`''`)。
   * - PaymentForm / CheckoutForm から append される時点で URL params に
   *   店舗名 key が無いため、parent component から空文字で渡される。
   * - 将来 `?name=` 等の URL 拡張で乗せる前提で field は予約してある。
   * - CSV 列 / UI 表示は空欄になる。schema 互換性のため field は削除しない。
   */
  storeName: string;
  /** 任意メモ (将来の inline edit 用、Phase 2 投入時は空)。 */
  note: string;
  // --- v2 追加 (Circle Paymaster 監査・legacy は null backfill) ---
  /** paymaster 系統。gasless で 'pimlico' | 'circle'、standard / legacy は null。 */
  provider: HistoryProvider | null;
  /** Circle Paymaster (permit spender) アドレス。circle 経路のみ、他は null。 */
  circlePaymasterAddress: string | null;
  /** Circle が postOp で徴収した net USDC (raw・customer→paymaster − refund)。
   * circle + 算出済のみ、他は null。 */
  circlePaymasterNetUsdc: string | null;
  /** circlePaymasterNetUsdc の検証ステータス。circle 経路のみ、他は null。 */
  circleVerification: CircleVerification | null;
  // --- v3 追加 (fee/gas 分離・会計精度。legacy は MIGRATIONS[2] で null/0 backfill) ---
  /** 売上総額 (請求額・raw)。利用手数料 / ガス / split 控除前の gross で、GMV 集計の
   * 基礎。standard / gasless とも設定する。legacy(v2 以前) は記録が無く null。
   * 注: 売上を伴わない leg (standard-fee = 手数料徴収 tx) も null。 */
  saleAmount: string | null;
  /** ネットワーク手数料相当額 (raw・支払トークン単位)。全 gasless 経路横断の統一項目:
   * JPYC sponsorship の立替回収 / USDC Pimlico erc20 で paymaster が顧客から徴収する gas
   * 見積。circle 経路のみ検証ステータス付きで circlePaymasterNetUsdc 側に保持するため
   * null とし、表示/集計は networkFeeEquivalentOf で coalesce する。standard / legacy は null。 */
  networkFeeEquivalent: string | null;
  /** fee/gas 内訳セマンティクスの版。native v3 = FEE_BREAKDOWN_VERSION、
   * legacy / migrated = FEE_BREAKDOWN_UNKNOWN (集計で利用手数料 / 網手数料 total から除外)。 */
  feeBreakdownVersion: number;
};

// LATEST_SCHEMA_VERSION の entry に対する shape 検証。migration 後の最終 entry に
// 適用する。bigint string や address 形式の厳密検証は表示時
// (formatTokenAmount / Explorer) の責務に委譲する。
function isValidEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  // schemaVersion は LATEST と一致必須 (migration 経路で stamp 済前提)。
  if (e.schemaVersion !== LATEST_SCHEMA_VERSION) return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (
    e.flow !== 'batch' &&
    e.flow !== 'direct' &&
    e.flow !== 'standard-merchant' &&
    e.flow !== 'standard-fee'
  )
    return false;
  if (e.status !== 'success' && e.status !== 'reverted' && e.status !== 'error')
    return false;
  if (typeof e.chainId !== 'number') return false;
  if (typeof e.chainSlug !== 'string') return false;
  if (e.asset !== 'jpyc' && e.asset !== 'usdc') return false;
  if (typeof e.tokenAddress !== 'string') return false;
  if (e.payMode !== 'gasless' && e.payMode !== 'standard') return false;
  if (e.gasMode !== null && e.gasMode !== 'customer' && e.gasMode !== 'merchant')
    return false;
  if (typeof e.merchant !== 'string') return false;
  if (typeof e.merchantAmount !== 'string') return false;
  if (e.customer !== null && typeof e.customer !== 'string') return false;
  if (e.feeReceiver !== null && typeof e.feeReceiver !== 'string') return false;
  if (e.feeAmount !== null && typeof e.feeAmount !== 'string') return false;
  if (e.txHash !== null && typeof e.txHash !== 'string') return false;
  if (e.userOpHash !== null && typeof e.userOpHash !== 'string') return false;
  if (e.blockNumber !== null && typeof e.blockNumber !== 'string') return false;
  if (e.errorMessage !== null && typeof e.errorMessage !== 'string') return false;
  if (typeof e.storeName !== 'string') return false;
  if (typeof e.note !== 'string') return false;
  // v2 フィールド (legacy は migration で null backfill 済)。
  if (
    e.provider !== null &&
    e.provider !== 'pimlico' &&
    e.provider !== 'circle'
  )
    return false;
  if (
    e.circlePaymasterAddress !== null &&
    typeof e.circlePaymasterAddress !== 'string'
  )
    return false;
  if (
    e.circlePaymasterNetUsdc !== null &&
    typeof e.circlePaymasterNetUsdc !== 'string'
  )
    return false;
  if (
    e.circleVerification !== null &&
    e.circleVerification !== 'verified' &&
    e.circleVerification !== 'client-reported' &&
    e.circleVerification !== 'unreconciled'
  )
    return false;
  // v3 フィールド (legacy は migration で null/0 backfill 済)。
  if (e.saleAmount !== null && typeof e.saleAmount !== 'string') return false;
  if (
    e.networkFeeEquivalent !== null &&
    typeof e.networkFeeEquivalent !== 'string'
  )
    return false;
  if (
    typeof e.feeBreakdownVersion !== 'number' ||
    !Number.isInteger(e.feeBreakdownVersion) ||
    e.feeBreakdownVersion < 0
  )
    return false;
  return true;
}

/**
 * `from` 版の entry を `from + 1` 版に変換する関数。null 返却 = 救済不能 → drop。
 * 1 step migration のみ (chain は migrateToLatest が低→高に repeatedly apply する)。
 */
export type MigrationFn = (
  entry: Record<string, unknown>,
) => Record<string, unknown> | null;

/**
 * key = `from` version、value = `from → from+1` migration。
 *
 * **現状は空** (v1 単独運用、過去版なし)。将来 v2 を投入する時はここに
 * `MIGRATIONS[1] = (entry) => ({ ...entry, schemaVersion: 2, ...new_fields })`
 * を 1 行追加するだけで chain が走る。
 *
 * unversioned entry (Phase 2 初期の schemaVersion 不在データ) は
 * `migrateToLatest` 内で「v1 として stamp」する固定処理で吸収し、
 * MIGRATIONS には登録しない (v0 → v1 ではなく "stamp" 扱い)。
 */
export const MIGRATIONS: Record<number, MigrationFn> = {
  // v1 → v2 (2026-05-30): Circle Paymaster 監査フィールドを追加。legacy entry には
  // 記録が無いので null backfill (drop しない・UI/CSV から消さない)。schemaVersion は
  // migrateToLatest のループが昇格させるが、明示しておく。
  1: (entry) => ({
    ...entry,
    schemaVersion: 2,
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
  }),
  // v2 → v3 (2026-06-01): fee/gas 分離フィールドを追加。legacy entry は内訳が記録されて
  // おらず (feeAmount が利用手数料 + ガス reimbursement の conflated 値)、売上総額 / 網
  // 手数料を後付けで分離できないため null backfill + feeBreakdownVersion=0 (内訳不明)。
  // HistoryRow は networkFeeEquivalent===null を legacy 判定に使い、旧 heuristic
  // (gasless かつ feeAmount>0 → ネットワーク手数料) を適用する。
  2: (entry) => ({
    ...entry,
    schemaVersion: 3,
    saleAmount: null,
    networkFeeEquivalent: null,
    feeBreakdownVersion: FEE_BREAKDOWN_UNKNOWN,
  }),
};

/**
 * 任意 version の生 entry を LATEST_SCHEMA_VERSION の HistoryEntry へ昇格させる。
 * 救済不能なら null を返し、loadHistory が drop カウンタに入れる。
 *
 * 規則:
 *   - 非 object / null → drop
 *   - schemaVersion が number でない → unversioned 扱いで v1 stamp
 *     (Phase 2 初期 LocalStorage データへの後方互換)
 *   - LATEST より大きい → drop (rollback 後の旧 build が新 entry を読むケース、
 *     未知の field 構造で UI 表示が壊れる可能性があるため安全に drop)
 *   - LATEST より小さい → MIGRATIONS[v] → MIGRATIONS[v+1] → ... と repeatedly apply。
 *     途中で migration 未登録 (gap) なら drop。各 step で null を返したら drop。
 *   - 最後に isValidEntry で final shape を検証 → 通れば HistoryEntry。
 */
export function migrateToLatest(value: unknown): HistoryEntry | null {
  if (value === null || typeof value !== 'object') return null;
  let current = { ...(value as Record<string, unknown>) };
  let version =
    typeof current.schemaVersion === 'number' ? current.schemaVersion : 1;
  if (typeof current.schemaVersion !== 'number') {
    // unversioned legacy entry → v1 stamp (Phase 2 初期版データ救済)
    current = { ...current, schemaVersion: 1 };
  }
  if (version > LATEST_SCHEMA_VERSION) return null;
  while (version < LATEST_SCHEMA_VERSION) {
    const migrator = MIGRATIONS[version];
    if (!migrator) return null;
    const next = migrator(current);
    if (next === null || typeof next !== 'object') return null;
    current = { ...next };
    version += 1;
    current.schemaVersion = version;
  }
  return isValidEntry(current) ? current : null;
}

export function loadHistory(): HistoryEntry[] {
  const raw = safeGet<unknown>(HISTORY_STORAGE_KEY, []);
  if (!Array.isArray(raw)) {
    logger.warn('history.load.not-array', { actual: typeof raw });
    return [];
  }
  const valid: HistoryEntry[] = [];
  let invalid = 0;
  for (const item of raw) {
    const migrated = migrateToLatest(item);
    if (migrated === null) {
      invalid += 1;
    } else {
      valid.push(migrated);
    }
  }
  if (invalid > 0) {
    logger.warn('history.load.invalid-entries-dropped', {
      invalid,
      kept: valid.length,
    });
  }
  return valid;
}

// 自タブ向け CustomEvent。useHistory hook が拾って state を再 load する。
// callers (appendHistory/remove/clear) が事前に typeof window で guard 済。
function broadcastChange(): void {
  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
}

export function appendHistory(entry: HistoryEntry): void {
  if (typeof window === 'undefined') return;
  const current = loadHistory();
  // 同一 id (= 同一 tx hash 等) は no-op で dedupe。
  if (current.some((e) => e.id === entry.id)) return;
  const next = [entry, ...current];
  const trimmed =
    next.length > HISTORY_MAX_ENTRIES
      ? next.slice(0, HISTORY_MAX_ENTRIES)
      : next;
  safeSet(HISTORY_STORAGE_KEY, trimmed);
  broadcastChange();
}

export function removeHistoryEntry(id: string): void {
  if (typeof window === 'undefined') return;
  const current = loadHistory();
  const next = current.filter((e) => e.id !== id);
  if (next.length === current.length) return;
  safeSet(HISTORY_STORAGE_KEY, next);
  broadcastChange();
}

export function clearHistory(): void {
  if (typeof window === 'undefined') return;
  safeSet(HISTORY_STORAGE_KEY, []);
  broadcastChange();
}

// 親 component (PaymentForm / CheckoutForm) が決済結果を整形するための builder。
// hook (useBatchPayment / useStandardPayment) は内部で append しない方針:
//   - hook は metadata (storeName / payMode / gasMode / chainSlug) を知らない
//   - hook signature を肥大化させたくない (test の差分が大きくなる)
//   - 同じ result から PaymentForm と CheckoutForm が異なる context を組み立てる余地を残す

export type BuildHistoryBase = {
  flow: PaymentFlow;
  status: PaymentResult;
  chainId: number;
  chainSlug: string;
  asset: TokenSymbol;
  tokenAddress: string;
  payMode: PayMode;
  gasMode: GasMode | null;
  merchant: string;
  merchantAmount: bigint;
  customer: string | null | undefined;
  feeReceiver: string | null;
  feeAmount: bigint | null;
  txHash: string | null;
  userOpHash: string | null;
  blockNumber: bigint | null;
  errorMessage: string | null;
  storeName: string;
  /** 任意メモ (CheckoutForm の params.description / orderId 等)。省略時 ''。 */
  note?: string;
  // --- v2 (省略時はすべて null = legacy/standard 互換) ---
  provider?: HistoryProvider | null;
  circlePaymasterAddress?: string | null;
  circlePaymasterNetUsdc?: string | null;
  circleVerification?: CircleVerification | null;
  // --- v3 (fee/gas 分離。省略時 null = sale を伴わない leg / 互換) ---
  /** 売上総額 (gross・請求額)。sale を伴う entry で設定、手数料徴収 leg 等は null。 */
  saleAmount?: bigint | null;
  /** ネットワーク手数料相当額 (非 circle の gasless 経路)。省略時 null。 */
  networkFeeEquivalent?: bigint | null;
};

/**
 * 一意 id の決定規則:
 *   - txHash あり    → `${flow}-${txHash}` (同一 tx の二重 append を防ぐ)
 *   - userOpHash あり → `${flow}-uo-${userOpHash}`
 *   - hash なし (writeContract 同期 throw / wallet rejected sign 等):
 *      `${flow}-err-${seconds}-${errorMessage.slice(0,32)}`
 *      - seconds 解像度なので Next.js dev の React StrictMode 二重発火
 *        (microsecond 差) は同 id で dedupe される。
 *      - 1 秒以上開けたユーザ retry は別 id (= 別 entry) として記録。
 *      - errorMessage が同一でも秒が違えば別 entry。
 *      - errorMessage 不在の極稀 case は 'noerr' を seed に使用。
 *
 * StrictMode 二重 effect / react-query onSuccess 再呼出のいずれでも
 * appendHistory 側 (id 一致) で dedupe される。
 */
export function buildHistoryEntry(
  input: BuildHistoryBase & { ts?: number },
): HistoryEntry {
  const ts = input.ts ?? Date.now();
  const id = input.txHash
    ? `${input.flow}-${input.txHash}`
    : input.userOpHash
      ? `${input.flow}-uo-${input.userOpHash}`
      : `${input.flow}-err-${Math.floor(ts / 1000)}-${(input.errorMessage ?? 'noerr').slice(0, 32)}`;
  return {
    schemaVersion: LATEST_SCHEMA_VERSION,
    id,
    ts,
    flow: input.flow,
    status: input.status,
    chainId: input.chainId,
    chainSlug: input.chainSlug,
    asset: input.asset,
    tokenAddress: input.tokenAddress,
    payMode: input.payMode,
    gasMode: input.gasMode,
    merchant: input.merchant,
    merchantAmount: input.merchantAmount.toString(),
    customer: input.customer ?? null,
    feeReceiver: input.feeReceiver,
    feeAmount: input.feeAmount === null ? null : input.feeAmount.toString(),
    txHash: input.txHash,
    userOpHash: input.userOpHash,
    blockNumber: input.blockNumber === null ? null : input.blockNumber.toString(),
    errorMessage:
      input.errorMessage === null
        ? null
        : input.errorMessage.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH),
    storeName: input.storeName,
    note: (input.note ?? '').slice(0, HISTORY_NOTE_MAX_LENGTH),
    provider: input.provider ?? null,
    circlePaymasterAddress: input.circlePaymasterAddress ?? null,
    circlePaymasterNetUsdc: input.circlePaymasterNetUsdc ?? null,
    circleVerification: input.circleVerification ?? null,
    saleAmount: input.saleAmount == null ? null : input.saleAmount.toString(),
    networkFeeEquivalent:
      input.networkFeeEquivalent == null
        ? null
        : input.networkFeeEquivalent.toString(),
    // native v3 で記録した entry は常に分離済印を持つ (migration 経路のみ UNKNOWN)。
    feeBreakdownVersion: FEE_BREAKDOWN_VERSION,
  };
}

/** 表示 / 集計用にネットワーク手数料相当額を解決する (provider 横断で coalesce)。
 * 非 circle 経路は networkFeeEquivalent、circle 経路は circlePaymasterNetUsdc
 * (検証ステータスは circleVerification 側に保持)。どちらも無ければ null。 */
export function networkFeeEquivalentOf(entry: HistoryEntry): string | null {
  return entry.networkFeeEquivalent ?? entry.circlePaymasterNetUsdc;
}

/** fee/gas 内訳が分離記録済 (native v3) か。legacy / migrated は false
 * (利用手数料 / 網手数料の集計から除外する判定に使う)。 */
export function hasSeparatedBreakdown(entry: HistoryEntry): boolean {
  return entry.feeBreakdownVersion >= FEE_BREAKDOWN_VERSION;
}

/** 数値 timestamp を yyyy-MM-dd HH:mm:ss (locale 形式) に整形。CSV にも UI にも使う。 */
export function formatHistoryTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
