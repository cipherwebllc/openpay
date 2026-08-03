#!/usr/bin/env node
// Store 掲載インデックス (P2) の backfill。P2 以前に作られた既存商品を
// x402:hosted:store:index (zset・score=updatedAt) へ登録する。
//
// 使い方 (KV creds は env から。.env.local を読む場合は事前に export すること):
//   node scripts/store-index-backfill.mjs           # dry-run (書き込まない)
//   node scripts/store-index-backfill.mjs --apply   # 実書き込み
//
// 安全性: 読み出し + ZADD のみ。商品レコード・購入・content には一切触れない。
// index はヒントであり読出側が商品レコードを再検証するため、余分に入っても無害。

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN を env に設定してください');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

async function redis(cmd) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`KV error: ${body.error}`);
  return body.result;
}

const PRODUCT_KEY_RE = /^x402:hosted:h_[0-9a-f]{32}$/;
const INDEX_KEY = 'x402:hosted:store:index';

let cursor = '0';
const keys = [];
do {
  const [next, batch] = await redis([
    'SCAN',
    cursor,
    'MATCH',
    'x402:hosted:h_*',
    'COUNT',
    '200',
  ]);
  cursor = next;
  for (const key of batch) {
    // content キー (x402:hosted:<id>:content:<rev>) を除外し、商品キーのみ拾う
    if (PRODUCT_KEY_RE.test(key)) keys.push(key);
  }
} while (cursor !== '0');

console.log(`商品キー: ${keys.length} 件`);
let added = 0;
for (const key of keys) {
  const raw = await redis(['GET', key]);
  if (typeof raw !== 'string') continue;
  let product;
  try {
    product = JSON.parse(raw);
  } catch {
    console.warn(`  skip (broken JSON): ${key}`);
    continue;
  }
  const id = product?.id;
  const score = product?.updatedAt ?? product?.createdAt;
  if (typeof id !== 'string' || typeof score !== 'number') {
    console.warn(`  skip (shape): ${key}`);
    continue;
  }
  console.log(
    `  ${apply ? 'ZADD' : '(dry-run) ZADD'} ${id} score=${score} title=${JSON.stringify(
      product.title ?? '',
    )}`,
  );
  if (apply) {
    await redis(['ZADD', INDEX_KEY, String(score), id]);
  }
  added += 1;
}
console.log(
  `${apply ? '登録' : 'dry-run 対象'}: ${added} 件${apply ? '' : ' (--apply で書き込み)'}`,
);
