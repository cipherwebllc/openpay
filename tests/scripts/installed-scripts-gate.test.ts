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

beforeEach(() => {
  root = mkdtempSync(resolve('.installed-scripts-gate-test-'));
  pkg('node_modules/plain', { name: 'plain', scripts: { test: 'vitest', build: 'tsc' } });
  pkg('node_modules/@scope/plain', { name: '@scope/plain' });
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
    expect(run('node_modules').status).toBe(0);
    const result = run('node_modules', 'tools/example/node_modules');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tools/example/node_modules/evil-postinstall');
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
