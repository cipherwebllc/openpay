import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LUA_REAL_TEST_FILES } from '../../scripts/lib/luaRealTests.mjs';
import { listTestFiles } from '../../scripts/lib/testFileFence.mjs';

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8');
}

describe('GitHub Actions operation guards', () => {
  const workflowFiles = readdirSync(resolve('.github/workflows')).filter((name) => /\.ya?ml$/.test(name));

  it('Lighthouse uses the explicitly approved patch version', () => {
    expect(workflow('lighthouse.yml')).toMatch(/^\s*npx --yes @lhci\/cli@0\.14\.0 autorun\s*$/m);
  });

  it.each(workflowFiles)('%s explicitly limits GITHUB_TOKEN permissions', (name) => {
    const source = workflow(name);
    const permissions = source.match(/^permissions:\n((?:[ \t]+[^\n]*\n|\n)+)/m)?.[1];
    expect(permissions).toBeDefined();
    expect(permissions).toContain('contents: read');
    expect(source).not.toMatch(/^\s+\S+: write\s*$/m);
    if (name === 'post-deploy-verify.yml') expect(permissions).toContain('actions: read');
  });

  it.each(workflowFiles)('%s checks registry sources before every dependency install', (name) => {
    const source = workflow(name);
    const jobs = source.slice(source.indexOf('\njobs:\n')).split(/\n  [\w-]+:\n/).slice(1);
    for (const job of jobs) {
      const install = job.search(/\brun:\s*npm ci\b/);
      if (install === -1) continue;
      const gate = job.indexOf('run: node scripts/lockfile-gate.mjs');
      expect(gate, `${name}: pre-install source gate`).toBeGreaterThan(-1);
      expect(gate, `${name}: pre-install source gate`).toBeLessThan(install);
      expect(job.slice(0, gate)).not.toMatch(/continue-on-error:\s*true/);
    }
  });

  it('CI は typecheck 直後に full ESLint を実行する', () => {
    const source = workflow('ci.yml');
    const typecheck = source.indexOf('- run: npm run typecheck');
    const lint = source.indexOf('- run: npm run lint');
    const tests = source.indexOf('- run: node scripts/run-tests.mjs');

    expect(typecheck).toBeGreaterThan(-1);
    expect(lint).toBeGreaterThan(typecheck);
    expect(tests).toBeGreaterThan(lint);
  });

  it.each([
    { event: 'schedule', configured: true, status: 0, output: 'skip=false' },
    { event: 'workflow_dispatch', configured: true, status: 0, output: 'skip=false' },
    { event: 'schedule', configured: false, status: 0, output: '::warning::' },
    { event: 'workflow_dispatch', configured: false, status: 1, output: '::error::' },
  ])('Pimlico cron keeps main behavior: $event, required secrets=$configured, optional variables absent', ({ event, configured, status, output }) => {
    const source = workflow('pimlico-balance.yml');
    const step = source.slice(source.indexOf('- name: Verify secrets configured'), source.indexOf('- name: Check dependency sources'));
    const script = step.slice(step.indexOf('run: |') + 'run: |'.length)
      .replaceAll('${{ github.event_name }}', event)
      .replaceAll('>> "$GITHUB_OUTPUT"', '');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test',
        PIMLICO_PAYMASTER_POLYGON: configured ? '0x1111111111111111111111111111111111111111' : '',
        PIMLICO_PAYMASTER_BASE: configured ? '0x1111111111111111111111111111111111111111' : '',
        ALERT_WEBHOOK_URL: configured ? 'https://hook.example.com' : '',
      },
    });
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(output);
    if (event === 'schedule' && !configured) expect(result.stdout).toContain('skip=true');
  });

  it('Pimlico cron forwards optional 0.8 addresses and thresholds to the checker', () => {
    const source = workflow('pimlico-balance.yml').split('- name: Check Pimlico balance')[1];
    for (const name of ['PIMLICO_PAYMASTER_POLYGON_V08', 'PIMLICO_PAYMASTER_BASE_V08', 'PIMLICO_PAYMASTER_KAIA_V08']) {
      expect(source).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    for (const name of ['ALERT_THRESHOLD_POL_V08', 'ALERT_THRESHOLD_ETH_V08', 'ALERT_THRESHOLD_KAIA_V08']) {
      expect(source).toContain(`${name}: \${{ vars.${name} }}`);
    }
  });

  // wasmoon (本物の Lua) を使う test は非決定的に落ちるので専用 job で再試行する (2026-09-12 案 1)。
  // 一覧 (scripts/lib/luaRealTests.mjs) と ci.yml・実ファイルのドリフトをここで止める。
  it('CI は Lua 実行系 test を test job から外し lua-real job で再試行する', () => {
    const source = workflow('ci.yml');
    const testsStep = source.indexOf('- run: node scripts/run-tests.mjs');
    expect(source.slice(testsStep, testsStep + 200)).toContain("SKIP_LUA_REAL: '1'");
    expect(source).toContain('lua-real:');
    expect(source).toContain('- run: node scripts/run-lua-tests.mjs');
    // worker 無応答で job がぶら下がらないよう job 側の上限を必須にする (2026-09-12 実害)
    const luaJob = source.slice(source.indexOf('lua-real:'), source.indexOf('- run: node scripts/run-lua-tests.mjs'));
    expect(luaJob).toMatch(/timeout-minutes: \d+/);
    // Coverage step の --exclude は一覧と過不足なく一致する
    const excluded = [...source.matchAll(/--exclude (tests\/\S+)/g)].map((m) => m[1]).sort();
    expect(excluded).toEqual([...LUA_REAL_TEST_FILES].sort());
  });

  it('Lua 実行系 test の一覧は wasmoon / redisLua ハーネスを import する test ファイルと一致する', () => {
    const root = process.cwd();
    const usingWasmoon = listTestFiles(root).filter((file) =>
      /from ['"]wasmoon['"]|\/redisLua['"]/.test(readFileSync(resolve(root, file), 'utf8')),
    );
    for (const file of LUA_REAL_TEST_FILES) expect(existsSync(resolve(root, file))).toBe(true);
    expect([...usingWasmoon].sort()).toEqual([...LUA_REAL_TEST_FILES].sort());
  });

  it('reverify cron は CRON_SECRET 欠落を error annotation + failure にする', () => {
    const source = workflow('reverify-cron.yml');
    const missingSecretBranch = source.match(
      /if \[ -z "\$CRON_SECRET" \]; then([\s\S]*?)fi/,
    )?.[1];

    expect(missingSecretBranch).toContain('::error::');
    expect(missingSecretBranch).toContain('exit 1');
    expect(missingSecretBranch).not.toContain('exit 0');
  });
});
