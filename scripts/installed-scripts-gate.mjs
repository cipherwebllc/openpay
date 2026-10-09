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
// 2 つ目の検査 (PR #778 Codex レビュー 2 回目): optional な native 依存は暗黙ビルドが失敗すると npm が実体を
// 削除し、install は成功扱いになる = 走査をすり抜ける。root の隣の lockfile から「この環境で入るはず」の
// エントリ (root の dependencies / optionalDependencies を辿り、os / cpu / libc が合わないものと、そこからしか
// 辿れないものを除く) を求め、node_modules に無ければ fail する (消えた = ビルド失敗の疑い)。
//
// 使い方: node scripts/installed-scripts-gate.mjs [--omit=dev] <node_modules dir> [...]
//   例: node scripts/installed-scripts-gate.mjs node_modules
//       node scripts/installed-scripts-gate.mjs tools/lighthouse/node_modules
//       node scripts/installed-scripts-gate.mjs --omit=dev node_modules   (npm ci --omit=dev の後)
// 判定:
//   - registry のパッケージ: ディレクトリ名から導いた名前 (@scope/name) が INSTALL_SCRIPT_ALLOWLIST にあり、
//     package.json の name も一致するときだけ許容。
//   - link (symlink = workspace / file:) のパッケージ: 名前ではなく実際のリンク先 (realpath・repo 相対) が
//     LINKED_PACKAGE_SCRIPT_ALLOWLIST にあるときだけ許容 (registry の承認を別実体へ流用させない)。
// 依存は Node 標準 API のみ (このゲート自体が新規依存を持つのは本末転倒のため)。

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { INSTALL_SCRIPT_ALLOWLIST, LINKED_PACKAGE_SCRIPT_ALLOWLIST } from './lib/installScriptAllowlist.mjs';

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

function scanScripts(nodeModules, state) {
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
      if (triggers.length > 0) {
        const manifestName = typeof manifest.name === 'string' ? manifest.name : '(no name)';
        if (linked) {
          // link はリポ内 (または外) の実体なので、registry の名前の承認を使わせず、リンク先の path で照合する。
          const target = repoRelative(realpathSync(dir));
          if (Object.hasOwn(LINKED_PACKAGE_SCRIPT_ALLOWLIST, target)) {
            state.allowed.push(`${shown} -> ${target} [${triggers.join(', ')}] (linked)`);
            state.allowedNames.add(target);
          } else {
            state.failures.push(
              `${shown}: linked to ${target} (${manifestName}) which runs install-time scripts [${triggers.join(', ')}] and is not in ` +
                'LINKED_PACKAGE_SCRIPT_ALLOWLIST (scripts/lib/installScriptAllowlist.mjs). A link cannot use the registry allowlist by name.',
            );
          }
        } else if (Object.hasOwn(INSTALL_SCRIPT_ALLOWLIST, name) && manifestName === name) {
          state.allowed.push(`${shown} [${triggers.join(', ')}]`);
          state.allowedNames.add(name);
        } else if (Object.hasOwn(INSTALL_SCRIPT_ALLOWLIST, name)) {
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
    if (existsSync(nested)) scanScripts(nested, state);
  }
}

// ── lockfile との突き合わせ ──────────────────────────────────────────────

/** npm と同じ os / cpu / libc の判定 ("!x" は否定)。条件が無ければ一致。 */
function platformMatches(entry) {
  const current = { os: process.platform, cpu: process.arch, libc: currentLibc() };
  for (const key of ['os', 'cpu', 'libc']) {
    const wanted = entry[key];
    if (!Array.isArray(wanted) || wanted.length === 0) continue;
    const value = current[key];
    const negated = wanted.filter((w) => typeof w === 'string' && w.startsWith('!')).map((w) => w.slice(1));
    const positive = wanted.filter((w) => typeof w === 'string' && !w.startsWith('!'));
    if (negated.includes(value)) return false;
    if (positive.length > 0 && !positive.includes(value)) return false;
  }
  return true;
}

function currentLibc() {
  if (process.platform !== 'linux') return null;
  try {
    const header = process.report?.getReport?.()?.header;
    if (header?.glibcVersionRuntime) return 'glibc';
  } catch {
    // report が取れない環境では musl 判定に落とす (glibc の optional を「期待」から外す側 = 過剰検出を避ける)。
  }
  return 'musl';
}

/** path (lockfile の key) から name を Node の解決順で探し、lockfile の key を返す。 */
function resolveDependency(packages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (base === '') return null;
    const at = base.lastIndexOf('/node_modules/');
    if (at === -1) {
      // workspace の path (packages/x) → root の node_modules へ
      base = '';
    } else {
      base = base.slice(0, at);
    }
  }
}

