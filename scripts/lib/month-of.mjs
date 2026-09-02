// UTC の「N ヶ月前/後」の YYYY-MM を返す。
//
// scripts/metrics-report.mjs から切り出してテスト可能にした (本体は import 時に KV を
// 叩く top-level await スクリプトなので、そのままでは unit test から import できない)。
//
// 月初 (1日) を基準に構築するのが要点: setUTCMonth(getUTCMonth() + offset) は「日」を
// 保ったまま月だけずらすため、月末 (3/31 で offset=-1 → 2/31) が翌月へ繰り上がり、
// 先月の集計キーを取り違える。
export function monthOf(offset = 0, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
}
