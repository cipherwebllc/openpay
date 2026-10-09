import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Codex レビュー (PR #778) 3: lockfile の hasInstallScript だけでは、binding.gyp の暗黙 `node-gyp rebuild`・
// bundled 依存の実体の script・link (workspace) の prepare を npm ci の前に知れない。npm ci の直後に
// node_modules の実体 (package.json の scripts と binding.gyp) を走査し、allowlist 外があれば fail にする。
// 実行前の防止ではなく検出 (R4 の裁定 = 「CI で検出」の範囲)。

const SCRIPT = resolve('scripts/installed-scripts-gate.mjs');
let root: string;

function pkg(path: string, manifest: Record<string, unknown>, extraFiles: Record<string, string> = {}) {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }));
  for (const [file, text] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

function run(...roots: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...(roots.length > 0 ? roots : ['node_modules'])], {
    cwd: root, encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  return result;
}

const OFFICIAL = 'https://registry.npmjs.org/';
type Entry = Record<string, unknown>;
// root の隣の lockfile (node_modules → package-lock.json) を書く。entries は path → 追加フィールド。
function lock(
  entries: Record<string, Entry>,
  rootDeps: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {},
  file = 'package-lock.json',
) {
  const packages: Record<string, Entry> = { '': { name: 'fixture', ...rootDeps } };
  for (const [path, extra] of Object.entries(entries)) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    packages[path] = { version: '1.0.0', resolved: `${OFFICIAL}${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-1.0.0.tgz`, ...extra };
  }
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }));
}

