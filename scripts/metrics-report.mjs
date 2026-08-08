#!/usr/bin/env node
// 運営向け月次メトリクスレポート (計測レイヤー裁定 2026-08-08 ②)。
// KV (Upstash REST) を直接読むだけ — 管理 API/画面は作らない。
//
// 使い方 (creds の取得手順は Upstash コンソール → REST API。vercel env pull は
// プレースホルダーを返すので不可 — plans/store-marketplace.md の backfill 教訓参照):
//   read -s KV_REST_API_TOKEN && export KV_REST_API_TOKEN
//   export KV_REST_API_URL=https://xxxx.upstash.io
//   node scripts/metrics-report.mjs            # 今月+先月
//   node scripts/metrics-report.mjs 2026-08    # 指定月
//
// ⚠️ 表示されるのは「server が観測できた範囲」: relay/gasless 決済・x402 settle・
// 受注保存・商品購入確定。standard 決済 (お客様 gas 負担の直接送金) は含まれない。

const KINDS = [
  ['relay_jpyc', 'JPYC 決済 (relay/gasless: QR・レジ・注文・チップ)'],
  ['x402_settle', 'x402 settle (AI ストア/有料 API)'],
  ['order', 'モバイル注文 (受注保存)'],
  ['store_purchase', 'デジタル商品 購入確定'],
];
const STORE_INDEX_KEY = 'x402:hosted:store:index';

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN を export してください (ヘッダーコメント参照)');
  process.exit(1);
}

async function kv(command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.result;
}

function monthOf(offset = 0) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
}

const months = process.argv[2] ? [process.argv[2]] : [monthOf(0), monthOf(-1)];

for (const month of months) {
  const keys = KINDS.map(([kind]) => `metrics:${month}:${kind}`);
  const values = await kv(['MGET', ...keys]);
  console.log(`\n== ${month} (UTC 月・server 観測範囲) ==`);
  let total = 0;
  KINDS.forEach(([, label], i) => {
    const n = Number.parseInt(values?.[i] ?? '0', 10) || 0;
    total += n;
    console.log(`  ${String(n).padStart(6)}  ${label}`);
  });
  console.log(`  ${String(total).padStart(6)}  合計 (観測イベント)`);
}

// 在庫系 (現在値): 公開商品数・累計購入数 (per-商品カウンタの合計)
const productIds = await kv(['ZRANGE', STORE_INDEX_KEY, '0', '-1']);
console.log(`\n== 現在値 ==`);
console.log(`  ${String(productIds?.length ?? 0).padStart(6)}  Store 掲載商品数 (index)`);
if (Array.isArray(productIds) && productIds.length > 0) {
  const counts = await kv(['MGET', ...productIds.map((id) => `store:purchases:${id}`)]);
  const sum = (counts ?? []).reduce(
    (acc, v) => acc + (Number.parseInt(v ?? '0', 10) || 0),
    0,
  );
  console.log(`  ${String(sum).padStart(6)}  累計 商品購入数 (掲載中商品・2026-08-08 計測開始)`);
}
console.log('');
