#!/usr/bin/env node
// CI 用 install-time script の gate (防止)。CI は依存を `npm ci --ignore-scripts` で入れ (preinstall / install /
// postinstall も binding.gyp の暗黙 `node-gyp rebuild` も走らない)、その**直後**にこの script が node_modules の
// 実体を走査する。install 時に任意コードを走らせるパッケージ (package.json の preinstall / install / postinstall、
// link の prepare、binding.gyp) が scripts/lib/installScriptAllowlist.mjs の一覧以外にあれば fail し、通ったときだけ
// `--rebuild` で allowlist の名前を `npm rebuild <names>` して必要な install script を実行する (= 従来の npm ci と
// 同じ結果)。allowlist 外の install script 付きの新規依存は**一度も実行されずに** CI で止まる
// (CLAUDE.md 掟 16・第 7 回レビュー E4 / user 裁定 R4 → PR #778 Codex レビューで検出から防止へ)。
//
// なぜ lockfile の検査 (scripts/lockfile-gate.mjs) に加えて要るか:
//   - hasInstallScript は npm が lockfile に書くフラグで、binding.gyp だけのパッケージ (npm が install script
//     `node-gyp rebuild` を補う)・bundled 依存の実体・link (workspace) の prepare はフラグに出ない。
//   - 手で編集した lockfile はフラグを消せる。実体を見ればどちらも関係ない。
// 注意: npm 10.9 の @npmcli/arborist rebuild.js は --ignore-scripts でも link の prepare だけは実行する (links 経路の
// #runScripts('prepare') が ignoreScripts で gate されていない)。link の prepare はここでは検出 (事後) になる。
// リポ内の link は packages/x402-sdk だけで prepare を持たない。
//
// 使い方: node scripts/installed-scripts-gate.mjs [--rebuild] <node_modules dir> [...]
//   例: node scripts/installed-scripts-gate.mjs --rebuild node_modules
//       node scripts/installed-scripts-gate.mjs --rebuild tools/lighthouse/node_modules
// 判定:
//   - registry のパッケージ: ディレクトリ名から導いた名前 (@scope/name) が INSTALL_SCRIPT_ALLOWLIST にあり、
//     package.json の name も一致し、**root の隣の lockfile (npm-shrinkwrap.json 優先・無ければ package-lock.json) の
//     その path のエントリが「inBundle でない・link でない・別名でない・resolved が公式レジストリのその名前の
//     tarball」**のときだけ許容 (→ --rebuild の対象)。bundled・取得元不明・lockfile に無い実体は allowlist の対象外 =
//     fail (公式パッケージへの承認を、同梱や別 publisher の同名実体へ流用させない)。`npm rebuild <name>` は同名の
//     全実体を対象にするので、allowlist の名前の実体は install script の有無に関係なく全てこの条件で確かめる。
//   - link (symlink = workspace / file:) のパッケージ: 名前ではなく実際のリンク先 (realpath・repo 相対) が
//     LINKED_PACKAGE_SCRIPT_ALLOWLIST にあるときだけ許容 (registry の承認を別実体へ流用させない)。rebuild はしない。
//   - --rebuild: 全 root が通ったあと、root ごとに「その root に入っている allowlist の名前」だけを
//     `npm rebuild <names>` (cwd = root の親 = lockfile のある dir) で実行する。名前が無ければ npm を呼ばない
//     (裸の `npm rebuild` は全パッケージの script を走らせるので絶対に呼ばない)。
// 依存は Node 標準 API のみ (このゲート自体が新規依存を持つのは本末転倒のため)。

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { INSTALL_SCRIPT_ALLOWLIST, LINKED_PACKAGE_SCRIPT_ALLOWLIST } from './lib/installScriptAllowlist.mjs';
import { parseRegistryTarball } from './lib/registryTarball.mjs';

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const toPosix = (path) => path.split(sep).join('/');
const repoRelative = (path) => toPosix(relative(process.cwd(), path));

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