beforeEach(() => {
  root = mkdtempSync(resolve('.installed-scripts-gate-test-'));
  pkg('node_modules/plain', { name: 'plain', scripts: { test: 'vitest', build: 'tsc' } });
  pkg('node_modules/@scope/plain', { name: '@scope/plain' });
  lock({ 'node_modules/plain': {}, 'node_modules/@scope/plain': {} }, { dependencies: { plain: '^1', '@scope/plain': '^1' } });
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('installed-scripts-gate CLI', () => {
  it('accepts a tree without install-time scripts and reports the scan', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node_modules');
    expect(result.stdout).toMatch(/2 packages/);
  });

  it('accepts an allowlisted package whose manifest name matches and lists it', () => {
    pkg('node_modules/esbuild', { name: 'esbuild', scripts: { postinstall: 'node install.js' } });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('esbuild');
  });

  it.each(['preinstall', 'install', 'postinstall'])('rejects an unknown package with a %s script', (hook) => {
    pkg('node_modules/evil-postinstall', { name: 'evil-postinstall', scripts: { [hook]: 'node steal.js' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/evil-postinstall');
    expect(result.stderr).toContain(hook);
    expect(result.stderr).toContain('INSTALL_SCRIPT_ALLOWLIST');
  });

  it('rejects an unknown package with binding.gyp even without scripts (npm runs node-gyp rebuild implicitly)', () => {
    pkg('node_modules/native-evil', { name: 'native-evil' }, { 'binding.gyp': '{ "targets": [] }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/native-evil');
    expect(result.stderr).toContain('binding.gyp');
  });

  it('accepts an allowlisted package shipped with binding.gyp', () => {
    pkg('node_modules/keccak', { name: 'keccak', scripts: { install: 'node-gyp-build || exit 0' } }, { 'binding.gyp': '{}' });
    expect(run().status).toBe(0);
  });

  it('rejects an allowlisted directory name whose manifest names another package (alias)', () => {
    pkg('node_modules/esbuild', { name: 'evil-postinstall', scripts: { postinstall: 'node steal.js' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/esbuild');
    expect(result.stderr).toContain('evil-postinstall');
  });

  it('rejects an allowlisted package whose manifest has no name', () => {
    pkg('node_modules/esbuild', { scripts: { postinstall: 'node install.js' } });
    expect(run().status).toBe(1);
  });

  it('scans nested node_modules and scoped packages', () => {
    pkg('node_modules/plain/node_modules/@evil/nested', { name: '@evil/nested', scripts: { postinstall: 'x' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/plain/node_modules/@evil/nested');
  });

  it('treats prepare as install-time only for linked (workspace) packages', () => {
    pkg('node_modules/registry-pkg', { name: 'registry-pkg', scripts: { prepare: 'husky' } });
    expect(run().status).toBe(0);
    pkg('packages/local', { name: 'local', scripts: { prepare: 'node build.js' } });
    symlinkSync(join(root, 'packages/local'), join(root, 'node_modules/local'), 'dir');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/local');
    expect(result.stderr).toContain('prepare');
  });

  it('follows a linked package into its own node_modules', () => {
    pkg('packages/local', { name: 'local' });
    pkg('packages/local/node_modules/evil-postinstall', { name: 'evil-postinstall', scripts: { install: 'x' } });
    symlinkSync(join(root, 'packages/local'), join(root, 'node_modules/local'), 'dir');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evil-postinstall');
  });

  it('ignores .bin, dot entries and directories without package.json', () => {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules/.bin/evil'), '#!/bin/sh\n');
    writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
    mkdirSync(join(root, 'node_modules/leftover'), { recursive: true });
    expect(run().status).toBe(0);
  });

  it('fails closed when a root does not exist', () => {
    const result = run('node_modules', 'tools/missing/node_modules');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tools/missing/node_modules');
  });

  it('fails closed when no root is given', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
  });

  it('checks every root given', () => {
    pkg('tools/example/node_modules/evil-postinstall', { name: 'evil-postinstall', scripts: { postinstall: 'x' } });
    lock({ 'node_modules/evil-postinstall': { hasInstallScript: true } }, { dependencies: { 'evil-postinstall': '^1' } }, 'tools/example/package-lock.json');
    expect(run('node_modules').status).toBe(0);
    const result = run('node_modules', 'tools/example/node_modules');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tools/example/node_modules/evil-postinstall');
  });

  // Codex レビュー 2 回目 (PR #778) 1: registry 用の allowlist は link (workspace) には効かせない。link の script は
  // 実際のリンク先 (realpath・repo 相対) を別の一覧 LINKED_PACKAGE_SCRIPT_ALLOWLIST と照合する。
  describe('linked (workspace) packages', () => {
    it.each(['postinstall', 'prepare'])('rejects a local directory linked under an allowlisted name even with a matching manifest name (%s)', (hook) => {
      pkg('packages/esbuild', { name: 'esbuild', scripts: { [hook]: 'node steal.js' } });
      symlinkSync(join(root, 'packages/esbuild'), join(root, 'node_modules/esbuild'), 'dir');
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
      expect(result.stderr).toContain('packages/esbuild');
      expect(result.stderr).toContain('LINKED_PACKAGE_SCRIPT_ALLOWLIST');
    });

    it('rejects a linked package with binding.gyp (implicit build) that is not in the linked allowlist', () => {
      pkg('packages/native', { name: 'native' }, { 'binding.gyp': '{}' });
      symlinkSync(join(root, 'packages/native'), join(root, 'node_modules/native'), 'dir');
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/native');
    });

    it('accepts a linked package without install-time scripts', () => {
      pkg('packages/local', { name: 'local', scripts: { test: 'node --test', prepublishOnly: 'npm test' } });
      symlinkSync(join(root, 'packages/local'), join(root, 'node_modules/local'), 'dir');
      expect(run().status).toBe(0);
    });
  });
});

// Codex レビュー 2 回目 (PR #778) 2: optional な binding.gyp 依存は暗黙ビルドが失敗すると npm が実体を削除し、
// 事後の走査をすり抜ける (optional の失敗は install 全体の失敗にならない)。lockfile から「この環境で入るはず」の
// エントリを求め (root から dependencies / optionalDependencies を辿り、os / cpu / libc が合わないものと
// そこからしか辿れないものを除く)、node_modules に無ければ fail する。
describe('installed-scripts-gate lockfile reconciliation', () => {
  const otherOs = process.platform === 'linux' ? 'win32' : 'linux';
  const otherCpu = process.arch === 'x64' ? 'arm64' : 'x64';

  it('accepts a tree that matches the lockfile', () => {
    lock({ 'node_modules/plain': {}, 'node_modules/@scope/plain': {} }, { dependencies: { plain: '^1', '@scope/plain': '^1' } });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('lockfile');
  });

  it('rejects a required package that the lockfile expects but node_modules lacks', () => {
    lock({ 'node_modules/plain': {}, 'node_modules/gone': {} }, { dependencies: { plain: '^1', gone: '^1' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/gone');
    expect(result.stderr).toContain('lockfile');
  });

  it('rejects an optional native package for this platform that disappeared (implicit build failure)', () => {
    lock({
      'node_modules/plain': { dependencies: { 'native-opt': '^1' } },
      'node_modules/native-opt': { optional: true, hasInstallScript: true, os: [process.platform], cpu: [process.arch] },
    }, { dependencies: { plain: '^1' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/native-opt');
    expect(result.stderr).toContain('optional');
  });

  it('accepts optional packages excluded by os, cpu, libc or negation, and packages reachable only through them', () => {
    lock({
      'node_modules/plain': { optionalDependencies: { 'other-os': '^1', 'other-cpu': '^1', 'other-libc': '^1', negated: '^1', 'wasm-only': '^1' } },
      'node_modules/other-os': { optional: true, os: [otherOs] },
      'node_modules/other-cpu': { optional: true, cpu: [otherCpu] },
      'node_modules/other-libc': { optional: true, os: ['linux'], libc: ['nonexistent-libc'] },
      'node_modules/negated': { optional: true, os: [`!${process.platform}`] },
      'node_modules/wasm-only': { optional: true, cpu: ['wasm32'], dependencies: { 'wasm-runtime': '^1' } },
      'node_modules/wasm-runtime': { optional: true, dependencies: { 'wasm-helper': '^1' } },
      'node_modules/wasm-helper': { optional: true },
    }, { dependencies: { plain: '^1' } });
    expect(run().status).toBe(0);
  });

  it('resolves nested node_modules like Node does', () => {
    pkg('node_modules/plain/node_modules/inner', { name: 'inner' });
    lock({
      'node_modules/plain': { dependencies: { inner: '^2', shared: '^1' } },
      'node_modules/plain/node_modules/inner': { version: '2.0.0' },
      'node_modules/shared': {},
    }, { dependencies: { plain: '^1' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/shared');
    pkg('node_modules/shared', { name: 'shared' });
    expect(run().status).toBe(0);
  });

  it('rejects a missing nested package', () => {
    lock({
      'node_modules/plain': { dependencies: { inner: '^2' } },
      'node_modules/plain/node_modules/inner': { version: '2.0.0' },
    }, { dependencies: { plain: '^1' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/plain/node_modules/inner');
  });

  it('expects devDependencies unless --omit=dev is given', () => {
    lock({ 'node_modules/plain': {}, 'node_modules/dev-only': { dev: true } }, { dependencies: { plain: '^1' }, devDependencies: { 'dev-only': '^1' } });
    expect(run().status).toBe(1);
    const result = spawnSync(process.execPath, [SCRIPT, '--omit=dev', 'node_modules'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('follows workspace links into their own lockfile entries', () => {
    pkg('packages/local', { name: 'local' });
    symlinkSync(join(root, 'packages/local'), join(root, 'node_modules/local'), 'dir');
    lock({
      'node_modules/local': { link: true, resolved: 'packages/local', version: undefined },
      'packages/local': { dependencies: { 'local-dep': '^1' } },
      'node_modules/local-dep': {},
    }, { dependencies: { local: 'file:packages/local' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/local-dep');
  });

  it('fails closed when the lockfile beside the root is missing', () => {
    rmSync(join(root, 'package-lock.json'), { force: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package-lock.json');
  });
});

describe('installed-scripts-gate on the real install', () => {
  it.each(['node_modules', 'tools/lighthouse/node_modules'])('%s only contains allowlisted install-time scripts', (dir) => {
    if (!existsSync(resolve(dir))) return; // tools/lighthouse は Lighthouse job でだけ install される
    const result = spawnSync(process.execPath, [SCRIPT, dir], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
