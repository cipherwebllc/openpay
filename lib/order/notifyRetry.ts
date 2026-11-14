// /checkout の完了の受注通知 (hooks/useCheckoutOrderNotify.ts の effect A) を自動で送り直すときの、待ち時間と回数の計算。
// 何も import しない純関数だけ (時計も状態も持たない)。送る loop・送った時刻の記録・画面の状態は hook の側にある。
//
// server (app/api/order/notify) は、同じ支払い (txHash) と IP の組を 60 秒に 5 回まで受ける。6 回目からは 429 で、
// 断った要求も回数に数える (lib/relay/relayGuards.ts の sliding window)。枠を使い切ったまま短い間隔で送り直すと、
// 窓が延びるだけで通らない。

// 「待てば通る」失敗 (5xx・429・409 processing・422 tx_not_found・通信の失敗・2xx で届いた形でない応答) の後に送り直すまでの
// 待ち時間。配列の長さが、自動の送り直しの回数の上限 (1 回目 2 秒・2 回目 15 秒)。
export const ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS = [2_000, 15_000] as const;
// server の窓 (60 秒) より 1 秒長く見る (端末と server の時計・届くまでの時間の差の分)。
export const ORDER_NOTIFY_RATE_WINDOW_MS = 61_000;
export const ORDER_NOTIFY_RATE_LIMIT = 5;
// 自動の送り直しの前に、同じ支払いの部分の通知 (effect D) が送り終えるのを待つ上限。部分の通知の 409 の表は
// 最後の送信まで 140.25 秒。応答が返らない送信を、いつまでも待たない。
export const ORDER_NOTIFY_PARTIAL_WAIT_MS = 150_000;
// 完了の通知のために足した本文の読み取りを待つ上限。header の後に本文が終わらない応答で、送り直し・案内・記録を止めない。
export const ORDER_NOTIFY_BODY_WAIT_MS = 3_000;

// retryIndex 回目 (0 始まり) の自動の送り直しの、枠を見る前の待ち時間。上限を超えていたら null (もう送り直さない)。
// lastStatus = 直前の失敗の HTTP status (fetch が投げたときは null)。
export function orderNotifyAutoRetryBaseDelayMs(retryIndex: number, lastStatus: number | null): number | null {
  if (retryIndex >= ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS.length) return null;
  // 429 = 枠を使い切っている。窓が空くまで待つ。
  if (lastStatus === 429) return ORDER_NOTIFY_RATE_WINDOW_MS;
  return ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS[retryIndex];
}

// 枠の確かめ: いま送ると直近 61 秒の送信が 5 回を超えるなら、あと何 ms 待てばよいか (待たなくてよければ 0)。
// sentAtMs = この支払いでこの画面が送った時刻の全部 (順は問わない)。新しい方から 5 番目の送信が窓の外に出る
// (その送信から 61 秒たつ) まで待つ。hook は、送る直前にこれを呼び直す (待っている間にほかの送信が増えることがある)。
export function orderNotifyQuotaWaitMs(sentAtMs: readonly number[], nowMs: number): number {
  if (sentAtMs.length < ORDER_NOTIFY_RATE_LIMIT) return 0;
  const fifthNewest = [...sentAtMs].sort((a, b) => b - a)[ORDER_NOTIFY_RATE_LIMIT - 1];
  return Math.max(0, fifthNewest + ORDER_NOTIFY_RATE_WINDOW_MS - nowMs);
}

// server が応答の JSON の `error` に入れる語の全部: app/api/order/notify/route.ts の fail(…) と、route がそのまま返す
// on-chain の検証の理由 (lib/feeVerify.ts の FeeVerifyResult の reason)。route を変えたらここも直す
// (tests/lib/orderNotifyRetry.test.ts が、2 つの file の source と突き合わせる)。
export const ORDER_NOTIFY_SERVER_ERRORS: readonly string[] = [
  'amount_too_low',
  'handle_not_found',
  'handle_required',
  'internal_error',
  'invalid_body',
  'invalid_chain',
  'invalid_handle',
  'invalid_json',
  'invalid_merchant',
  'invalid_tx',
  'kv_error',
  'kv_required',
  'kv_unavailable',
  'merchant_mismatch',
  'no_matching_transfer',
  'not_found',
  'order_binding_mismatch',
  'payload_too_large',
  'processing',
  'rate_limited',
  'reserved_order',
  'rpc_error',
  'storage_unavailable',
  'tx_not_found',
  'tx_reverted',
  'tx_too_old',
  'unexpected_transfer',
  'unsupported_chain',
  'unsupported_token',
];

// 応答の JSON の `error` を記録 (Sentry) に載せてよいか。載せるのは server が決めた語 (上の列挙) だけ。
// 中継やほかの server が返す任意の文字列は、形が語に似ていても載せない (undefined = 欄ごと出さない)。
export function orderNotifyServerErrorForLog(error: unknown): string | undefined {
  return typeof error === 'string' && ORDER_NOTIFY_SERVER_ERRORS.includes(error) ? error : undefined;
}