function safeIsDir(path) {
  try {
    return lstatSync(path).isDirectory() || (lstatSync(path).isSymbolicLink() && existsSync(path));
  } catch {
    return false;
  }
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

/** root の隣の lockfile を読む (npm と同じく npm-shrinkwrap.json を優先)。無い / 読めない / 形が違うは fail。 */
function readLockfile(nodeModules, state) {
  const base = dirname(resolve(nodeModules));
  const file = ['npm-shrinkwrap.json', 'package-lock.json'].map((f) => join(base, f)).find((f) => existsSync(f));
  if (file === undefined) {
    state.failures.push(`${repoRelative(nodeModules)}: no npm-shrinkwrap.json / package-lock.json beside it; cannot confirm what the allowlisted packages are`);
    return null;
  }
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    const packages = lock?.packages;
    if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
      state.failures.push(`${repoRelative(file)}: has no packages object (lockfileVersion >= 2 required)`);
      return null;
    }
    return { file, base, packages };
  } catch {
    state.failures.push(`${repoRelative(file)}: cannot be parsed`);
    return null;
  }
}

/**
 * allowlist の名前の実体 (dir) が、lockfile で「公式レジストリのその名前の tarball」と確かめられるか。
 * @returns {string | null} 問題なければ null、あれば理由。
 */
function lockfileObjection(lock, dir, name) {
  if (lock === null) return 'no lockfile to confirm it against';
  const key = toPosix(relative(lock.base, dir));
  const entry = lock.packages[key];
  if (entry === undefined || entry === null || typeof entry !== 'object') return `not in the lockfile ${repoRelative(lock.file)} (${key})`;
  if (entry.inBundle === true) return `a bundled copy (inBundle) in ${repoRelative(lock.file)}, not the registry package`;
  if (entry.link === true) return `a link entry in ${repoRelative(lock.file)}, not the registry package`;
  if (typeof entry.name === 'string' && entry.name !== name) return `an npm alias of ${entry.name} in ${repoRelative(lock.file)}`;
  const tarball = parseRegistryTarball(entry.resolved);
  if (tarball === null) return `resolved in ${repoRelative(lock.file)} is not an official registry tarball (${entry.resolved ?? 'missing'})`;
  if (tarball.name !== name) return `fetched as ${tarball.name} per ${repoRelative(lock.file)}, not ${name}`;
  return null;
}

function scanScripts(nodeModules, lock, state) {
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
    const shown = repoRelative(dir);
    if (manifest === null) continue; // package.json の無い dir (キャッシュ等) は npm の package ではない
    state.scanned++;
    if (manifest.__unreadable) {
      state.failures.push(`${shown}: package.json cannot be parsed, install-time scripts unknown`);
    } else {
      const triggers = installTriggers(dir, manifest, linked);
      const manifestName = typeof manifest.name === 'string' ? manifest.name : '(no name)';
      if (linked) {
        if (triggers.length > 0) {
          // link はリポ内 (または外) の実体なので、registry の名前の承認を使わせず、リンク先の path で照合する。
          const target = repoRelative(realpathSync(dir));
          if (Object.hasOwn(LINKED_PACKAGE_SCRIPT_ALLOWLIST, target)) {
            state.allowed.push(`${shown} -> ${target} [${triggers.join(', ')}] (linked)`);
          } else {
            state.failures.push(
              `${shown}: linked to ${target} (${manifestName}) which runs install-time scripts [${triggers.join(', ')}] and is not in ` +
                'LINKED_PACKAGE_SCRIPT_ALLOWLIST (scripts/lib/installScriptAllowlist.mjs). A link cannot use the registry allowlist by name.',
            );
          }
        }
      } else if (Object.hasOwn(INSTALL_SCRIPT_ALLOWLIST, name)) {
        // allowlist の名前の実体は、script の有無に関係なく (npm rebuild <name> が同名の全実体を対象にするため)
        // manifest の name と lockfile のエントリで「公式レジストリのその名前の tarball」であることを確かめる。
        const objection = manifestName !== name
          ? `package.json names ${manifestName} — an alias cannot borrow an allowlisted name`
          : lockfileObjection(lock, dir, name);
        if (objection !== null) {
          state.failures.push(
            `${shown}: directory name ${name} is allowlisted but the package there is ${objection}` +
              (triggers.length > 0 ? ` [${triggers.join(', ')}]` : '') +
              '. The install script allowlist applies only to the official registry package of that name (CLAUDE.md 掟 16).',
          );
        } else {
          if (triggers.length > 0) state.allowed.push(`${shown} [${triggers.join(', ')}]`);
          state.rebuildNames.add(name);
        }
      } else if (triggers.length > 0) {
        state.failures.push(
          `${shown}: ${manifestName} runs install-time scripts [${triggers.join(', ')}] and is not in INSTALL_SCRIPT_ALLOWLIST ` +
            '(scripts/lib/installScriptAllowlist.mjs). Review the package before adding it (CLAUDE.md 掟 16).',
        );
      }
    }
    const nested = join(dir, 'node_modules');
    if (existsSync(nested)) scanScripts(nested, lock, state);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const roots = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && a !== '--rebuild');