/**
 * この環境で node_modules に入っているはずの lockfile エントリを返す (root から到達できる
 * dependencies / optionalDependencies のうち、os / cpu / libc が合うもの)。
 */
function expectedEntries(packages, omitDev) {
  const expected = new Set();
  const queue = [];
  const root = packages[''] ?? {};
  const rootDeps = { ...(root.dependencies ?? {}), ...(root.optionalDependencies ?? {}), ...(omitDev ? {} : root.devDependencies ?? {}) };
  for (const name of Object.keys(rootDeps)) {
    const key = resolveDependency(packages, '', name);
    if (key !== null) queue.push(key);
  }
  while (queue.length > 0) {
    let key = queue.pop();
    if (expected.has(key)) continue;
    const entry = packages[key];
    if (entry === null || typeof entry !== 'object') continue;
    if (!platformMatches(entry)) continue; // この環境には入らない (optional の platform 別 binary)
    expected.add(key);
    if (entry.link === true && typeof entry.resolved === 'string') {
      // link の実体 (packages/x) は別エントリ。そちらの依存を辿る。
      key = entry.resolved;
      if (!Object.hasOwn(packages, key) || expected.has(key)) continue;
      expected.add(key);
    }
    const target = packages[key];
    const deps = { ...(target?.dependencies ?? {}), ...(target?.optionalDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const dep = resolveDependency(packages, key, name);
      if (dep !== null && !expected.has(dep)) queue.push(dep);
    }
  }
  return expected;
}

function reconcileWithLockfile(nodeModules, omitDev, state) {
  const base = dirname(resolve(nodeModules));
  const lockPath = ['package-lock.json', 'npm-shrinkwrap.json'].map((f) => join(base, f)).find((f) => existsSync(f));
  if (lockPath === undefined) {
    state.failures.push(`${repoRelative(nodeModules)}: no package-lock.json / npm-shrinkwrap.json beside it to reconcile against`);
    return;
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    state.failures.push(`${repoRelative(lockPath)}: cannot be parsed`);
    return;
  }
  const packages = lock?.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    state.failures.push(`${repoRelative(lockPath)}: has no packages object (lockfileVersion >= 2 required)`);
    return;
  }
  const expected = expectedEntries(packages, omitDev);
  let missing = 0;
  for (const key of expected) {
    const entry = packages[key];
    const dir = join(base, key);
    if (existsSync(dir) && readManifest(dir) !== null) continue;
    missing++;
    const flags = ['optional', 'dev', 'devOptional', 'hasInstallScript', 'link'].filter((f) => entry[f] === true).join(', ');
    state.failures.push(
      `${repoRelative(dir)}: expected from ${repoRelative(lockPath)} for this platform but absent after install` +
        (flags ? ` [${flags}]` : '') +
        (entry.optional || entry.devOptional ? ' — an optional dependency that disappears after npm ci usually means its install script / implicit node-gyp build failed' : ''),
    );
  }
  state.lockfileSummary = `${expected.size} entries expected from ${repoRelative(lockPath)} for ${process.platform}/${process.arch}${omitDev ? ' (omit=dev)' : ''}, ${missing} missing`;
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const omitDev = args.includes('--omit=dev');
const roots = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && a !== '--omit=dev');
if (roots.length === 0 || unknown.length > 0) {
  console.error('installed-scripts-gate: usage: node scripts/installed-scripts-gate.mjs [--omit=dev] <node_modules dir> [...]');
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
  const state = { visited: new Set(), scanned: 0, allowed: [], allowedNames, failures: [], lockfileSummary: '' };
  scanScripts(root, state);
  reconcileWithLockfile(root, omitDev, state);
  for (const line of state.failures) console.error(`NG ${line}`);
  bad += state.failures.length;
  console.log(`OK ${root}: ${state.scanned} packages scanned, ${state.allowed.length} with allowlisted install-time scripts; ${state.lockfileSummary}`);
  for (const line of state.allowed) console.log(`   ${line}`);
}

if (bad > 0) {
  console.error(
    `installed-scripts-gate: install-time script を持つ allowlist 外のパッケージ・lockfile にあるのに入っていないパッケージ (または未検査の root) が ${bad} 件あります。` +
      '個別確認のうえ scripts/lib/installScriptAllowlist.mjs に追加するか、依存を外してください (CLAUDE.md 掟 16)。',
  );
  process.exit(1);
}
console.log(`installed-scripts-gate: install-time script は allowlist の ${allowedNames.size} 件のみ、lockfile のエントリは全て入っています`);
