import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/lockfile-gate.mjs');
const OFFICIAL = 'https://registry.npmjs.org/';
let root: string;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function fixture(path: string, text: string, tracked = true) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (tracked) git('add', '--force', '--', path);
}

function lockfile(resolved = `${OFFICIAL}example/-/example-1.0.0.tgz`) {
  return JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { resolved } } });
}

function runGate(env: Partial<NodeJS.ProcessEnv> = {}) {
  // The pre-install gate needs only Node and Git; fixtures never install packages.
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

beforeEach(() => {
  root = mkdtempSync(resolve('.lockfile-gate-test-'));
  // An isolated index models tracked checkout files without making any commits.
  git('init', '--quiet');
  fixture('package-lock.json', lockfile());
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('lockfile-gate CLI', () => {
  it('accepts official lockfiles without .npmrc or node_modules', () => {
    expect(runGate().status).toBe(0);
  });

  it.each(['.npmrc', 'packages/example/.npmrc'])('accepts safe settings and INI comments in %s', (path) => {
    fixture(path, '# registry=https://evil.example/\r\n; userconfig=./cfg/npm.ini\r\nlegacy-peer-deps = true ; allowed\r\n\r\n');
    expect(runGate().status).toBe(0);
  });

  it.each(['.npmrc', 'packages/example/.npmrc', 'packages/example/nested/.npmrc', '.config/example/.npmrc', 'packages/.hidden/.npmrc', 'node_modules/tracked/.npmrc'])('rejects a tracked registry redirect in %s without a package lock beside it', (path) => {
    fixture(path, 'registry=https://evil.example/\n');
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain('registry');
  });

  it.each([
    'registry=http://registry.npmjs.org/',
    'registry=https://registry.npmjs.org',
    `registry=${OFFICIAL}`,
    `@scope:registry=${OFFICIAL}`,
    'registry=https://registry.npmjs.org.evil.example/',
    'registry=https://registry.npmjs.org/other/',
    'registry=https://registry.npmjs.org@evil.example/',
    'registry=${NPM_REGISTRY}',
    '@scope:registry=https://evil.example/',
    ' @scope:registry = "https://evil.example/" ',
    '"registry"=https://evil.example/',
    "'@scope:registry'=https://evil.example/",
    '"\\u0072egistry"=https://evil.example/',
    'registry[]=https://evil.example/',
    '@scope:registry[]=https://evil.example/',
    'registry=',
    'registry',
    `registry=https://evil.example/\nregistry=${OFFICIAL}`,
    `registry=${OFFICIAL}\n@scope:registry=https://evil.example/`,
  ])('rejects unsafe registry configuration: %s', (setting) => {
    fixture('.npmrc', `${setting}\n`);
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.npmrc');
    expect(result.stderr).toContain('only legacy-peer-deps is allowed');
  });

  it.each([
    'legacy-peer-deps=true',
    '"legacy-peer-deps"="true"',
    "'legacy-peer-deps'=false",
    '"legacy\\u002dpeer-deps"=true',
  ])('accepts the allowlisted INI key: %s', (setting) => {
    fixture('.npmrc', setting);
    expect(runGate().status).toBe(0);
  });

  const forbiddenSettings = [
    ['userconfig', './cfg/npm.ini'],
    ['globalconfig', './cfg/npm.ini'],
    ['proxy', 'https://secret-token@evil.example/'],
    ['https-proxy', 'https://secret-token@evil.example/'],
    ['strict-ssl', 'false'],
    ['ca', 'custom-certificate'],
    ['cafile', './cfg/certificate.pem'],
    ['replace-registry-host', 'evil.example'],
    ['registry', OFFICIAL],
  ];
  describe.each(['.npmrc', 'packages/example/.npmrc'])('key allowlist in %s', (path) => {
    it.each(forbiddenSettings)('rejects %s=%s', (key, value) => {
      // Indirection targets deliberately lack a .npmrc name, as in the review reproduction.
      fixture('cfg/npm.ini', 'registry=https://evil.example/\n');
      fixture(path, `legacy-peer-deps=true\n${key}=${value}\n`);
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${path}:2`);
      expect(result.stderr).toContain(key);
      expect(result.stderr).toContain('only legacy-peer-deps is allowed');
      expect(result.stderr).not.toContain(value);
    });
  });

  it.each([
    '"userconfig"=./cfg/npm.ini',
    "'globalconfig'=./cfg/npm.ini",
    '"\\u0075serconfig"=./cfg/npm.ini',
    'ca[]=custom-certificate',
    'future-config-key=value',
  ])('rejects disguised and unknown keys: %s', (setting) => {
    fixture('.npmrc', setting);
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only legacy-peer-deps is allowed');
  });

  it('ignores untracked dependency-owned .npmrc files', () => {
    fixture('node_modules/example/.npmrc', 'registry=https://evil.example/', false);
    expect(runGate().status).toBe(0);
  });

  it('fails closed if Git cannot enumerate tracked .npmrc files', () => {
    const result = runGate({ GIT_DIR: join(root, 'missing-git-dir') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot list tracked .npmrc files');
  });

  it.each(['git+https://example.com/repo.git', 'http://registry.npmjs.org/example.tgz', 'https://evil.example/example.tgz'])('still rejects nonofficial lockfile URLs: %s', (url) => {
    fixture('packages/example/package-lock.json', lockfile(url));
    expect(runGate().status).toBe(1);
  });

  it('still permits workspace links and packages with no resolved URL', () => {
    fixture('package-lock.json', JSON.stringify({ packages: {
      '': {}, 'node_modules/local': { link: true, resolved: 'packages/local' }, 'node_modules/bundled': {},
    } }));
    expect(runGate().status).toBe(0);
  });

  // 第 7 回レビュー E4 (user 裁定 R4): install script (preinstall/install/postinstall) を持つ
  // 新規パッケージは lockfile の hasInstallScript で機械検出し、allowlist 外なら fail にする。
  describe('install script allowlist (CLAUDE.md 掟 16)', () => {
    function lockWith(entries: Record<string, Record<string, unknown>>) {
      const packages: Record<string, Record<string, unknown>> = { '': {} };
      for (const [path, extra] of Object.entries(entries)) {
        packages[path] = { resolved: `${OFFICIAL}x/-/x-1.0.0.tgz`, ...extra };
      }
      return JSON.stringify({ lockfileVersion: 3, packages });
    }

    it.each([
      'node_modules/esbuild',
      'node_modules/fsevents',
      'node_modules/playwright/node_modules/fsevents',
      'node_modules/@swc/core',
      'node_modules/@sentry/cli',
    ])('accepts the already reviewed install script package at %s', (path) => {
      fixture('package-lock.json', lockWith({ [path]: { hasInstallScript: true } }));
      expect(runGate().status).toBe(0);
    });

    it.each([
      'node_modules/evil-postinstall',
      'node_modules/@scope/evil-postinstall',
      'node_modules/esbuild/node_modules/evil-postinstall',
      'node_modules/esbuild-plugin-evil',
      'node_modules/fsevents-evil',
    ])('rejects a new install script package at %s even from the official registry', (path) => {
      fixture('package-lock.json', lockWith({ [path]: { hasInstallScript: true } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path);
      expect(result.stderr).toContain('install script');
      expect(result.stderr).toContain('INSTALL_SCRIPT_ALLOWLIST');
    });

    it('rejects a workspace package (no node_modules/ in its path) that gains an install script', () => {
      fixture('package-lock.json', lockWith({
        'packages/local': { hasInstallScript: true },
        'node_modules/local': { link: true, resolved: 'packages/local' },
      }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/local');
    });

    it('rejects a new install script package in a nested lockfile too', () => {
      fixture('packages/example/package-lock.json', lockWith({ 'node_modules/evil-postinstall': { hasInstallScript: true } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/example/package-lock.json');
    });

    it('ignores packages without install scripts regardless of name', () => {
      fixture('package-lock.json', lockWith({
        'node_modules/evil-postinstall': {},
        'node_modules/other': { hasInstallScript: false },
      }));
      expect(runGate().status).toBe(0);
    });

    it('lists allowlisted names that no longer have install scripts as stale without failing', () => {
      fixture('package-lock.json', lockWith({ 'node_modules/esbuild': {} }));
      const result = runGate();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stale');
      expect(result.stdout).toContain('fsevents');
    });
  });
});

// 実リポの lockfile と allowlist のドリフトは CI の lockfile-gate 実行 (全 workflow の npm ci 前) が
// 検出する。ここでは allowlist が「現状の固定」であることを lockfile の実体から確かめ、
// allowlist だけ増やして lockfile に無い名前を入れる (= 将来の新規導入を事前に許す) 運用を止める。
describe('install script allowlist matches the committed lockfiles', () => {
  it('every allowlisted name currently has an install script in a committed lockfile', async () => {
    const { INSTALL_SCRIPT_ALLOWLIST } = await import('../../scripts/lib/installScriptAllowlist.mjs');
    const { readFileSync } = await import('node:fs');
    const names = new Set<string>();
    for (const file of ['package-lock.json', 'packages/x402-mcp/package-lock.json', 'tools/lighthouse/package-lock.json']) {
      const lock = JSON.parse(readFileSync(resolve(file), 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean }> };
      for (const [path, pkg] of Object.entries(lock.packages)) {
        if (pkg.hasInstallScript) names.add(path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length));
      }
    }
    expect([...Object.keys(INSTALL_SCRIPT_ALLOWLIST)].sort()).toEqual([...names].sort());
  });
});
