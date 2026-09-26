// OpenPay Agent の North Star = 「月間の外部 JPYC Agent 購入者数」を、x402 settle 台帳
// (lib/x402/settleLedger.ts が KV に残す 1 行/settle) を読むだけで出す運営スクリプト。
// 初回購入と「初回から 7 日以内の 2 回目」も同じ台帳から出す。管理 API/画面は作らない。
//
// 使い方 (creds は scripts/settle-ledger-report.mjs と同じ・読み取りのみ):
//   read -s KV_REST_API_TOKEN && export KV_REST_API_TOKEN
//   export KV_REST_API_URL=https://xxxx.upstash.io
//   node scripts/agent-north-star-report.mjs            # 今月+先月
//   node scripts/agent-north-star-report.mjs 2026-10    # 指定月
//   node scripts/agent-north-star-report.mjs 2026-10 --json
//
// 数え方 (外部提案の裁定 2026-09-26):
//   - 対象 = JPYC facilitator の settle (source=jpyc-facilitator。source の無い古い行は asset=JPYC)。
//   - Agent 購入 = resource の pathname が /api/paid/hosted/ で始まらないもの。hosted は Store で人が買う
//     デジタル商品なので「参考: Store」として別に数える。
//   - 外部 = payer が自社ウォレットの公開一覧 (lib/firstPartyWallets.json) にも非公開一覧にも無いもの。
//     非公開一覧 = 環境変数 FIRST_PARTY_PRIVATE_WALLETS_FILE のパス、無ければ plans/first-party-private-wallets.json
//     (plans/ は gitignore 済み)。運営者個人のウォレットを公開リポジトリに載せないための分離で、形式は公開一覧と
//     同じ [{ "address": "0x…", "note": "…" }]。見つからなければ警告を出す (運営者が外部として数えられうる)。
//   - 初回 = 台帳の開始月 (LEDGER_START) 以降で、その payer の最初の Agent 購入。
//   - 7 日以内の再購入 = 初回から 7 日 (168 時間) 以内に 2 回目の Agent 購入があること。初回から 7 日が
//     経っていなければ「判定中」。初回の月に数える。
//
// ⚠️ 台帳は「server が観測できた settle 成功」のヒントで、KV 障害時は欠損しうる。決済の真実はオンチェーン。

import { readFileSync } from 'node:fs';
import { monthOf } from './lib/month-of.mjs';
import { createReportKv } from './lib/report-kv.mjs';

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN を export してください (ヘッダーコメント参照)');
  process.exit(1);
}

// settle 台帳の記録開始月 (#499)。これより前の月は読まない。
const LEDGER_START = '2026-09';
const REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HOSTED_PREFIX = '/api/paid/hosted/';

const publicList = JSON.parse(readFileSync(new URL('../lib/firstPartyWallets.json', import.meta.url), 'utf8'));
const privatePath = process.env.FIRST_PARTY_PRIVATE_WALLETS_FILE
  || new URL('../plans/first-party-private-wallets.json', import.meta.url);
let privateList = null;
try {
  privateList = JSON.parse(readFileSync(privatePath, 'utf8'));
} catch (error) {
  // ファイルが無いことだけを「未読込」として扱う。壊れた JSON は黙って外部扱いにせず落とす。
  if (error?.code !== 'ENOENT') throw error;
}
const firstParty = new Set(
  [...publicList, ...(privateList ?? [])].map(({ address }) => String(address).toLowerCase()),
);

const kv = createReportKv({ url, token });

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const monthArgs = args.filter((a) => /^\d{4}-\d{2}$/.test(a));
const months = monthArgs.length > 0 ? monthArgs : [monthOf(0), monthOf(-1)];

// 初回判定のため、台帳開始月から要求された最後の月までを古い順にすべて読む。
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
const lastMonth = [...months].sort().at(-1);
const history = lastMonth >= LEDGER_START ? monthsBetween(LEDGER_START, lastMonth) : [];

const pathOf = (resource) => {
  try {
    return new URL(resource).pathname;
  } catch {
    return resource || '(unknown)';
  }
};
const isJpyc = (r) => r.source === 'jpyc-facilitator' || (r.source == null && r.asset === 'JPYC');
const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

const rows = [];
for (const month of history) {
  const raw = (await kv(['LRANGE', `x402:settle:ledger:${month}`, '0', '-1'])) ?? [];
  for (const s of raw) {
    let r;
    try {
      r = JSON.parse(s);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object' || !isJpyc(r)) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    rows.push({
      at,
      month: new Date(at).toISOString().slice(0, 7),
      payer: r.payer ? String(r.payer).toLowerCase() : null,
      path: pathOf(r.resource),
    });
  }
}
rows.sort((a, b) => a.at - b.at);

