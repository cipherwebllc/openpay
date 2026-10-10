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
    fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
      '': {}, 'node_modules/local': { link: true, resolved: 'packages/local' }, 'node_modules/bundled': {},
    } }));
    expect(runGate().status).toBe(0);
  });

  // Codex レビュー (PR #778) 4: 隠しディレクトリの lockfile と npm-shrinkwrap.json も npm ci が読む。
  describe('lockfile enumeration', () => {
    it.each([
      '.config/example/package-lock.json',
      'packages/.hidden/package-lock.json',
      'npm-shrinkwrap.json',
      'packages/example/npm-shrinkwrap.json',
    ])('checks the tracked lockfile %s', (path) => {
      fixture(path, lockfile('https://evil.example/example.tgz'));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path);
    });

    it('ignores an untracked lockfile left in the checkout (npm ci in CI only sees committed files)', () => {
      fixture('scratch/package-lock.json', lockfile('https://evil.example/example.tgz'), false);
      expect(runGate().status).toBe(0);
    });
  });

  // Codex レビュー (PR #778) 5: lockfileVersion 1 は packages が無く、旧実装は "-1 entries checked" で成功していた。
  describe('lockfile format', () => {
    it.each([
      ['lockfileVersion 1 (dependencies only)', { lockfileVersion: 1, dependencies: { example: { version: '1.0.0', resolved: 'https://evil.example/example.tgz' } } }],
      ['missing lockfileVersion', { packages: { '': {} } }],
      ['missing packages', { lockfileVersion: 3 }],
      ['packages is not an object', { lockfileVersion: 3, packages: [] }],
      ['lockfileVersion 2 without packages', { lockfileVersion: 2, dependencies: {} }],
    ])('fails closed for %s', (_label, lock) => {
      fixture('package-lock.json', JSON.stringify(lock));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lockfileVersion');
      expect(result.stdout).not.toContain('entries checked');
    });

    it('accepts lockfileVersion 2 with packages', () => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 2, packages: { '': {}, 'node_modules/example': { resolved: `${OFFICIAL}example/-/example-1.0.0.tgz` } }, dependencies: {} }));
      expect(runGate().status).toBe(0);
    });
  });

  // Codex レビュー (PR #778) 1: URL 正規化前に名前を取ると、dot segment で allowlist の名前を借用できる。
  // 取得元は `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz` の形だけを許す。
  describe('registry tarball URL shape', () => {
    it.each([
      `${OFFICIAL}esbuild/-/../../evil-postinstall/-/evil-postinstall-1.0.0.tgz`,
      `${OFFICIAL}esbuild/-/%2e%2e/%2e%2e/evil-postinstall/-/evil-postinstall-1.0.0.tgz`,
      `${OFFICIAL}esbuild/-/%2E%2E/evil-1.0.0.tgz`,
      `${OFFICIAL}esbuild/./-/esbuild-1.0.0.tgz`,
      `${OFFICIAL}esbuild/-/evil-postinstall-1.0.0.tgz`,
      `${OFFICIAL}esbuild/-/esbuild-1.0.0.tgz?x=1`,
      `${OFFICIAL}esbuild/-/esbuild-1.0.0.tgz#frag`,
      `${OFFICIAL}esbuild/-/esbuild-1.0.0.zip`,
      `${OFFICIAL}esbuild//-/esbuild-1.0.0.tgz`,
      `${OFFICIAL}esbuild/-/sub/esbuild-1.0.0.tgz`,
      `${OFFICIAL}-/esbuild-1.0.0.tgz`,
      `${OFFICIAL}@scope/-/scope-1.0.0.tgz`,
      `${OFFICIAL}@scope/esbuild/x/-/esbuild-1.0.0.tgz`,
      `${OFFICIAL}%40scope/-/scope-1.0.0.tgz`,
      `${OFFICIAL}es%40build/-/esbuild-1.0.0.tgz`,
      `${OFFICIAL}%40%40scope/esbuild/-/esbuild-1.0.0.tgz`,
      `${OFFICIAL}@scope/es%40build/-/esbuild-1.0.0.tgz`,
      'https://registry.npmjs.org:443/esbuild/-/esbuild-1.0.0.tgz',
      'https://user@registry.npmjs.org/esbuild/-/esbuild-1.0.0.tgz',
      'https://REGISTRY.NPMJS.ORG/esbuild/-/esbuild-1.0.0.tgz',
    ])('rejects a malformed or traversing tarball URL as a source violation: %s', (url) => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/esbuild': { resolved: url } } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
    });

    it('rejects an install script package whose tarball URL borrows an allowlisted name through dot segments', () => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': {},
        'node_modules/esbuild': { hasInstallScript: true, resolved: `${OFFICIAL}esbuild/-/../../evil-postinstall/-/evil-postinstall-1.0.0.tgz` },
      } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
    });

    it.each([
      ['unscoped', 'node_modules/esbuild', `${OFFICIAL}esbuild/-/esbuild-0.21.5.tgz`],
      ['scoped with a slash', 'node_modules/@parcel/watcher', `${OFFICIAL}@parcel/watcher/-/watcher-2.5.6.tgz`],
      ['scoped with %2f', 'node_modules/@parcel/watcher', `${OFFICIAL}@parcel%2fwatcher/-/watcher-2.5.6.tgz`],
      ['scoped with %2F', 'node_modules/@parcel/watcher', `${OFFICIAL}@parcel%2Fwatcher/-/watcher-2.5.6.tgz`],
      // Codex レビュー 2 回目 (PR #778) 4: scope の @ を %40 で書いた形も npm が出す正規の URL。
      ['scoped with %40 and a slash', 'node_modules/@parcel/watcher', `${OFFICIAL}%40parcel/watcher/-/watcher-2.5.6.tgz`],
      ['scoped with %40 and %2F', 'node_modules/@parcel/watcher', `${OFFICIAL}%40parcel%2Fwatcher/-/watcher-2.5.6.tgz`],
      ['scoped with %40 and %2f', 'node_modules/@parcel/watcher', `${OFFICIAL}%40parcel%2fwatcher/-/watcher-2.5.6.tgz`],
      ['prerelease version', 'node_modules/esbuild', `${OFFICIAL}esbuild/-/esbuild-1.0.0-beta.1.tgz`],
    ])('accepts a well-formed %s tarball URL', (_label, path, url) => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [path]: { hasInstallScript: true, resolved: url } } }));
      expect(runGate().status).toBe(0);
    });
  });

  // Codex レビュー (PR #778) 2: npm は hasInstallScript を truthy で見るので、"true" (文字列) でも script は走る。
  describe('hasInstallScript type', () => {
    it.each(['true', 'false', 1, 0, {}, [], null])('fails closed when hasInstallScript is %j instead of a boolean', (value) => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': {}, 'node_modules/evil-postinstall': { hasInstallScript: value, resolved: `${OFFICIAL}evil-postinstall/-/evil-postinstall-1.0.0.tgz` },
      } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/evil-postinstall');
      expect(result.stderr).toContain('hasInstallScript');
    });

    it('still accepts an explicit false', () => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': {}, 'node_modules/evil-postinstall': { hasInstallScript: false, resolved: `${OFFICIAL}evil-postinstall/-/evil-postinstall-1.0.0.tgz` },
      } }));
      expect(runGate().status).toBe(0);
    });
  });

  // 第 7 回レビュー E4 (user 裁定 R4): install script (preinstall/install/postinstall) を持つ
  // 新規パッケージは lockfile の hasInstallScript で機械検出し、allowlist 外なら fail にする。
  describe('install script allowlist (CLAUDE.md 掟 16)', () => {
    function lockWith(entries: Record<string, Record<string, unknown>>) {
      const packages: Record<string, Record<string, unknown>> = { '': {} };
      for (const [path, extra] of Object.entries(entries)) {
        // 取得元の tarball は path のパッケージ名どおり (別名でない通常の依存)。
        const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const file = name.slice(name.lastIndexOf('/') + 1);
        packages[path] = { resolved: `${OFFICIAL}${name}/-/${file}-1.0.0.tgz`, ...extra };
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

    // npm の別名 ("esbuild": "npm:evil-postinstall@1.0.0") は path が allowlist の名前のまま、実体は別パッケージになる。
    it.each([
      ['a tarball of another package', { resolved: `${OFFICIAL}evil-postinstall/-/evil-postinstall-1.0.0.tgz` }],
      ['an aliased lockfile name', { name: 'evil-postinstall' }],
      ['a scoped package tarball', { resolved: `${OFFICIAL}@evil/esbuild/-/esbuild-1.0.0.tgz` }],
      ['no resolved tarball', { resolved: undefined }],
    ])('rejects an allowlisted name whose install script entry is %s', (_label, extra) => {
      fixture('package-lock.json', lockWith({ 'node_modules/esbuild': { hasInstallScript: true, ...extra } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('node_modules/esbuild');
      expect(result.stderr).toContain('allowlisted by name');
    });

    it('accepts an allowlisted scoped package fetched under its own (URL-encoded) name', () => {
      fixture('package-lock.json', lockWith({
        'node_modules/@parcel/watcher': { hasInstallScript: true, resolved: `${OFFICIAL}@parcel%2fwatcher/-/watcher-2.5.6.tgz` },
      }));
      expect(runGate().status).toBe(0);
    });

    // Codex レビュー 4 回目 (PR #778) 1: 同梱 (inBundle) の実体は resolved も hasInstallScript も無いまま入る。
    // allowlist の名前が同梱で現れる lockfile は、実体 gate (installed-scripts-gate) に行く前に止める。
    it.each(['node_modules/esbuild', 'node_modules/parent/node_modules/esbuild', 'node_modules/@parcel/watcher'])('rejects a bundled copy of an allowlisted name at %s', (path) => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': {},
        'node_modules/parent': { resolved: `${OFFICIAL}parent/-/parent-1.0.0.tgz` },
        [path]: { inBundle: true, version: '1.0.0' },
      } }));
      const result = runGate();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path);
      expect(result.stderr).toContain('bundled');
    });

    it('still accepts a bundled copy of a name outside the allowlist (no install script flag)', () => {
      fixture('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': {},
        'node_modules/parent': { resolved: `${OFFICIAL}parent/-/parent-1.0.0.tgz` },
        'node_modules/parent/node_modules/helper': { inBundle: true, version: '1.0.0' },
      } }));
      expect(runGate().status).toBe(0);
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
