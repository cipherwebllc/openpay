#!/usr/bin/env node
// CI 用 npm audit gate。`npm audit --audit-level=moderate` の代替。
//
// 動機: 一部の MODERATE / HIGH severity advisory は upstream に fix が無く、
// code path 上到達性が低いため accepted risk として扱う必要がある
// (docs/DEPLOY_CHECKLIST.md §7 参照)。素の `npm audit --audit-level=moderate`
// は受容済とそれ以外を区別できず、CI を恒常的に red にしてしまい新規脆弱性
// との区別が不能になる。
//
// 本スクリプトは:
//   1. `npm audit --omit=dev --json` で production 依存の脆弱性を取得
//   2. MODERATE / HIGH / CRITICAL を GHSA URL (= advisory ID) で同定
//   3. 下記 ALLOWED_ADVISORIES の key と一致するものは accepted として log のみ
//   4. unaccepted な MODERATE+ が 1 件でもあれば exit 1
//
// LOW は CI gate 対象外 (検出はするが pass)。LOW 単体での実害が想定しづらく、
// allowlist 維持コストが gating の便益を上回るため。
//
// 受容済 advisory の追加/削除は **必ず** docs/DEPLOY_CHECKLIST.md §7 の更新と
// 同期させること。本ファイルは監査 trail として diff レビュー対象。

import { spawnSync } from 'node:child_process';

