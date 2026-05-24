#!/usr/bin/env node
// 本番環境の operator 設定 (Sentry / Pimlico / Vercel env) が実 active 状態かを
// 外部観測で検証する。コード上の "設定 path 存在" ではなく "実 active か" を見る。
//
// 使い方:
//   node scripts/verify-production-config.mjs               # open-pay.jp + gh CLI
//   node scripts/verify-production-config.mjs https://...   # 任意 base
//
// exit 0 = 全 active、1 = 1 件以上 inactive。

import { spawnSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'https://open-pay.jp';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

// --- (1) Sentry DSN が prod bundle に含まれているか ---
{
  const html = await (await fetch(`${BASE}/ja`)).text();
  const chunks = [
    ...new Set(html.match(/\/_next\/static\/chunks\/[a-z0-9]+-[a-f0-9]+\.js/g) ?? []),
  ];
  let dsnFound = false;
  for (const chunk of chunks.slice(0, 12)) {
    const js = await (await fetch(`${BASE}${chunk}`)).text();
    if (/https:\/\/[a-f0-9]+@o\d+\.ingest\.[a-z]+\.sentry\.io\/\d+/.test(js)) {
      dsnFound = true;
      break;
    }
  }
  record(
    'Sentry DSN (browser、NEXT_PUBLIC_SENTRY_DSN)',
    dsnFound,
    dsnFound
      ? 'JS chunk に DSN literal 検出 (Sentry browser SDK active)'
      : 'JS chunk に DSN 検出されず → Vercel env NEXT_PUBLIC_SENTRY_DSN 未設定。browser 側 logger.warn/error は console のみで Sentry へ送られない',
  );
}

// --- (2) 本番 deploy が live (open-pay.jp が 200) ---
{
  const r = await fetch(`${BASE}/ja`);
  record(
    `本番 base URL alive (${BASE})`,
    r.status === 200,
    `HTTP ${r.status}`,
  );
}

// --- (3) Speed Insights + Analytics script 配信 ---
for (const [name, path] of [
  ['Speed Insights script', '/_vercel/speed-insights/script.js'],
  ['Vercel Analytics script', '/_vercel/insights/script.js'],
]) {
  const r = await fetch(`${BASE}${path}`);
  record(`${name} 配信`, r.status === 200, `HTTP ${r.status}`);
}

// --- (4) /api/log/payment が auth/validation 動作 (POST→400 = validate 経路 alive) ---
{
  const r = await fetch(`${BASE}/api/log/payment`, { method: 'POST' });
  record(
    '/api/log/payment validation alive (空 POST → 400 想定)',
    r.status === 400,
    `HTTP ${r.status} (200/500 なら問題)`,
  );
}

// --- (5) GH Actions Pimlico balance cron が actual check 実行か (skip でないか) ---
//   secrets 設定済の operator なら最新 run log に "balance" / "POL" / "USDC" 等の
//   actual output が出る想定。skip なら "Secrets 未設定" warning のみ。
{
  const r = spawnSync(
    'gh',
    [
      'run',
      'list',
      '--workflow=pimlico-balance.yml',
      '--repo=cipherwebllc/openpay',
      '--limit=1',
      '--json',
      'databaseId',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !r.stdout) {
    record(
      'Pimlico balance cron 実行履歴',
      false,
      `gh CLI 未認証 / repo access 不可 (skipped — operator 手動確認推奨)`,
    );
  } else {
    const runs = JSON.parse(r.stdout);
    const runId = runs[0]?.databaseId;
    if (!runId) {
      record('Pimlico balance cron 実行履歴', false, '直近 run なし');
    } else {
      const log = spawnSync(
        'gh',
        ['run', 'view', String(runId), '--repo=cipherwebllc/openpay', '--log'],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      );
      const isSkip = /Secrets 未設定/.test(log.stdout ?? '');
      record(
        `Pimlico balance cron actual check (最新 run #${runId})`,
        !isSkip,
        isSkip
          ? 'graceful skip — PIMLICO_PAYMASTER_POLYGON / BASE / ALERT_WEBHOOK_URL 未設定。balance 監視ゼロ'
          : '実 balance check 実行済',
      );
    }
  }
}

// --- output ---
console.log('Production config verification:');
let failed = 0;
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗';
  console.log(`  ${mark} ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.ok) failed += 1;
}
console.log('');
if (failed > 0) {
  console.log(`⚠ ${failed}/${checks.length} 件 inactive — 上記詳細を確認`);
  process.exit(1);
}
console.log(`✅ ${checks.length}/${checks.length} 件 active`);
