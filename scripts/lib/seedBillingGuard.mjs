// scripts/seed-billing-testnet.mjs の DEL を「testnet の中身のときだけ」に絞る純関数 (第 8 回レビュー F-3)。
//
// seed は meter:{前月}:{店主} を DEL してから testnet の 1 件 (chainId 80002 = Polygon Amoy) を積み直す。
// 接続先の KV が testnet かは SEED_TESTNET_OK=1 (運用者の自己申告) でしか確かめていなかったので、
// .env.local が本番 KV を指したまま実行すると、本番の relay が書いた店主の前月メーター
// (a1 利用料の課金根拠・監査記録) を消してしまう。本番の relay は中継した chain の chainId を c に書く
// (lib/billingMeter.ts の recordRelayedVolume) ので、80002 以外の行が 1 つでもあれば消さずに止まる。

/** seed が積む行の chainId (Polygon Amoy)。既存の行がすべてこれなら、前回の seed の積み直しとみなす。 */
export const SEED_TESTNET_CHAIN_ID = 80002;

/**
 * `LRANGE meter:{前月}:{店主} 0 -1` の結果を見て、DEL して積み直してよいかを返す。
 * 空 (key が無い) か、全行が JSON で `c === 80002` のときだけ ok。
 * JSON でない行・c が数値の 80002 でない行は testnet の seed だと確かめられないので、blocking に数えて止める。
 */
export function checkSeedMeterReplaceable(rows) {
  // LRANGE の応答が配列でない = 中身を確かめられない。この後が DEL なので、消さない側に倒す。
  if (!Array.isArray(rows)) return { ok: false, total: 0, blocking: [] };
  const blocking = [];
  rows.forEach((raw, index) => {
    const chainId = rowChainId(raw);
    if (chainId !== SEED_TESTNET_CHAIN_ID) blocking.push({ index, chainId });
  });
  return { ok: blocking.length === 0, total: rows.length, blocking };
}

/** blocking の行を「chainId 137 ×2・読めない行 ×1」の形にまとめる (止めたときの表示用)。 */
export function describeBlockingRows(blocking) {
  const counts = new Map();
  for (const { chainId } of blocking) {
    const label = chainId === null ? '読めない行' : `chainId ${chainId}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} ×${n}`).join('・');
}

// 1 行の chainId。数値として読めない行は null (= testnet と確かめられない)。
function rowChainId(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 壊れた行は chain を読めない。例外を外へ出さず「確かめられない行」として止める側に数える。
    return null;
  }
  const chainId = parsed !== null && typeof parsed === 'object' ? parsed.c : undefined;
  return typeof chainId === 'number' && Number.isFinite(chainId) ? chainId : null;
}
