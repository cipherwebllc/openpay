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
  'GHSA-qjx8-664m-686j': {
    pkg: 'js-cookie',
    summary: 'Per-instance prototype hijack in assign() (cookie-attribute injection)',
    chain:
      '@account-kit/smart-contracts → @account-kit/infra → @account-kit/logging → @segment/analytics-next → js-cookie@3.0.1',
    reason:
      'Alchemy SDK 内部の Segment Analytics 経路にのみ伝播。OpenPay 側から任意 string を Segment.* に流す API は無く、cookie attribute injection の input chain が成立しない。upstream (@segment/analytics-next) が js-cookie@<=3.0.5 を peg しているため fix unavailable。',
    docRef: 'docs/DEPLOY_CHECKLIST.md §7.1',
    reviewTriggers: [
      '@account-kit/smart-contracts major upgrade',
      '@segment/analytics-next で js-cookie>=3.0.6 採用',
      'Alchemy SDK 内 analytics opt-out 機能の提供',
      'GHSA-qjx8-664m-686j に EXPLOITABLE PoC 公開',
    ],
  },
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
  'GHSA-58qx-3vcg-4xpx': {
    pkg: 'ws',
    summary: 'ws: Uninitialized memory disclosure in server-side frame handling (ws>=8.0.0 <8.20.1)',
    chain: 'viem@2.50.3 → ws@8.18.0',
    reason:
      '脆弱なコードパスは ws を SERVER として permessage-deflate 拡張で動作させた時の特定 frame 処理。OpenPay 内の ws は viem の RPC websocket CLIENT (Pimlico / Alchemy RPC への接続) として動作し、server mode を一切使わない。client 側にはこの脆弱性は影響しない。',
    docRef: 'docs/DEPLOY_CHECKLIST.md §7.4',
    reviewTriggers: [
      'viem が ws>=8.20.1 に bump',
      'OpenPay 自身が ws を server mode で利用する機能を追加',
      'GHSA-58qx-3vcg-4xpx に client-side exploit PoC 公開',
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
