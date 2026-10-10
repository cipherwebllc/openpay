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
    const tests = source.indexOf('run: node scripts/run-tests.mjs');

    expect(typecheck).toBeGreaterThan(-1);
    expect(lint).toBeGreaterThan(typecheck);
    expect(tests).toBeGreaterThan(lint);
  });

  it('CI は SDK の node:test (保護配布 verifier・license gate) を test job で実行する', () => {
    const source = workflow('ci.yml');
    const tests = source.indexOf('run: node scripts/run-tests.mjs');
    const sdk = source.indexOf('run: npm --prefix packages/x402-sdk test');
    expect(sdk).toBeGreaterThan(tests);
    // SDK の step 全体 (name から次の step まで) に continue-on-error を付けさせない (run の後ろに付けても検出する)。
    const stepStart = source.lastIndexOf('- name: SDK tests (node:test)', sdk);
    const nextStep = source.indexOf('\n      - ', sdk);
    const step = source.slice(stepStart, nextStep === -1 ? undefined : nextStep);
    expect(stepStart).toBeGreaterThan(tests);
    // コメント行は除く (次の step の説明文に「continue-on-error」という語が出るため)。
    const keys = step.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(keys).not.toMatch(/continue-on-error\s*:/);
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/x402-sdk/package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('node --test tests/*.test.mjs');
    expect(pkg.scripts.prepublishOnly).toBe('npm test');
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
    const testsStep = source.indexOf('run: node scripts/run-tests.mjs');
    expect(source.slice(testsStep, testsStep + 200)).toContain("SKIP_LUA_REAL: '1'");
    expect(source).toContain('lua-real:');
    expect(source).toContain('- run: node scripts/run-lua-tests.mjs');
    // worker 無応答で job がぶら下がらないよう job 側の上限を必須にする (2026-09-12 実害)
    const luaJob = source.slice(source.indexOf('lua-real:'), source.indexOf('- run: node scripts/run-lua-tests.mjs'));
    expect(luaJob).toMatch(/timeout-minutes: \d+/);
    // full vitest は coverage 付きの 1 回だけ (第 7 回レビュー E13)。除外は run-tests.mjs が luaRealTests.mjs から付けるので、
    // ci.yml に別の vitest 実行 (手書きの --exclude 一覧) を持たない。
    expect(source.slice(testsStep, testsStep + 200)).toContain("RUN_TESTS_COVERAGE: '1'");
    expect(source).not.toMatch(/vitest run --coverage/);
    expect([...source.matchAll(/--exclude (tests\/\S+)/g)]).toHaveLength(0);
  });

  // bundle 予算は本番で点灯している公開 flag の build で測る (第 7 回レビュー E7)。NEXT_PUBLIC_* は build 時に値へ
  // 置換されるので、flag OFF の build では本番で到達するコードが入らず、本番の bundle が予算を超えても CI が通る。
  // 正本は e2e/prodFlags.env (e2e-prodflags job と同じ 1 本のベクター・Vercel 実値との照合は user)。build を増やさず
  // 既存の test job の build を本番 flag にする。e2e の flags-OFF suite の build env は掟 2 のとおり変えない。
  it('CI の bundle 予算は本番 flag (e2e/prodFlags.env) で build して測り、e2e の flags-OFF build は変えない', () => {
    const source = workflow('ci.yml');
    const testJob = source.slice(source.indexOf('\n  test:\n'), source.indexOf('\n  lua-real:\n'));
    const loadVector = "sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' e2e/prodFlags.env >> \"$GITHUB_ENV\"";
    const vector = testJob.indexOf(loadVector);
    const build = testJob.indexOf('npm run build');
    const budget = testJob.indexOf('node scripts/check-bundle-budget.mjs');
    expect(vector, 'test job loads e2e/prodFlags.env into GITHUB_ENV').toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(vector);
    expect(budget).toBeGreaterThan(build);
    // build step に flag を上書きする env を持たせない (正本は e2e/prodFlags.env の 1 本だけ)
    const buildStep = testJob.slice(testJob.lastIndexOf('- name:', build));
    expect(buildStep).not.toMatch(/NEXT_PUBLIC_\w+:/);
    // e2e-prodflags と同じ読み込み方 (コメント・空行を除いて GITHUB_ENV へ) に揃え、片方だけ変わるドリフトを止める
    const e2e = workflow('e2e.yml');
    expect(e2e).toContain(loadVector);
    // flags-OFF の playwright job は CI の最小 env が権威 (掟 2): ベクターを読まない
    const playwrightJob = e2e.slice(e2e.indexOf('\n  playwright:\n'), e2e.indexOf('\n  e2e-prodflags:\n'));
    expect(playwrightJob).not.toContain('prodFlags.env');
    expect(playwrightJob).toContain('NEXT_PUBLIC_NETWORK_ENV: testnet');
  });

  it('run-tests.mjs は coverage の下限を共有の値で判定し、要約が無い・下限割れを fail にする (終了コード任せにしない)', () => {
    const runner = readFileSync(resolve(process.cwd(), 'scripts/run-tests.mjs'), 'utf8');
    expect(runner).toContain("from './lib/coverageThresholds.mjs'");
    expect(runner).toContain("process.env.RUN_TESTS_COVERAGE === '1'");
    // assertion の外の未処理エラーは JSON の numFailedTests に載らないので、専用 reporter で数えて判定する
    // (判定そのものは tests/scripts/run-tests-verdict.test.ts が値で固定する)
    expect(runner).toContain("'--reporter=./scripts/lib/unhandledErrorsReporter.mjs'");
    expect(runner).toContain('evaluateUnhandled(unhandledText)');
    expect(runner).toContain('evaluateCoverage(text)');
    // 成功で終わるすべての出口で coverage を確かめる
    const exits = [...runner.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1]);
    expect(exits.filter((e) => e.trim() === '0')).toHaveLength(0);
    const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');
    expect(config).toContain('thresholds: { ...COVERAGE_THRESHOLDS }');
    expect(config).toContain("'json-summary'");
    expect(LUA_REAL_TEST_FILES.length).toBeGreaterThan(0);
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
