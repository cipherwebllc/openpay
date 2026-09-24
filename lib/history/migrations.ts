// 保存済みの生 entry を最新 schema へ昇格させる MIGRATIONS と、最終 shape の検証。
// MIGRATIONS はここだけで定義し、facade はこの object をそのまま再 export する。test が facade
// 経由で直接書き換えるため、複製すると migrateToLatest / loadHistory に反映されなくなる。

import { isTaxCategory } from '../tax';
import {
  FEE_BREAKDOWN_UNKNOWN,
  LATEST_SCHEMA_VERSION,
  type HistoryEntry,
} from './model';

// LATEST_SCHEMA_VERSION の entry に対する shape 検証。migration 後の最終 entry に
// 適用する。bigint string や address 形式の厳密検証は表示時
// (formatTokenAmount / Explorer) の責務に委譲する。
// v5 売上明細の shape 検証 (各要素を防御的に確認)。null は呼出側で別途許容。
function isValidLineItems(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((li) => {
    if (li === null || typeof li !== 'object') return false;
    const o = li as Record<string, unknown>;
    if (typeof o.name !== 'string') return false;
    if (typeof o.quantity !== 'number' || !Number.isInteger(o.quantity)) return false;
    if (typeof o.unitPrice !== 'string') return false;
    if (typeof o.amount !== 'string') return false;
    if (
      o.taxRate !== null &&
      (typeof o.taxRate !== 'number' || !Number.isFinite(o.taxRate))
    )
      return false;
    if (o.taxCategory !== null && !isTaxCategory(o.taxCategory)) return false;
    if (o.memo !== null && typeof o.memo !== 'string') return false;
    // 複数商品カート用の任意フィールド (在れば型のみ検証・必須化しない)。
    if (o.id !== undefined && typeof o.id !== 'string') return false;
    if (
      o.currency !== undefined &&
      o.currency !== 'jpyc' &&
      o.currency !== 'usdc'
    )
      return false;
    if (o.taxAmount !== undefined && typeof o.taxAmount !== 'string') return false;
    if (o.presetId !== undefined && typeof o.presetId !== 'string') return false;
    return true;
  });
}

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
  if (
    e.status !== 'success' &&
    e.status !== 'reverted' &&
    e.status !== 'error' &&
    e.status !== 'pending'
  )
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
  // v4 フィールド (非換算 / legacy は migration で null backfill 済)。
  if (e.anchorAmount !== null && typeof e.anchorAmount !== 'string') return false;
  if (
    e.anchorSymbol !== null &&
    e.anchorSymbol !== 'jpyc' &&
    e.anchorSymbol !== 'usdc'
  )
    return false;
  if (e.fxRateUsdcJpy !== null && typeof e.fxRateUsdcJpy !== 'string')
    return false;
  // v5 フィールド (legacy は migration で null backfill 済)。
  if (e.productName !== null && typeof e.productName !== 'string') return false;
  if (e.memo !== null && typeof e.memo !== 'string') return false;
  if (
    e.taxRate !== null &&
    (typeof e.taxRate !== 'number' || !Number.isFinite(e.taxRate))
  )
    return false;
  if (e.taxCategory !== null && !isTaxCategory(e.taxCategory)) return false;
  if (e.receiptNo !== null && typeof e.receiptNo !== 'string') return false;
  if (e.lineItems !== null && !isValidLineItems(e.lineItems)) return false;
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
  // v3 → v4 (2026-06-03): 異通貨建て決済の anchor フィールドを追加。legacy entry は
  // FX 換算ではない (or 記録前) ため null backfill。
  3: (entry) => ({
    ...entry,
    schemaVersion: 4,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
  }),
  // v4 → v5 (2026-06-04): 記帳補助メタデータ (商品名/メモ/税率/税区分/管理番号/売上明細) を追加。
  // legacy entry は記録が無いため null backfill (drop しない・既存 CSV 出力も taxCategory=null で不変)。
  4: (entry) => ({
    ...entry,
    schemaVersion: 5,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
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
 *     未知の field 構造による UI 破損を防ぐため読込結果から除外。保存時は生データを保持)
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
