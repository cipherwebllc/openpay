#!/usr/bin/env node
// CI 用 lockfile 取得元 gate。package-lock.json の全依存が公式 npm レジストリ
// (https://registry.npmjs.org) から解決されていることを機械検査する。
//
// 動機 (2026-07-20 採用): AI コーディングエージェントは README/セットアップ手順を
// 信用して依存を追加するため、git URL・独自レジストリ・タイポスクワット経由の
// サプライチェーン汚染が「追加されたコード」より先に混入しうる (掟 15 の依存関係版)。
// 依存の**取得元**を lockfile 単位で固定し、公式レジストリ以外が 1 件でも
// 現れたら CI を fail させる。第三者 linter に依存せず node 標準のみで判定する
// (このゲート自体が新規依存を持つのは本末転倒のため)。
//
// 検査対象: リポ内の全 package-lock.json (root + packages/*)。
// 許容: resolved が https://registry.npmjs.org/ 始まり、または workspace link
// (resolved がリポ内相対 path で link:true か、root package 自身のエントリ)。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_PREFIX = 'https://registry.npmjs.org/';

function collectLockfiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectLockfiles(p, out);
    else if (name === 'package-lock.json') out.push(p);
  }
  return out;
}

const lockfiles = collectLockfiles(process.cwd());
if (lockfiles.length === 0) {
  console.error('lockfile-gate: package-lock.json が見つかりません');
  process.exit(1);
}

let bad = 0;
for (const file of lockfiles) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const packages = lock.packages ?? {};
  for (const [name, pkg] of Object.entries(packages)) {
    if (name === '') continue; // root package 自身
    const resolved = pkg.resolved;
    // workspace link (例: "packages/x402-sdk" を link 参照) は resolved がリポ内
    // 相対 path。https 以外でも link エントリだけは許容する。
    if (pkg.link === true) continue;
    if (resolved === undefined) {
      // npm は bundled/optional 等で resolved を省略することがある。取得元の偽装は
      // resolved を持つエントリで起きるため、省略自体は fail にしない (過剰検出防止)。
      continue;
    }
    if (!resolved.startsWith(ALLOWED_PREFIX)) {
      console.error(`NG ${file}: ${name} -> ${resolved}`);
      bad++;
    }
  }
  console.log(`OK ${file}: ${Object.keys(packages).length - 1} entries checked`);
}

if (bad > 0) {
  console.error(
    `lockfile-gate: 公式 npm レジストリ以外から解決された依存が ${bad} 件あります。` +
      'git URL / 独自レジストリ / http 取得は禁止 (CLAUDE.md 掟 15 の依存関係運用)。',
  );
  process.exit(1);
}
console.log('lockfile-gate: 全 lockfile が公式 npm レジストリのみから解決されています');
