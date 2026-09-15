#!/usr/bin/env node
// 運営向け x402 settle 台帳レポート (誰が・どの商品を・いくらで)。
// lib/x402/settleLedger が KV に残す 1 行/settle を読むだけ — 管理 API/画面は作らない。
//
// 使い方 (creds は scripts/metrics-report.mjs と同じ):
//   read -s KV_REST_API_TOKEN && export KV_REST_API_TOKEN
//   export KV_REST_API_URL=https://xxxx.upstash.io
//   node scripts/settle-ledger-report.mjs            # 今月+先月
//   node scripts/settle-ledger-report.mjs 2026-09    # 指定月
//   node scripts/settle-ledger-report.mjs 2026-09 --json   # 生データを JSON で出す
//
// ⚠️ 台帳は「server が観測できた settle 成功」のヒントで、KV 障害時は欠損しうる。
// 決済の真実はオンチェーン (Basescan / Polygonscan)。自社・関係者ウォレット (lib/externalPurchases.ts
// の FIRST_PARTY_WALLETS) は payer 側で印を付ける (外部購入の集計と同じ線引き)。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monthOf } from './lib/month-of.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN を export してください (ヘッダーコメント参照)');
  process.exit(1);
}

// 自社ウォレット一覧は TS の SoT から正規表現で読む (スクリプトは TS を import しない)。
const firstPartySrc = readFileSync(join(root, 'lib/externalPurchases.ts'), 'utf8');
const firstParty = new Set(
  [...firstPartySrc.matchAll(/'(0x[0-9a-f]{40})',\s*\/\//g)].map((m) => m[1].toLowerCase()),
);

async function kv(command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const monthArgs = args.filter((a) => /^\d{4}-\d{2}$/.test(a));
const months = monthArgs.length > 0 ? monthArgs : [monthOf(0), monthOf(-1)];

const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '-');
const pathOf = (resource) => {
  try {
    return new URL(resource).pathname;
  } catch {
    return resource || '(unknown)';
  }
};
const sum = (rows) => rows.reduce((acc, r) => acc + Number(r.amount || 0), 0);

for (const month of months) {
  const raw = (await kv(['LRANGE', `x402:settle:ledger:${month}`, '0', '-1'])) ?? [];
  const rows = raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (asJson) {
    console.log(JSON.stringify({ month, rows }, null, 1));
    continue;
  }
  console.log(`\n== ${month} (UTC 月・server 観測範囲・${rows.length} settle) ==`);
  if (rows.length === 0) continue;

  const external = rows.filter((r) => !firstParty.has(String(r.payer || '').toLowerCase()));
  console.log(`  外部 payer の settle: ${external.length} / ${rows.length}`);

  console.log('\n  -- 商品別 (外部のみ) --');
  const byResource = new Map();
  for (const r of external) {
    const k = `${r.asset} ${pathOf(r.resource)}`;
    const cur = byResource.get(k) ?? { count: 0, payers: new Set(), rows: [] };
    cur.count += 1;
    cur.payers.add(String(r.payer || '').toLowerCase());
    cur.rows.push(r);
    byResource.set(k, cur);
  }
  for (const [k, v] of [...byResource.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${String(v.count).padStart(4)} 件  ${v.payers.size} payer  ${sum(v.rows).toFixed(6)}  ${k}`,
    );
  }

  console.log('\n  -- payer 別 (外部のみ) --');
  const byPayer = new Map();
  for (const r of external) {
    const k = String(r.payer || '').toLowerCase();
    const cur = byPayer.get(k) ?? { rows: [], resources: new Set() };
    cur.rows.push(r);
    cur.resources.add(pathOf(r.resource));
    byPayer.set(k, cur);
  }
  for (const [k, v] of [...byPayer.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length)) {
    const first = v.rows[0].at.slice(0, 10);
    const last = v.rows[v.rows.length - 1].at.slice(0, 10);
    console.log(
      `  ${String(v.rows.length).padStart(4)} 件  ${short(k)}  ${first}〜${last}  ${[...v.resources].join(', ')}`,
    );
  }
}
console.log('');
