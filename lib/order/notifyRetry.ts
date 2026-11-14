// /checkout の完了の受注通知 (hooks/useCheckoutOrderNotify.ts の effect A) を自動で送り直すときの、待ち時間と回数の計算。
// 何も import しない純関数だけ (時計も状態も持たない)。送る loop・送った時刻の記録・画面の状態は hook の側にある。
//
// server (app/api/order/notify) は、同じ支払い (txHash) と IP の組を 60 秒に 5 回まで受ける。6 回目からは 429 で、
// 断った要求も回数に数える (lib/relay/relayGuards.ts の sliding window)。枠を使い切ったまま短い間隔で送り直すと、
// 窓が延びるだけで通らない。

// 「待てば通る」失敗 (5xx・429・422 tx_not_found・通信の失敗・2xx で届いた形でない応答) の後に送り直すまでの待ち時間。
// 配列の長さが、自動の送り直しの回数の上限 (1 回目 2 秒・2 回目 15 秒)。
export const ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS = [2_000, 15_000] as const;
// server の窓 (60 秒) より 1 秒長く見る (端末と server の時計・届くまでの時間の差の分)。
export const ORDER_NOTIFY_RATE_WINDOW_MS = 61_000;
export const ORDER_NOTIFY_RATE_LIMIT = 5;

// retryIndex 回目 (0 始まり) の自動の送り直しの、枠を見る前の待ち時間。上限を超えていたら null (もう送り直さない)。
// lastStatus = 直前の失敗の HTTP status (fetch が投げたときは null)。
export function orderNotifyAutoRetryBaseDelayMs(retryIndex: number, lastStatus: number | null): number | null {
  if (retryIndex >= ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS.length) return null;
  // 429 = 枠を使い切っている。窓が空くまで待つ。
  if (lastStatus === 429) return ORDER_NOTIFY_RATE_WINDOW_MS;
  return ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS[retryIndex];
}

// 枠の確かめを入れた待ち時間 (baseDelayMs 以上)。sentAtMs = この支払いでこの画面が送った時刻の全部 (順は問わない)。
// 待った後に送る 1 回を入れても、直近 61 秒の送信が 5 回を超えないようにする: 新しい方から 5 番目の送信が窓の外に出る
// (その送信から 61 秒たつ) まで待つ。5 回より少なければ baseDelayMs のまま。
export function orderNotifyRetryWaitMs(sentAtMs: readonly number[], nowMs: number, baseDelayMs: number): number {
  if (sentAtMs.length < ORDER_NOTIFY_RATE_LIMIT) return baseDelayMs;
  const fifthNewest = [...sentAtMs].sort((a, b) => b - a)[ORDER_NOTIFY_RATE_LIMIT - 1];
  return Math.max(baseDelayMs, fifthNewest + ORDER_NOTIFY_RATE_WINDOW_MS - nowMs);
}

// 応答の JSON の `error` を log (Sentry) に載せてよい形か。server の error の語は小文字と `_` だけ (rate_limited・rpc_error など)。
// 中継やほかの server が返す任意の文字列は載せない (合わなければ undefined = 欄ごと出さない)。
export function orderNotifyServerErrorForLog(error: unknown): string | undefined {
  return typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : undefined;
}
