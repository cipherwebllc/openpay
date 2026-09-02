#!/usr/bin/env node
// testnet 専用: a1 利用料 E2E の「前月シード」を Upstash REST 経由で正しく投入するヘルパー。
// 手動 redis CLI で起きがちな JSON の quote 壊れ / アドレス大文字小文字ミスを回避する。
//
// 使い方 (Node 20+):
//   node --env-file=.env.local scripts/seed-billing-testnet.mjs                    # dry-run (既定・書き込まない)
//   node --env-file=.env.local scripts/seed-billing-testnet.mjs 0xMerchant         # dry-run・店主を明示
//   SEED_TESTNET_OK=1 node --env-file=.env.local scripts/seed-billing-testnet.mjs --apply
//
// 安全装置 (本スクリプトは DEL を含み、誤って本番 KV を指すと計上済みメーターを消すため):
//   - 既定は **dry-run**。実行する KV コマンドを表示するだけで一切書き込まない。
//   - 書き込みには `--apply` と env `SEED_TESTNET_OK=1` の **両方**が必要。
//   - 店主の自動検出は KEYS ではなく SCAN (MATCH + COUNT 100) で行う (本番 KV を止めないため)。
//
// 何をするか (--apply 時):
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

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
let merchant = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();

// KEYS は Upstash/Redis を全キー走査で塞ぐ。SCAN cursor で分割し、
// 誤って本番 KV を指したときでも他リクエストを巻き込まないようにする。
async function scanKeys(pattern) {
  const found = [];
  let cursor = '0';
  do {
    const [next, keys] = await cmd('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(next);
    if (Array.isArray(keys)) found.push(...keys);
  } while (cursor !== '0');
  return [...new Set(found)];
}

const planned = [];
// dry-run では書き込み系コマンドを実行せず、そのまま貼れる形で表示する。
async function mutate(...args_) {
  planned.push(args_.join(' '));
  if (!APPLY) return null;
  return cmd(...args_);
}

const run = async () => {
  if (APPLY && process.env.SEED_TESTNET_OK !== '1') {
    console.error(
      '書き込み (--apply) には env SEED_TESTNET_OK=1 が必要です。testnet の KV を指していることを確認してから ' +
        'SEED_TESTNET_OK=1 を付けて再実行してください (本スクリプトは meter:{前月}:{merchant} を DEL します)。',
    );
    process.exit(1);
  }
  if (!APPLY) {
    console.log('— dry-run (既定): 書き込みは行いません。実行するには SEED_TESTNET_OK=1 と --apply を付けてください。');
  }

  if (!merchant) {
    const keys = await scanKeys(`meter:${curPeriod}:*`);
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

  await mutate('DEL', meterKey); // 既存の壊れた seed を掃除して冪等に
  await mutate('LPUSH', meterKey, event);
  await mutate('LPUSH', indexKey, merchant);

  if (!APPLY) {
    console.log('\n実行される KV コマンド (dry-run・未実行):');
    for (const line of planned) console.log(`   ${line}`);
    console.log(
      `\n→ 実行するには: SEED_TESTNET_OK=1 node --env-file=.env.local scripts/seed-billing-testnet.mjs ${merchant} --apply`,
    );
    return;
  }

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
