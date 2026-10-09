// store-reconcile cron の時間予算 (第 7 回レビュー B4)。
// ページ数の上限 (PURCHASE_RECONCILE_MAX_PAGES 等) だけでは getLogs が遅いとき cron の maxDuration (60 秒) を
// 守れず、cursor 保存前に打ち切られて次回も同じ範囲を走査する。両 rail に経過時間の予算 (deadline) を割り当て、
// JPYC が重くても USDC の番が来るようにする。残りの約 10 秒は lease CAS の保存・応答・license index 復旧の余裕。
export const STORE_RECONCILE_CRON_MAX_DURATION_SEC = 60;
export const STORE_RECONCILE_JPYC_BUDGET_MS = 25_000;
export const STORE_RECONCILE_TOTAL_BUDGET_MS = 50_000;

export function storeReconcileDeadlines(startedAt: number): { jpyc: number; usdc: number } {
  return {
    jpyc: startedAt + STORE_RECONCILE_JPYC_BUDGET_MS,
    // USDC は JPYC の後に走るので、JPYC が早く終わればその分も使える。
    usdc: startedAt + STORE_RECONCILE_TOTAL_BUDGET_MS,
  };
}
