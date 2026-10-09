// store-reconcile cron の時間予算 (第 7 回レビュー B4)。
// ページ数の上限 (PURCHASE_RECONCILE_MAX_PAGES 等) だけでは getLogs が遅いとき cron の maxDuration (60 秒) を
// 守れず、cursor 保存前に打ち切られて次回も同じ範囲を走査する。両 rail に経過時間の予算 (deadline) を割り当て、
// JPYC が重くても USDC の番が来るようにする。残りの約 10 秒は lease CAS の保存・応答・license index 復旧の余裕。
export const STORE_RECONCILE_CRON_MAX_DURATION_SEC = 60;
export const STORE_RECONCILE_JPYC_BUDGET_MS = 25_000;
export const STORE_RECONCILE_TOTAL_BUDGET_MS = 50_000;

// 1 回のページ取得 (getLogs) の RPC は、deadline 付きのときだけ retry なし・この timeout で呼ぶ (既定の transport は
// timeout 10 秒 × retry 3 回 = 最悪 40 秒超で、deadline の確認をページ取得の前にしても 1 回の RPC が予算を食い潰す)。
export const STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS = 10_000;
// deadline までに必ず残す時間: 取得後の候補照合と cursor の CAS 保存に使う。
export const STORE_RECONCILE_CURSOR_RESERVE_MS = 3_000;
// これ未満の時間しか残らない取得は始めない (失敗が見えているので、未取得ページ先頭を cursor に残して次回へ)。
export const STORE_RECONCILE_PAGE_RPC_MIN_MS = 2_000;

export function storeReconcileDeadlines(startedAt: number): { jpyc: number; usdc: number } {
  return {
    jpyc: startedAt + STORE_RECONCILE_JPYC_BUDGET_MS,
    // USDC は JPYC の後に走るので、JPYC が早く終わればその分も使える。
    usdc: startedAt + STORE_RECONCILE_TOTAL_BUDGET_MS,
  };
}

/**
 * 次のページ取得に使える RPC の timeout (ms)。
 * undefined = deadline なし (status route 等・既定の transport のまま) / null = 残り時間 − 予約が最小に足りないので
 * 取得を始めない / number = 残り時間 − 予約と PAGE_RPC_TIMEOUT の小さい方。
 */
export function pageFetchTimeout(deadline: number | undefined, now = Date.now()): number | null | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - now - STORE_RECONCILE_CURSOR_RESERVE_MS;
  if (remaining < STORE_RECONCILE_PAGE_RPC_MIN_MS) return null;
  return Math.min(remaining, STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS);
}