// ────────────────────────────────────────────────────────────────────
// 受容済 advisory リスト (GHSA ID → 受容理由 + docs ref)
// ────────────────────────────────────────────────────────────────────
const ALLOWED_ADVISORIES = {
  // 解決済 advisory (upstream fix で no longer detected):
  // - GHSA-qjx8-664m-686j (js-cookie) — @segment/analytics-next が js-cookie>=3.0.6 採用 (2026-05 頃)
  // - GHSA-58qx-3vcg-4xpx (ws) — viem が ws>=8.20.1 に bump
// - GHSA-8988-4f7v-96qf (@opentelemetry/core) — @sentry/nextjs 10.53.2+ が otel core>=2.8.0 を採用 (2026-07-22 npm update で解消)
  // 過去の受容理由は git log scripts/audit-gate.mjs で参照可。
  'GHSA-qx2v-qp2m-jg93': {
    pkg: 'postcss',
    summary: 'PostCSS XSS via Unescaped </style> in CSS Stringify Output (postcss<8.5.10)',
    chain: 'next@15.5.18 → postcss@8.4.31',
    reason:
      'postcss は Next.js の Tailwind / CSS build pipeline 内でビルド時にのみ動作。CSS の入力は OpenPay 自身のソース (app/*, components/*, Tailwind config) のみで、ユーザ入力が postcss に流れる経路は無い。stringify 出力は静的 _next/static/css に書き出され、ランタイムでブラウザは生成済 CSS を読み込むだけ。XSS の attacker-controlled input chain が存在しない。',
    docRef: 'docs/DEPLOY_CHECKLIST.md §7.2',
    reviewTriggers: [
      'Next.js が postcss>=8.5.10 に bump',
      'ユーザ入力を CSS-in-JS / runtime CSS で受ける機能を追加',
      'GHSA-qx2v-qp2m-jg93 に build-time exploit PoC 公開',
    ],
  },
  'GHSA-w5hq-g745-h8pq': {
    pkg: 'uuid',
    summary: 'uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided (uuid<11.1.1)',
    chain:
      '@metamask/utils → uuid@9.0.1 / jayson → uuid@8.3.2 (+ 他 transitive)',
    reason:
      '脆弱な API は v3 / v5 / v6 (namespace ベース UUID) を buf 引数付きで呼び出した時のみ trigger。OpenPay 直接の uuid 呼び出しは無く、transitive deps (@metamask/utils 等) は内部で v4 (random) を引数なしで呼ぶのみ。buf 引数を取る v3/v5/v6 経路は依存ツリー上で reachable でない。',
    docRef: 'docs/DEPLOY_CHECKLIST.md §7.3',
    reviewTriggers: [
      '@metamask/utils が uuid>=11.1.1 に bump',
      'OpenPay 自身が uuid を direct dependency 化',
      'GHSA-w5hq-g745-h8pq に v4 API も含む拡張 advisory 出現',
    ],
  },
  'GHSA-96hv-2xvq-fx4p': {
    pkg: 'ws',
    summary:
      'ws: Memory exhaustion DoS from tiny fragments and data chunks (fix 未リリース・ws@8.21.0 最新も影響範囲)',
    chain: '@reown/appkit / @walletconnect/* / viem → ws (websocket client)',
    reason:
      'ws は OpenPay では WalletConnect リレー / RPC subscription の websocket **client** として動作し、ws **server** は本 codebase で一切起動しない。本 advisory の DoS は ws を server として動かし攻撃者が極小 fragment / data chunk を送りつけメモリを枯渇させる経路で、client 用途では到達しない。加えて 2026-06 時点で upstream に修正版が無く (最新 8.21.0 も影響範囲)、override での upgrade では解消できないため accepted risk とする。',
    docRef: 'docs/DEPLOY_CHECKLIST.md §7.5',
    reviewTriggers: [
      'ws が本 advisory の patched 版をリリース (8.21.0 超で fix 済) → override で bump',
      'OpenPay が ws を server mode で利用する機能を追加 (webhook server 等)',
      'GHSA-96hv-2xvq-fx4p に client-side exploit PoC 公開',
    ],
  },
  'GHSA-f88m-g3jw-g9cj': {
    pkg: 'sharp',
    summary:
      'sharp inherited vulnerabilities in libvips: CVE-2026-33327/33328/35590/35591 (sharp<0.35.0)',
    chain: 'next (optionalDependencies sharp ^0.34.3) → sharp → libvips',
    reason:
      'libvips の脆弱性は不正な画像ファイルの解析経路で trigger。OpenPay の next/image は next.config.mjs に images.remotePatterns/domains が無く外部 URL 画像を最適化できないため、sharp が処理するのはリポ内静的アセット (トークン/チェーンロゴ・LP 画像) のみ = 攻撃者制御の画像が libvips に到達する経路が無い。ユーザ提供のアバター等は素の <img> 直リンクで sharp を通らない。修正版 sharp 0.35 は next の ^0.34 range 外で、native module の override は到達性ゼロの脆弱性に対しリスク不相応 → next 側の bump 待ち accepted risk とする。',
    docRef: 'docs/DEPLOY_CHECKLIST.md §7.8',
    reviewTriggers: [
      'next が sharp>=0.35 を含む版へ更新 → 通常の npm update で解消し allowlist 削除',
      'next.config.mjs に images.remotePatterns / domains 等の remote 画像最適化を導入 (到達性が変わるため即再評価)',
      'GHSA-f88m-g3jw-g9cj に next/image 経由の exploit PoC 公開',
    ],
  },
};

// CI gate 対象 severity。LOW は監視対象外 (Section 1 のコメント参照)。
const GATED_SEVERITIES = new Set(['moderate', 'high', 'critical']);

// ────────────────────────────────────────────────────────────────────
// 1. npm audit の JSON 取得
// ────────────────────────────────────────────────────────────────────
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
// npm audit は脆弱性が見つかると exit 1 を返すが、stdout は valid JSON のため
// status を見ず JSON.parse する。stdout が空 = npm 自体の error 状態。
if (!audit.stdout) {
  console.error('audit-gate: `npm audit` produced no stdout');
  console.error(audit.stderr);
  process.exit(2);
}
const data = JSON.parse(audit.stdout);

