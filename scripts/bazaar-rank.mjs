// CDP x402 Bazaar の検索順位を代表 query で測る (2026-08-23 裁定 P3)。
// 文言・タグ・Schema を「感覚で磨かない」ための実測。CI には入れない (外部依存・順位は品質指標
// = 30 日 calls / payers にも依存するため日々動く)。月次または文言変更後に手動で回し、
// plans/bazaar-rank-baseline.md に転記する。
//
//   node scripts/bazaar-rank.mjs            # 表を表示
//   node scripts/bazaar-rank.mjs --json     # JSON で出力 (記録用)
//
// API: GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=&limit=
//      (認証不要・searchMethod=hybrid・順位 = relevance + quality)

const SEARCH = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';
const OURS = 'open-pay.jp';
const LIMIT = 10;

// 代表 8 query (裁定で固定)。追加するときは末尾に足し、既存は変えない (時系列比較のため)。
const QUERIES = [
  'current JPYC supply',
  'Japanese yen stablecoin supply',
  'check JPYC wallet balance',
  'verify a JPYC payment',
  'recent JPYC transfers',
  'monitor JPYC wallet activity',
  'onchain JPYC data',
  'yen stablecoin transaction history',
];

const asJson = process.argv.includes('--json');
const rows = [];

for (const query of QUERIES) {
  const url = `${SEARCH}?query=${encodeURIComponent(query)}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    rows.push({ query, error: `HTTP ${res.status}` });
    continue;
  }
  const body = await res.json();
  const resources = body.resources ?? [];
  const ours = resources
    .map((r, i) => ({ rank: i + 1, resource: r.resource, calls: r.quality?.l30DaysTotalCalls ?? null }))
    .filter((r) => r.resource.includes(OURS))
    .map((r) => ({ ...r, path: r.resource.replace(/^https:\/\/open-pay\.jp\/api\/paid\//, '') }));
  const top = resources[0];
  rows.push({
    query,
    searchMethod: body.searchMethod,
    ours,
    top1: top
      ? { serviceName: top.serviceName ?? null, resource: top.resource, calls: top.quality?.l30DaysTotalCalls ?? null }
      : null,
  });
}

if (asJson) {
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), limit: LIMIT, rows }, null, 2));
} else {
  console.log(`Bazaar search rank (top ${LIMIT}) — ${new Date().toISOString()}`);
  for (const r of rows) {
    if (r.error) {
      console.log(`  ${r.query.padEnd(36)} | ${r.error}`);
      continue;
    }
    const ours = r.ours.length ? r.ours.map((o) => `#${o.rank} ${o.path}`).join(', ') : `圏外 (top ${LIMIT})`;
    console.log(`  ${r.query.padEnd(36)} | ${ours}`);
    if (!r.ours.length || r.ours[0].rank > 1) {
      console.log(`  ${''.padEnd(36)} |   top1: ${r.top1?.serviceName ?? '-'} ${r.top1?.resource ?? ''} (calls30d ${r.top1?.calls ?? '-'})`);
    }
  }
}
