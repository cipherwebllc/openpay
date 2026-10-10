import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Codex レビュー (PR #778) 3 → 3 回目で「防止」に切り替え: CI は `npm ci --ignore-scripts` で install script を
// 走らせずに入れ、この gate が node_modules の実体 (package.json の preinstall / install / postinstall、link の
// prepare、binding.gyp = 暗黙の `node-gyp rebuild`) を走査して allowlist 外があれば fail する。通ったときだけ
// `--rebuild` で allowlist の名前を `npm rebuild <names>` し、必要な install script を実行する。
// = allowlist 外の install script 付き依存は一度も実行されずに CI で止まる。

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

// `--rebuild` が呼ぶ npm を PATH 先頭の偽物に差し替え、呼ばれた引数と cwd を記録する (本物の npm は呼ばない)。
function fakeNpm(exitCode = 0) {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'npm-calls.log');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit ${exitCode}\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function run(args: string[] = ['node_modules'], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

// Codex レビュー 4 回目 (PR #778) 1: 名前の allowlist は、その実体が lockfile で「公式レジストリのその名前の tarball」
// (inBundle でない・resolved がその名前・別名でない) と確かめられたときだけ効かせる。root の隣の lockfile に
// 実体の path のエントリを書く helper (既定は正規の官製 tarball)。`resolved: undefined` で resolved を消せる。
const OFFICIAL = 'https://registry.npmjs.org/';
type Entry = Record<string, unknown>;
function lock(entries: Record<string, Entry>, file = 'package-lock.json') {
  const packages: Record<string, Entry> = { '': { name: 'fixture' } };
  for (const [path, extra] of Object.entries(entries)) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    packages[path] = { version: '1.0.0', resolved: `${OFFICIAL}${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-1.0.0.tgz`, ...extra };
  }
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }));
}
const BASE = { 'node_modules/plain': {}, 'node_modules/@scope/plain': {} };

