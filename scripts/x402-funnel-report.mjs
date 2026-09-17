#!/usr/bin/env node
// x402 購入ファネル (lib/x402/funnel.ts の日次カウンタ) を resource × rail の表で読む運営スクリプト。
//
//   export KV_REST_API_URL=... KV_REST_API_TOKEN=...   (本番 KV・読み取りのみ)
//   node scripts/x402-funnel-report.mjs          # 直近 7 日
//   node scripts/x402-funnel-report.mjs 30       # 直近 30 日
//
// 読み方: challenge は検索クローラの巡回を含む (買い手の数ではない)。「支払いを試みた件数」=
// invalid_payload + verify_failed + conflict + content_error + settle_failed + facilitator_unavailable + settled。
// 成立率 = settled / 支払いを試みた件数。誰が・いくらで買ったかは settle 台帳 (x402:settle:ledger:<月>) を見る。

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('KV_REST_API_URL / KV_REST_API_TOKEN を export してください');
  process.exit(1);
}
const days = Math.max(1, Math.min(180, Number(process.argv[2] ?? 7)));
const STAGES = ['challenge', 'invalid_payload', 'verify_failed', 'conflict', 'content_error', 'settle_failed', 'facilitator_unavailable', 'settled'];

async function kv(command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

const totals = new Map(); // `${path}|${rail}` → { stage: n }
const challenges = new Map(); // path → n (rail 未確定)
for (let i = 0; i < days; i++) {
  const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
  const flat = (await kv(['HGETALL', `x402:funnel:${day}`])) ?? [];
  for (let j = 0; j < flat.length; j += 2) {
    const [stage, rail, ...rest] = String(flat[j]).split('|');
    const path = rest.join('|');
    const n = Number(flat[j + 1]);
    if (rail === 'none') {
      const row = challenges.get(path) ?? {};
      row[stage] = (row[stage] ?? 0) + n;
      challenges.set(path, row);
      continue;
    }
    const key = `${path}|${rail}`;
    const row = totals.get(key) ?? {};
    row[stage] = (row[stage] ?? 0) + n;
    totals.set(key, row);
  }
}

console.log(`x402 funnel — 直近 ${days} 日 (UTC)\n`);
console.log('[支払い前] resource: 402 発行 / 形不正');
for (const [path, row] of [...challenges].sort()) {
  console.log(`  ${path}: challenge ${row.challenge ?? 0} / invalid_payload ${row.invalid_payload ?? 0}`);
}
console.log('\n[支払い後] resource | rail: 成立 / 試行 (成立率) — 内訳');
for (const [key, row] of [...totals].sort()) {
  const attempts = STAGES.filter((s) => s !== 'challenge' && s !== 'invalid_payload').reduce((a, s) => a + (row[s] ?? 0), 0);
  const settled = row.settled ?? 0;
  const rate = attempts ? `${Math.round((settled / attempts) * 100)}%` : '-';
  const detail = STAGES.filter((s) => row[s] && s !== 'settled').map((s) => `${s} ${row[s]}`).join(', ');
  console.log(`  ${key}: ${settled} / ${attempts} (${rate})${detail ? ` — ${detail}` : ''}`);
}
if (!totals.size && !challenges.size) console.log('  (記録なし — 計上開始前か KV 未構成)');
