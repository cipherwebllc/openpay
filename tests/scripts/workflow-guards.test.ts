import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LUA_REAL_TEST_FILES } from '../../scripts/lib/luaRealTests.mjs';
import { listTestFiles } from '../../scripts/lib/testFileFence.mjs';
import { installGuardViolations } from '../../scripts/lib/workflowRun.mjs';

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8');
}

describe('GitHub Actions operation guards', () => {
  const workflowFiles = readdirSync(resolve('.github/workflows')).filter((name) => /\.ya?ml$/.test(name));

  // 第 7 回レビュー E5: `npx --yes @lhci/cli@x` は推移的依存を実行のたびに lockfile 外で解決する
  // (掟 16 の gate 外・LHCI_GITHUB_APP_TOKEN を持つ step)。@lhci/cli は tools/lighthouse の lockfile で固定する。
  it('Lighthouse は lockfile 経由 (tools/lighthouse) の @lhci/cli を使い、npx で都度解決しない', () => {
    // コメント行は除く (旧手順の説明に npx の語が出るため)。
    const source = workflow('lighthouse.yml').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(source).not.toMatch(/npx\b/);
    expect(source).not.toMatch(/@lhci\/cli@/);
    expect(source).toMatch(/^\s*run: npm --prefix tools\/lighthouse ci --ignore-scripts\s*$/m);
    // lockfile-gate (install script allowlist を含む) → npm ci (本体) → lhci の install の順
    const gate = source.indexOf('run: node scripts/lockfile-gate.mjs');
    const lhciInstall = source.indexOf('run: npm --prefix tools/lighthouse ci');
    expect(gate).toBeGreaterThan(-1);
    expect(lhciInstall).toBeGreaterThan(gate);
    // Codex レビュー (PR #778) 6: autorun は collect (= .lighthouserc.json の `npm run start` でアプリと依存を起動) と
    // upload を同じ env で回すので、LHCI_GITHUB_APP_TOKEN がアプリ側の process にも渡っていた。
    // token は upload の step だけに渡し、collect / assert の step には env を付けない。
    expect(source).not.toMatch(/lhci autorun/);
    const steps = source.split(/\n(?=\s+- name: )/).filter((step) => /\blhci (collect|assert|upload)\b/.test(step));
    const byCommand = Object.fromEntries(steps.map((step) => [step.match(/\blhci (collect|assert|upload)\b/)![1], step]));
    expect(Object.keys(byCommand).sort()).toEqual(['assert', 'collect', 'upload']);
    expect(byCommand.collect).not.toContain('LHCI_GITHUB_APP_TOKEN');
    expect(byCommand.assert).not.toContain('LHCI_GITHUB_APP_TOKEN');
    expect(byCommand.upload).toContain('LHCI_GITHUB_APP_TOKEN: ${{ secrets.LHCI_GITHUB_APP_TOKEN }}');
    // job 全体の env に token を置かない (step の env だけ)
    const jobEnv = source.slice(source.indexOf('\njobs:'), source.indexOf('    steps:'));
    expect(jobEnv).not.toContain('LHCI_GITHUB_APP_TOKEN');
    // Codex レビュー 2 回目 (PR #778) 3: upload は assertion-results.json を読んで GitHub の status を決めるので、
    // assert の**後**に走らせる (前だとスコアに関係なく success を投稿する)。collect が成功していれば assert が
    // 失敗しても upload は走る (status に failure を載せる)。upload の失敗は autorun と同じく警告止まり。
    expect(source.indexOf('lhci collect')).toBeLessThan(source.indexOf('lhci assert'));
    expect(source.indexOf('lhci assert')).toBeLessThan(source.indexOf('lhci upload'));
    expect(byCommand.collect).toMatch(/^\s+id: collect\s*$/m);
    expect(byCommand.upload).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.collect\.outcome == 'success' \}\}/);
    expect(byCommand.upload).toMatch(/continue-on-error:\s*true/);
    expect(byCommand.assert).not.toMatch(/continue-on-error/);
    expect(byCommand.assert).not.toMatch(/^\s+if:/m);
    // 版は tools/lighthouse/package.json の exact pin と lockfile の実体で固定する (承認済み 0.14.0)。
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'tools/lighthouse/package.json'), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies).toEqual({ '@lhci/cli': '0.14.0' });
    const lock = JSON.parse(readFileSync(resolve(process.cwd(), 'tools/lighthouse/package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/@lhci/cli'].version).toBe('0.14.0');
  });

  it.each(workflowFiles)('%s explicitly limits GITHUB_TOKEN permissions', (name) => {
    const source = workflow(name);
    const permissions = source.match(/^permissions:\n((?:[ \t]+[^\n]*\n|\n)+)/m)?.[1];
    expect(permissions).toBeDefined();
    expect(permissions).toContain('contents: read');
    expect(source).not.toMatch(/^\s+\S+: write\s*$/m);
    if (name === 'post-deploy-verify.yml') expect(permissions).toContain('actions: read');
  });

  // Codex レビュー 4 回目 (PR #778) 2: run を YAML の別書式 (block scalar・引用符) まで読み、1 step 内の複数コマンドも
  // 1 つずつ見る。読めない形は parseWorkflowJobs が throw して test が落ちる (fail-closed)。
  // 5 回目 2・3: ラッパー / サブシェル / 展開 / 行継続での npm と、読み残しうる YAML (引用符付きの key・複数行の scalar・
  // escape 付きの二重引用符・揃っていないインデント・step 0 件の job) も throw する (scripts/lib/workflowRun.mjs)。
  // 守る相手は保守者のうっかり (docs/DEPLOY_CHECKLIST.md §7.14 の脅威モデル)。
  // Codex レビュー (PR #778) 3 → 3 回目で「防止」: 全 workflow の全 install は `npm ci --ignore-scripts` (install
  // script も binding.gyp の暗黙 node-gyp rebuild も走らない) にし、直後に scripts/installed-scripts-gate.mjs が
  // 実体を走査して allowlist 外があれば fail、通ったら `--rebuild` で allowlist の名前だけ `npm rebuild` する。
  // = allowlist 外の install script 付き依存は一度も実行されずに CI で止まる (CLAUDE.md 掟 16)。
  // 5 回目 4: `npx --no` もローカル bin に限られない (npm 10.9 は global の bin や npx の cache を実行しうり、registry の
  // manifest 取得にも進む) ので npx は全面禁止。規則の本体は installGuardViolations (fixture の検査は
  // tests/scripts/workflow-run.test.ts)。
  it.each(workflowFiles)('%s checks sources, installs with --ignore-scripts and rebuilds only allowlisted packages after the gate', (name) => {
    expect(installGuardViolations(workflow(name), name)).toEqual([]);
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