const agentRows = rows.filter((r) => !r.path.startsWith(HOSTED_PREFIX));
const storeRows = rows.filter((r) => r.path.startsWith(HOSTED_PREFIX));
const isExternal = (r) => r.payer !== null && !firstParty.has(r.payer);

// payer ごとの全期間の外部 Agent 購入 (時刻順)。
const byPayer = new Map();
for (const r of agentRows.filter(isExternal)) {
  const list = byPayer.get(r.payer) ?? [];
  list.push(r);
  byPayer.set(r.payer, list);
}
const now = Date.now();
function repeatStatus(list) {
  const first = list[0].at;
  if (list.some((r) => r.at > first && r.at - first <= REPEAT_WINDOW_MS)) return 'yes';
  return now - first < REPEAT_WINDOW_MS ? 'pending' : 'no';
}

const reports = months.map((month) => {
  if (month < LEDGER_START) return { month, beforeLedger: true };
  const inMonth = (r) => r.month === month;
  const agentMonth = agentRows.filter(inMonth);
  const buyers = [...new Set(agentMonth.filter(isExternal).map((r) => r.payer))].map((payer) => {
    const all = byPayer.get(payer);
    const firstAt = all[0].at;
    const firstThisMonth = new Date(firstAt).toISOString().slice(0, 7) === month;
    const monthRows = all.filter(inMonth);
    return {
      payer,
      firstAt: new Date(firstAt).toISOString(),
      firstThisMonth,
      settlesThisMonth: monthRows.length,
      repeat7d: firstThisMonth ? repeatStatus(all) : null,
      resources: [...new Set(monthRows.map((r) => r.path))],
    };
  });
  const firstTimers = buyers.filter((b) => b.firstThisMonth);
  const storeMonth = storeRows.filter(inMonth);
  return {
    month,
    northStar: buyers.length,
    firstTimers: firstTimers.length,
    repeat7d: firstTimers.filter((b) => b.repeat7d === 'yes').length,
    repeat7dPending: firstTimers.filter((b) => b.repeat7d === 'pending').length,
    agentSettles: {
      external: agentMonth.filter(isExternal).length,
      firstParty: agentMonth.filter((r) => r.payer !== null && firstParty.has(r.payer)).length,
      unknownPayer: agentMonth.filter((r) => r.payer === null).length,
    },
    store: {
      externalBuyers: new Set(storeMonth.filter(isExternal).map((r) => r.payer)).size,
      externalSettles: storeMonth.filter(isExternal).length,
    },
    buyers,
  };
});

if (asJson) {
  console.log(JSON.stringify({
    ledgerStart: LEDGER_START,
    privateListLoaded: privateList !== null,
    privateListCount: privateList?.length ?? 0,
    reports,
  }, null, 1));
} else {
  console.log('OpenPay Agent North Star — 外部 JPYC Agent 購入者 (x402 settle 台帳・UTC 月・server 観測範囲)');
  console.log(privateList !== null
    ? `非公開の自社ウォレット一覧: ${privateList.length} 件を除外に使用`
    : `⚠ 非公開の自社ウォレット一覧が見つかりません (${privatePath}) — 運営者のウォレットが外部として数えられる可能性があります`);
  const repeatLabel = { yes: 'あり', no: 'なし', pending: '判定中' };
  for (const r of reports) {
    console.log(`\n== ${r.month} ==`);
    if (r.beforeLedger) {
      console.log(`  (台帳の記録開始 ${LEDGER_START} より前)`);
      continue;
    }
    console.log(`  North Star (外部 JPYC Agent 購入者): ${r.northStar} 人`);
    console.log(`    うち初回: ${r.firstTimers} 人 / 初回から 7 日以内の再購入: ${r.repeat7d} 人 (判定中 ${r.repeat7dPending} 人)`);
    console.log(`  Agent 購入 settle: 外部 ${r.agentSettles.external} 件 / 自社 ${r.agentSettles.firstParty} 件 / payer 不明 ${r.agentSettles.unknownPayer} 件`);
    console.log(`  参考 Store (人の購入): 外部購入者 ${r.store.externalBuyers} 人 / ${r.store.externalSettles} 件`);
    if (r.buyers.length === 0) continue;
    console.log('  -- 外部 Agent 購入者 --');
    for (const b of r.buyers) {
      const repeat = b.firstThisMonth ? `7 日内再購入 ${repeatLabel[b.repeat7d]}` : '初回は前月以前';
      console.log(`    ${short(b.payer)}  初回 ${b.firstAt.slice(0, 10)}  当月 ${b.settlesThisMonth} 件  ${repeat}  ${b.resources.join(', ')}`);
    }
  }
  console.log('');
}
