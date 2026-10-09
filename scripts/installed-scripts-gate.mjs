#!/usr/bin/env node
// CI 用 install-time script の実体検査。npm ci の**直後**に node_modules を走査し、install 時に
// 任意コードを走らせるパッケージ (package.json の preinstall / install / postinstall、link の prepare、
// binding.gyp による暗黙の `node-gyp rebuild`) が scripts/lib/installScriptAllowlist.mjs の名前以外に
// あれば fail する (CLAUDE.md 掟 16・第 7 回レビュー E4 / user 裁定 R4・PR #778 Codex レビュー 3)。
//
// なぜ lockfile の検査 (scripts/lockfile-gate.mjs) に加えて要るか:
//   - hasInstallScript は npm が lockfile に書くフラグで、binding.gyp だけのパッケージ (npm が install script
//     `node-gyp rebuild` を補う)・bundled 依存の実体・link (workspace) の prepare はフラグに出ない。
//   - 手で編集した lockfile はフラグを消せる。
// 実行前に lockfile だけで知る手段が無いので、これは**防止ではなく検出**。install script は既に走った後だが、
// allowlist 外の名前が 1 件でもあれば job を赤にして merge を止める (R4 の裁定 =「CI で検出」の範囲)。
// 手で編集された lockfile (フラグが消える diff) は PR の diff レビューで見る。
//
// 使い方: node scripts/installed-scripts-gate.mjs <node_modules dir> [...]
//   例: node scripts/installed-scripts-gate.mjs node_modules
//       node scripts/installed-scripts-gate.mjs tools/lighthouse/node_modules
// 判定: ディレクトリ名から導いた名前 (@scope/name) が allowlist にあり、package.json の name も一致するときだけ許容。
// 依存は Node 標準 API のみ (このゲート自体が新規依存を持つのは本末転倒のため)。

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { INSTALL_SCRIPT_ALLOWLIST } from './lib/installScriptAllowlist.mjs';

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

function readManifest(dir) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 壊れた package.json は npm も読めないが、script の有無が判定できない実体を「無し」にはしない。
    return { __unreadable: true };
  }
}

/** install 時に走る script の種類 (無ければ空配列)。 */
function installTriggers(dir, manifest, linked) {
  const scripts = manifest.scripts !== null && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const triggers = INSTALL_HOOKS.filter((hook) => Object.hasOwn(scripts, hook));
  // npm は link / workspace の依存に対して prepare も走らせる (registry から取る tarball では走らない)。
  if (linked && Object.hasOwn(scripts, 'prepare')) triggers.push('prepare');
  // binding.gyp があり install / preinstall が無いとき npm は `node-gyp rebuild` を install script として補う。
  if (existsSync(join(dir, 'binding.gyp'))) triggers.push('binding.gyp (implicit node-gyp rebuild)');
  return triggers;
}

/** node_modules 直下 (と @scope 配下) のパッケージ dir を列挙する。dot entry (.bin 等) は除く。 */
function listPackageDirs(nodeModules) {
  const out = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      if (!safeIsDir(dir)) continue;
      for (const inner of readdirSync(dir, { withFileTypes: true })) {
        if (inner.name.startsWith('.')) continue;
        const innerDir = join(dir, inner.name);
        if (safeIsDir(innerDir)) out.push({ dir: innerDir, name: `${entry.name}/${inner.name}` });
      }
    } else if (safeIsDir(dir)) {
      out.push({ dir, name: entry.name });
    }
  }
  return out;
}

function safeIsDir(path) {
  try {
    return lstatSync(path).isDirectory() || (lstatSync(path).isSymbolicLink() && existsSync(path));
  } catch {
    return false;
  }
}

function scan(nodeModules, state) {
  let real;
  try {
    real = realpathSync(nodeModules);
  } catch {
    return;
  }
  // link (workspace) の node_modules が互いを指すループを止める。
  if (state.visited.has(real)) return;
  state.visited.add(real);
  for (const { dir, name } of listPackageDirs(nodeModules)) {
    const linked = lstatSync(dir).isSymbolicLink();
    const manifest = readManifest(dir);
    const shown = relative(process.cwd(), dir).split(sep).join('/');
    if (manifest === null) continue; // package.json の無い dir (キャッシュ等) は npm の package ではない
    state.scanned++;
    if (manifest.__unreadable) {
      state.failures.push(`${shown}: package.json cannot be parsed, install-time scripts unknown`);
    } else {
      const triggers = installTriggers(dir, manifest, linked);
      if (triggers.length > 0) {
        const allowed = Object.hasOwn(INSTALL_SCRIPT_ALLOWLIST, name);
        const manifestName = typeof manifest.name === 'string' ? manifest.name : '(no name)';
        if (allowed && manifestName === name) {
          state.allowed.push(`${shown} [${triggers.join(', ')}]`);
          state.allowedNames.add(name);
        } else if (allowed) {
          state.failures.push(
            `${shown}: directory name ${name} is allowlisted but package.json names ${manifestName} ` +
              `[${triggers.join(', ')}] — an alias cannot borrow an allowlisted name`,
          );
        } else {
          state.failures.push(
            `${shown}: ${manifestName} runs install-time scripts [${triggers.join(', ')}] and is not in INSTALL_SCRIPT_ALLOWLIST ` +
              '(scripts/lib/installScriptAllowlist.mjs). Review the package before adding it (CLAUDE.md 掟 16).',
          );
        }
      }
    }
    const nested = join(dir, 'node_modules');
    if (existsSync(nested)) scan(nested, state);
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('installed-scripts-gate: usage: node scripts/installed-scripts-gate.mjs <node_modules dir> [...]');
  process.exit(1);
}

let bad = 0;
const allowedNames = new Set();
for (const root of roots) {
  if (!safeIsDir(root)) {
    // npm ci の直後に無いのは install の失敗か指定ミス。検査対象ゼロの偽成功にしない。
    console.error(`NG ${root}: not a directory (run this right after npm ci)`);
    bad++;
    continue;
  }
  const state = { visited: new Set(), scanned: 0, allowed: [], allowedNames, failures: [] };
  scan(root, state);
  for (const line of state.failures) console.error(`NG ${line}`);
  bad += state.failures.length;
  console.log(`OK ${root}: ${state.scanned} packages scanned, ${state.allowed.length} with allowlisted install-time scripts`);
  for (const line of state.allowed) console.log(`   ${line}`);
}

if (bad > 0) {
  console.error(
    `installed-scripts-gate: install-time script を持つ allowlist 外のパッケージ (または未検査の root) が ${bad} 件あります。` +
      '個別確認のうえ scripts/lib/installScriptAllowlist.mjs に追加するか、依存を外してください (CLAUDE.md 掟 16)。',
  );
  process.exit(1);
}
console.log(`installed-scripts-gate: install-time script は allowlist の ${allowedNames.size} 名のみです`);