// ────────────────────────────────────────────────────────────────────
// 2. GATED_SEVERITIES (moderate / high / critical) を GHSA URL で集約
//   info.via には string (= 他の脆弱 pkg 名) と object (= 実 advisory) が混在。
//   object のみを抽出し、advisory URL を unique key として dedup する。
//   1 advisory が複数 pkg に propagate する設計のため、影響 pkg を Set で集約。
// ────────────────────────────────────────────────────────────────────
/** @type {Map<string, { ghsaId: string, name: string, title: string, severity: string, url: string, packages: Set<string> }>} */
const advisories = new Map();
for (const [pkgName, info] of Object.entries(data.vulnerabilities ?? {})) {
  if (!GATED_SEVERITIES.has(info.severity)) continue;
  for (const via of info.via ?? []) {
    if (typeof via !== 'object' || via === null) continue;
    if (!GATED_SEVERITIES.has(via.severity)) continue;
    if (!via.url) continue;
    const ghsaId = via.url.split('/').pop();
    if (!advisories.has(via.url)) {
      advisories.set(via.url, {
        ghsaId,
        name: via.name,
        title: via.title,
        severity: via.severity,
        url: via.url,
        packages: new Set(),
      });
    }
    advisories.get(via.url).packages.add(pkgName);
  }
}

// ────────────────────────────────────────────────────────────────────
// 3. 受容済 / 未受容に分類
// ────────────────────────────────────────────────────────────────────
const accepted = [];
const unaccepted = [];
for (const entry of advisories.values()) {
  if (ALLOWED_ADVISORIES[entry.ghsaId]) {
    accepted.push({ ...entry, allow: ALLOWED_ADVISORIES[entry.ghsaId] });
  } else {
    unaccepted.push(entry);
  }
}

// stale = allowlist にあるが現在 npm audit に出ない = upstream で fix された signal
const detectedIds = new Set([...advisories.values()].map((a) => a.ghsaId));
const stale = Object.keys(ALLOWED_ADVISORIES).filter((id) => !detectedIds.has(id));

// ────────────────────────────────────────────────────────────────────
// 4. report 出力
// ────────────────────────────────────────────────────────────────────
console.log(
  `audit-gate: MODERATE+ advisories detected: ${advisories.size} (accepted: ${accepted.length}, unaccepted: ${unaccepted.length}, stale-allowlist: ${stale.length})`,
);

if (accepted.length > 0) {
  console.log('\n--- Accepted (per allowlist) ---');
  for (const a of accepted) {
    console.log(`  [${a.severity.toUpperCase()}] ${a.ghsaId} ${a.name}`);
    console.log(`    title:    ${a.title}`);
    console.log(`    packages: ${[...a.packages].sort().join(', ')}`);
    console.log(`    reason:   ${a.allow.reason}`);
    console.log(`    docRef:   ${a.allow.docRef}`);
  }
}

if (unaccepted.length > 0) {
  console.log('\n--- UNACCEPTED (CI gate failure) ---');
  for (const u of unaccepted) {
    console.log(`  [${u.severity.toUpperCase()}] ${u.ghsaId} ${u.name}`);
    console.log(`    title:    ${u.title}`);
    console.log(`    packages: ${[...u.packages].sort().join(', ')}`);
    console.log(`    url:      ${u.url}`);
  }
  console.log('\nAction:');
  console.log('  1. Assess advisory in docs/DEPLOY_CHECKLIST.md §7');
  console.log(
    '  2. If accepted, add to scripts/audit-gate.mjs ALLOWED_ADVISORIES (with reason + docRef)',
  );
  console.log('  3. Otherwise upgrade dependency or swap');
  process.exit(1);
}

if (stale.length > 0) {
  console.log('\n--- Stale allowlist entries (upstream fix candidate) ---');
  for (const id of stale) {
    const e = ALLOWED_ADVISORIES[id];
    console.log(`  ${id} ${e.pkg}: ${e.summary}`);
    console.log(`    (no longer detected; consider removing from allowlist)`);
  }
  console.log(
    '\n  (stale entries do not fail CI, but indicate upstream fix and allowlist cleanup opportunity)',
  );
}

console.log('\naudit-gate: OK');