if (roots.length === 0 || unknown.length > 0) {
  console.error('installed-scripts-gate: usage: node scripts/installed-scripts-gate.mjs [--rebuild] <node_modules dir> [...]');
  process.exit(1);
}

let bad = 0;
const results = [];
for (const root of roots) {
  if (!safeIsDir(root)) {
    // npm ci の直後に無いのは install の失敗か指定ミス。検査対象ゼロの偽成功にしない。
    console.error(`NG ${root}: not a directory (run this right after npm ci --ignore-scripts)`);
    bad++;
    continue;
  }
  const state = { visited: new Set(), scanned: 0, allowed: [], rebuildNames: new Set(), failures: [] };
  const lock = readLockfile(root, state);
  scanScripts(root, lock, state);
  for (const line of state.failures) console.error(`NG ${line}`);
  bad += state.failures.length;
  console.log(`OK ${root}: ${state.scanned} packages scanned, ${state.allowed.length} with allowlisted install-time scripts`);
  for (const line of state.allowed) console.log(`   ${line}`);
  results.push({ root, rebuildNames: [...state.rebuildNames].sort() });
}

if (bad > 0) {
  console.error(
    `installed-scripts-gate: install-time script を持つ allowlist 外のパッケージ (または未検査の root) が ${bad} 件あります。` +
      '個別確認のうえ scripts/lib/installScriptAllowlist.mjs に追加するか、依存を外してください (CLAUDE.md 掟 16)。' +
      (rebuild ? ' npm rebuild は実行していません。' : ''),
  );
  process.exit(1);
}

if (rebuild) {
  for (const { root, rebuildNames } of results) {
    if (rebuildNames.length === 0) {
      console.log(`installed-scripts-gate: ${root}: nothing to rebuild (no allowlisted install-time scripts installed)`);
      continue;
    }
    const cwd = dirname(resolve(root));
    console.log(`installed-scripts-gate: ${root}: npm rebuild ${rebuildNames.join(' ')} (cwd ${repoRelative(cwd) || '.'})`);
    const run = spawnSync('npm', ['rebuild', ...rebuildNames], { cwd, stdio: 'inherit' });
    if (run.error || run.status !== 0) {
      // 必要な native build / binary 取得に失敗した状態で先へ進ませない (後続の build / test が別の理由で赤になる)。
      console.error(`installed-scripts-gate: npm rebuild failed in ${repoRelative(cwd) || '.'} (status ${run.status ?? run.error?.message})`);
      process.exit(1);
    }
  }
}
console.log(`installed-scripts-gate: install-time script は allowlist のものだけです${rebuild ? ' (allowlist の npm rebuild 済み)' : ''}`);