beforeEach(() => {
  root = mkdtempSync(resolve('.installed-scripts-gate-test-'));
  pkg('node_modules/plain', { name: 'plain', scripts: { test: 'vitest', build: 'tsc' } });
  pkg('node_modules/@scope/plain', { name: '@scope/plain' });
  lock(BASE);
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
    lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true } });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('esbuild');
  });

  it.each(['preinstall', 'install', 'postinstall'])('rejects an unknown package with a %s script', (hook) => {
    pkg('node_modules/evil-postinstall', { name: 'evil-postinstall', scripts: { [hook]: 'node steal.js' } });
    lock({ ...BASE, 'node_modules/evil-postinstall': {} });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/evil-postinstall');
    expect(result.stderr).toContain(hook);
    expect(result.stderr).toContain('INSTALL_SCRIPT_ALLOWLIST');
  });

  it('rejects an unknown package with binding.gyp even without scripts (npm runs node-gyp rebuild implicitly)', () => {
    pkg('node_modules/native-evil', { name: 'native-evil' }, { 'binding.gyp': '{ "targets": [] }' });
    lock({ ...BASE, 'node_modules/native-evil': {} });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/native-evil');
    expect(result.stderr).toContain('binding.gyp');
  });

  // Codex レビュー 3 回目 (PR #778) 2: 旧設計 (npm ci → 走査) では optional な binding.gyp 依存の暗黙ビルドが失敗すると
  // npm が実体を消し、走査が通ってしまった。防止の設計では `npm ci --ignore-scripts` が build を走らせないので実体は
  // 必ず残り、展開直後の走査で捕まる (= 実行されない)。lockfile に hasInstallScript が無くても同じ。
  it('catches an optional native package with binding.gyp right after extraction, before any build could remove it', () => {
    pkg('node_modules/optional-native', { name: 'optional-native', optional: true, scripts: { test: 'node test.js' } }, { 'binding.gyp': '{ "targets": [{ "target_name": "addon" }] }' });
    lock({ ...BASE, 'node_modules/optional-native': { optional: true } });
    const npm = fakeNpm();
    const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/optional-native');
    expect(result.stderr).toContain('binding.gyp');
    expect(npm.calls()).toEqual([]); // 承認されない限り何も rebuild (= 実行) しない
  });

  it('accepts an allowlisted package shipped with binding.gyp', () => {
    pkg('node_modules/keccak', { name: 'keccak', scripts: { install: 'node-gyp-build || exit 0' } }, { 'binding.gyp': '{}' });
    lock({ ...BASE, 'node_modules/keccak': { hasInstallScript: true } });
    expect(run().status).toBe(0);
  });

  it('rejects an allowlisted directory name whose manifest names another package (alias)', () => {
    pkg('node_modules/esbuild', { name: 'evil-postinstall', scripts: { postinstall: 'node steal.js' } });
    lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/esbuild');
    expect(result.stderr).toContain('evil-postinstall');
  });

  it('rejects an allowlisted package whose manifest has no name', () => {
    pkg('node_modules/esbuild', { scripts: { postinstall: 'node install.js' } });
    lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true } });
    expect(run().status).toBe(1);
  });

  it('scans nested node_modules and scoped packages', () => {
    pkg('node_modules/plain/node_modules/@evil/nested', { name: '@evil/nested', scripts: { postinstall: 'x' } });
    lock({ ...BASE, 'node_modules/plain/node_modules/@evil/nested': {} });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/plain/node_modules/@evil/nested');
  });

  it('treats prepare as install-time only for linked (workspace) packages', () => {
    pkg('node_modules/registry-pkg', { name: 'registry-pkg', scripts: { prepare: 'husky' } });
    lock({ ...BASE, 'node_modules/registry-pkg': {} });
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
    const result = run(['node_modules', 'tools/missing/node_modules']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tools/missing/node_modules');
  });

  it.each([[[]], [['--omit=dev', 'node_modules']], [['--unknown', 'node_modules']]])('fails closed for the arguments %j', (args) => {
    expect(run(args).status).toBe(1);
  });

  it('checks every root given', () => {
    pkg('tools/example/node_modules/evil-postinstall', { name: 'evil-postinstall', scripts: { postinstall: 'x' } });
    lock({ 'node_modules/evil-postinstall': {} }, 'tools/example/package-lock.json');
    expect(run(['node_modules']).status).toBe(0);
    const result = run(['node_modules', 'tools/example/node_modules']);
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

  // Codex レビュー 4 回目 (PR #778) 1: 公式レジストリの親パッケージが node_modules/esbuild を同梱し、同梱物の manifest が
  // name "esbuild" と任意の postinstall を持つと、lockfile の同梱エントリは inBundle: true・resolved なしで取得元 gate を
  // 通り、名前一致だけの実体 gate も通し、`npm rebuild esbuild` は同梱物も対象にする。→ allowlist の名前の実体は
  // lockfile のその path のエントリが「inBundle でない・resolved が公式レジストリのその名前の tarball・別名でない」
  // ときだけ承認する。script を持たない同名の実体も (rebuild の対象になるので) 同じ条件で確かめる。
  describe('lockfile cross-check for allowlisted names', () => {
    const esbuildWithScript = () => pkg('node_modules/esbuild', { name: 'esbuild', scripts: { postinstall: 'node install.js' } });

    it('rejects a bundled copy of an allowlisted name (inBundle, no resolved)', () => {
      esbuildWithScript();
      lock({ ...BASE, 'node_modules/esbuild': { inBundle: true, resolved: undefined } });
      const npm = fakeNpm();
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
      expect(result.stderr).toContain('bundled');
      expect(npm.calls()).toEqual([]);
    });

    it('rejects a bundled nested copy even when the top-level copy is genuine (npm rebuild <name> targets every copy)', () => {
      esbuildWithScript();
      pkg('node_modules/plain/node_modules/esbuild', { name: 'esbuild' }); // script なしでも rebuild の対象
      lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true }, 'node_modules/plain/node_modules/esbuild': { inBundle: true, resolved: undefined } });
      const npm = fakeNpm();
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/plain/node_modules/esbuild');
      expect(npm.calls()).toEqual([]);
    });

    it.each([
      ['no resolved', { resolved: undefined }],
      ['resolved from another registry', { resolved: 'https://registry.evil.example/esbuild/-/esbuild-1.0.0.tgz' }],
      ['resolved tarball of another package', { resolved: `${OFFICIAL}evil-postinstall/-/evil-postinstall-1.0.0.tgz` }],
      ['aliased lockfile name', { name: 'evil-postinstall' }],
      ['link entry', { link: true, resolved: 'packages/esbuild' }],
    ])('rejects an allowlisted name whose lockfile entry has %s', (_label, extra) => {
      esbuildWithScript();
      lock({ ...BASE, 'node_modules/esbuild': extra });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
    });

    it('rejects an allowlisted name that is absent from the lockfile', () => {
      esbuildWithScript();
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
      expect(result.stderr).toContain('lockfile');
    });

    it('fails closed when no lockfile sits beside the root', () => {
      rmSync(join(root, 'package-lock.json'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('package-lock.json');
    });

    it('prefers npm-shrinkwrap.json over package-lock.json like npm does', () => {
      esbuildWithScript();
      lock({ ...BASE, 'node_modules/esbuild': { inBundle: true, resolved: undefined } });
      lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true } }, 'npm-shrinkwrap.json');
      expect(run().status).toBe(0);
    });

    it('does not require lockfile entries for packages without install-time scripts outside the allowlist', () => {
      pkg('node_modules/extra', { name: 'extra' });
      expect(run().status).toBe(0);
    });
  });

  // 防止の後半: 通った root だけ、その root に入っている allowlist の名前を `npm rebuild <names>` する。
  describe('--rebuild', () => {
    it('rebuilds exactly the installed allowlisted names in the root directory and succeeds', () => {
      pkg('node_modules/esbuild', { name: 'esbuild', scripts: { postinstall: 'node install.js' } });
      pkg('node_modules/@swc/core', { name: '@swc/core', scripts: { postinstall: 'node postinstall.js' } });
      pkg('node_modules/plain/node_modules/keccak', { name: 'keccak' }, { 'binding.gyp': '{}' });
      lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true }, 'node_modules/@swc/core': { hasInstallScript: true }, 'node_modules/plain/node_modules/keccak': {} });
      const npm = fakeNpm();
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(0);
      const calls = npm.calls();
      expect(calls).toHaveLength(1);
      const [cwd, args] = calls[0].split('|');
      expect(cwd).toBe(root);
      expect(args.split(' ').sort()).toEqual(['@swc/core', 'esbuild', 'keccak', 'rebuild']);
      expect(result.stdout).toContain('npm rebuild');
    });

    it('runs npm rebuild in the directory that owns the root (tools/… lockfile)', () => {
      pkg('tools/example/node_modules/esbuild', { name: 'esbuild', scripts: { postinstall: 'x' } });
      lock({ 'node_modules/esbuild': { hasInstallScript: true } }, 'tools/example/package-lock.json');
      const npm = fakeNpm();
      const result = run(['--rebuild', 'tools/example/node_modules'], { PATH: npm.path });
      expect(result.status).toBe(0);
      expect(npm.calls()).toEqual([`${join(root, 'tools/example')}|rebuild esbuild`]);
    });

    it('does not call npm when nothing allowlisted is installed (never a bare npm rebuild)', () => {
      const npm = fakeNpm();
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(0);
      expect(npm.calls()).toEqual([]);
      expect(result.stdout).toContain('nothing to rebuild');
    });

    it('does not rebuild anything when the gate fails', () => {
      pkg('node_modules/esbuild', { name: 'esbuild', scripts: { postinstall: 'x' } });
      pkg('node_modules/evil-postinstall', { name: 'evil-postinstall', scripts: { postinstall: 'x' } });
      lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true }, 'node_modules/evil-postinstall': {} });
      const npm = fakeNpm();
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(1);
      expect(npm.calls()).toEqual([]);
    });

    it('does not rebuild linked packages (their scripts are governed by the linked allowlist only)', () => {
      pkg('packages/esbuild', { name: 'esbuild' });
      symlinkSync(join(root, 'packages/esbuild'), join(root, 'node_modules/esbuild'), 'dir');
      const npm = fakeNpm();
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(0);
      expect(npm.calls()).toEqual([]);
    });

    it('fails when npm rebuild fails', () => {
      pkg('node_modules/esbuild', { name: 'esbuild', scripts: { postinstall: 'x' } });
      lock({ ...BASE, 'node_modules/esbuild': { hasInstallScript: true } });
      const npm = fakeNpm(3);
      const result = run(['--rebuild', 'node_modules'], { PATH: npm.path });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('npm rebuild');
    });
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
