#!/usr/bin/env node
// testnet 専用: a1 利用料 E2E の「前月シード」を Upstash REST 経由で正しく投入するヘルパー。
// 手動 redis CLI で起きがちな JSON の quote 壊れ / アドレス大文字小文字ミスを回避する。
//
// 使い方 (Node 20+):
//   node --env-file=.env.local scripts/seed-billing-testnet.mjs            # 当月キーから店主を自動検出
//   node --env-file=.env.local scripts/seed-billing-testnet.mjs 0xMerchant # 店主を明示
//
// 何をするか:
//   - 前月 (previousPeriod) の meter:{前月}:{merchant} に 10,000 JPYC の中継1件を投入 (= 利用料 100 JPYC)
//   - billing:merchants:{前月} に店主を追加 (admin 照合用の索引)
//   - LLEN / LRANGE で結果を表示
// 店主 merchant は **小文字**に正規化して投入する (コードは小文字キーで引くため)。

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!KV_URL || !KV_TOKEN) {
  console.error(
    'KV_REST_API_URL / KV_REST_API_TOKEN が未設定です。`node --env-file=.env.local scripts/seed-billing-testnet.mjs` のように実行してください。',
  );
  process.exit(1);
}

async function cmd(...args) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${args[0]} failed: ${json.error}`);
  return json.result;
}

function period(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const now = new Date();
const curPeriod = period(now);
const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // 当月1日の前日=前月
const prevPeriod = period(prevDate);
const tsMid = Date.UTC(
  prevDate.getUTCFullYear(),
  prevDate.getUTCMonth(),
  15,
); // 前月中旬のタイムスタンプ (計上月はキーで決まるので参考値)

const VOLUME_WEI = (10000n * 10n ** 18n).toString(); // 10,000 JPYC → 利用料 100 JPYC

let merchant = (process.argv[2] || '').trim().toLowerCase();

const run = async () => {
  if (!merchant) {
    const keys = await cmd('KEYS', `meter:${curPeriod}:*`);
    if (!keys || keys.length === 0) {
      console.error(
        `当月キー meter:${curPeriod}:* が見つかりません (Phase 1 のガスレス決済をまず実行するか、店主アドレスを引数で指定してください)。`,
      );
      process.exit(1);
    }
    if (keys.length > 1) {
      console.error(
        `当月キーが複数あります。店主アドレスを引数で指定してください:\n  ${keys.join('\n  ')}`,
      );
      process.exit(1);
    }
    merchant = keys[0].split(':').pop().toLowerCase();
    console.log(`店主を自動検出: ${merchant} (当月キー ${keys[0]} より)`);
  }

  const meterKey = `meter:${prevPeriod}:${merchant}`;
  const indexKey = `billing:merchants:${prevPeriod}`;
  const event = JSON.stringify({ v: VOLUME_WEI, c: 80002, t: tsMid });

  await cmd('DEL', meterKey); // 既存の壊れた seed を掃除して冪等に
  await cmd('LPUSH', meterKey, event);
  await cmd('LPUSH', indexKey, merchant);

  const len = await cmd('LLEN', meterKey);
  const vals = await cmd('LRANGE', meterKey, 0, -1);
  console.log(`✅ seeded ${meterKey}`);
  console.log(`   LLEN = ${len}`);
  console.log(`   value = ${vals[0]}`);
  console.log(`   index ${indexKey} に ${merchant} を追加`);
  console.log(
    `→ /api/billing/invoice の due.feeWei が 100000000000000000000 (=100 JPYC) になり、/billing に支払いボタンが出ます。`,
  );
};

run().catch((e) => {
  console.error('seed 失敗:', e.message);
  process.exit(1);
});
