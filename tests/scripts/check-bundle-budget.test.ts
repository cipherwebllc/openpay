import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('./scripts/check-bundle-budget.mjs');
const PAY_ROW = '├ ● /[locale]/pay                                 10.3 kB         426 kB';
const TIP_ROW = '├ ƒ /[locale]/tip/[address]                       12.5 kB         421 kB';
const MANIFEST_ROW = '├ ○ /manifest.webmanifest                           620 B         194 kB';
const SHARED_ROW = '+ First Load JS shared by all                      193 kB';

// 予算対象の route (2026-10-10 第 7 回レビュー F2/E22 で締め直した表と同じ 17 件)。
const BUDGETED = [
  '/_not-found',
  '/[locale]',
  '/[locale]/[handle]',
  '/[locale]/agent',
  '/[locale]/billing',
  '/[locale]/checkout',
  '/[locale]/create',
  '/[locale]/discovery',
  '/[locale]/experimental/cross-chain-demo',
  '/[locale]/history',
  '/[locale]/order',
  '/[locale]/pay',
  '/[locale]/scan',
  '/[locale]/store',
  '/[locale]/tip/[address]',
  '/manifest.webmanifest',
  '__shared__',
];

// origin/main 9f80dfda を本番 flag (e2e/prodFlags.env) で build した Route 表 (Next 15.5) から抜粋。
// 予算対象・子ルート・予算外の軽い route・共有チャンク・Middleware の行を元の表記のまま残す。
// /pay と /tip は予算ちょうどの値にして「上限は通る」を固定する。
const NORMAL_BUILD_OUTPUT = `
Route (app)                                          Size  First Load JS
┌ ○ /_not-found                                   1.16 kB         195 kB
├ ƒ /.well-known/x402                               621 B         194 kB
├ ● /[locale]                                     9.51 kB         268 kB
├   ├ /ja
├   └ /en
├ ƒ /[locale]/[handle]                              25 kB         459 kB
├ ● /[locale]/agent                               19.7 kB         322 kB
├   ├ /ja/agent
├   └ /en/agent
├ ● /[locale]/billing                             12.4 kB         331 kB
├ ● /[locale]/checkout                            20.2 kB         431 kB
├   ├ /ja/checkout
├   └ /en/checkout
├ ● /[locale]/create                              44.3 kB         364 kB
├ ● /[locale]/discovery                           28.3 kB         310 kB
├ ● /[locale]/experimental/cross-chain-demo       18.2 kB         357 kB
├ ● /[locale]/guide/qr                              417 B         258 kB
├ ● /[locale]/history                               35 kB         407 kB
├ ● /[locale]/order                               9.47 kB         366 kB
├ ● /[locale]/orders/hall                           356 B         280 kB
${PAY_ROW}
├   ├ /ja/pay
├   └ /en/pay
├ ● /[locale]/scan                                17.4 kB         388 kB
├ ● /[locale]/store                               5.38 kB         259 kB
${TIP_ROW}
├ ƒ /api/relay/jpyc                                 620 B         194 kB
${MANIFEST_ROW}
└ ○ /sitemap.xml                                    623 B         194 kB
${SHARED_ROW}
  ├ chunks/2432-5a43ac95e33516bc.js                130 kB
  ├ chunks/4a7b0c69-fc65e240f3a3de4f.js             38 kB
  ├ chunks/4bd1b696-b69dfe69e139caf2.js           54.4 kB
  └ other shared chunks (total)                   8.06 kB


ƒ Middleware                                       134 kB

○  (Static)   prerendered as static content
●  (SSG)      prerendered as static HTML (uses generateStaticParams)
ƒ  (Dynamic)  server-rendered on demand
`;

function runGate(input: string) {
  // stdin のみを渡す。--build の実行や wallet/env ファイルの読み取りは行わない。
  const result = spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe('check-bundle-budget CLI', () => {
  it('passes normal build output, including B sizes and at-budget pay/tip rows', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.match(/\[OK\]/g)).toHaveLength(BUDGETED.length);
    expect(result.stdout).toContain('[OK] /manifest.webmanifest: 194 kB / 予算 199 kB');
    expect(result.stdout).toContain('[OK] /[locale]/pay: 426 kB / 予算 426 kB');
    expect(result.stdout).toContain('[OK] /[locale]/tip/[address]: 421 kB / 予算 421 kB');
    expect(result.stdout).toContain('OK: 全ルートが予算内');
  });

  // 第 7 回レビュー E22/F2: 顧客の支払い導線・主要画面が予算の外にあった。表に載っていることを固定する。
  it.each([
    ['/[locale]/order', 371],
    ['/[locale]/scan', 393],
    ['/[locale]/history', 412],
    ['/[locale]/store', 264],
    ['/[locale]/billing', 336],
    ['/[locale]/discovery', 315],
  ])('budgets %s at %i kB (measured + 5)', (route, budget) => {
    const result = runGate(NORMAL_BUILD_OUTPUT);
    expect(result.stdout).toContain(`[OK] ${route}: `);
    expect(result.stdout).toContain(`/ 予算 ${budget} kB`);
  });

  it('fails an unbudgeted route above 300 kB so heavy pages cannot grow outside the table (E22)', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `${PAY_ROW}\n├ ● /[locale]/new-heavy   12 kB   301 kB`));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[UNBUDGETED] /[locale]/new-heavy: 301 kB > 300 kB');
    expect(result.stdout).toContain('BUDGETS_KB');
    expect(result.stderr).toContain('FAIL:');
  });

  it('ignores unbudgeted routes at or below 300 kB', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `${PAY_ROW}\n├ ● /[locale]/new-light   12 kB   300 kB`));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('[UNBUDGETED]');
  });

  // Next 15 は ISR の route があると First Load JS の後ろに Revalidate / Expire 列 (例 "5m  1y") を出す。
  // 行末のサイズだけを見るパーサーだと ISR 行が落ち、予算内の route は [MISSING]・予算外の重い route は素通りした (Codex #789 P2)。
  describe('ISR rows with trailing Revalidate / Expire columns', () => {
    const ISR_HEADER = 'Route (app)                                          Size  First Load JS  Revalidate  Expire';
    const withHeader = (output: string) => output.replace('Route (app)                                          Size  First Load JS', ISR_HEADER);

    it('reads a budgeted ISR route within budget', () => {
      const result = runGate(withHeader(NORMAL_BUILD_OUTPUT).replace(PAY_ROW, '├ ◐ /[locale]/pay                                 10.3 kB         426 kB          5m      1y'));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[OK] /[locale]/pay: 426 kB / 予算 426 kB');
      expect(result.stdout).not.toContain('[MISSING]');
    });

    it('fails a budgeted ISR route over budget', () => {
      const result = runGate(withHeader(NORMAL_BUILD_OUTPUT).replace(PAY_ROW, '├ ◐ /[locale]/pay                                 10.3 kB         427 kB          1h      1y'));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[OVER] /[locale]/pay: 427 kB / 予算 426 kB');
    });

    it('fails an unbudgeted ISR route above 300 kB', () => {
      const result = runGate(withHeader(NORMAL_BUILD_OUTPUT).replace(PAY_ROW, `${PAY_ROW}\n├ ◐ /[locale]/new-isr                             12 kB           301 kB          30s     1d`));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[UNBUDGETED] /[locale]/new-isr: 301 kB > 300 kB');
    });

    it('still takes First Load JS (the second size), not the Size column, on plain rows', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '├ ● /[locale]/pay                                 427 kB          426 kB'));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[OK] /[locale]/pay: 426 kB / 予算 426 kB');
    });

    it('does not count shared chunk file rows (one size, no route) as routes', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace('  ├ chunks/2432-5a43ac95e33516bc.js                130 kB', '  ├ chunks/2432-5a43ac95e33516bc.js                330 kB'));

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('[UNBUDGETED]');
    });
  });

  it('accepts a route with zero-byte First Load JS', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(MANIFEST_ROW, '├ ○ /manifest.webmanifest   0 B   0 B'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[OK] /manifest.webmanifest: 0 kB / 予算 199 kB');
  });

  it('fails an MB-sized route with its converted size, not a missing measurement', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '├ ƒ /[locale]/pay   12 kB   1.02 MB'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[OVER] /[locale]/pay: 1020 kB / 予算 426 kB');
    expect(result.stderr).toContain('FAIL:');
    expect(result.stdout).not.toContain('OK: 全ルートが予算内');
  });

  it.each([
    ['0 B', '0', 0],
    ['999 B', '0.999', 0],
    ['198 kB', '198', 0],
    ['199 kB', '199', 1],
    ['1.02 MB', '1020', 1],
    ['2.01 MB', '2010', 1],
  ])('checks shared chunks printed as %s', (size, expectedKb, status) => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(SHARED_ROW, `+ First Load JS shared by all   ${size}`));

    expect(result.status).toBe(status);
    expect(result.stdout).toContain(`[${status === 0 ? 'OK' : 'OVER'}] __shared__: ${expectedKb} kB / 予算 198 kB`);
  });

  it.each(['GB', 'TB', 'PB', 'EB', 'ZB', 'YB'])('recognizes Next.js %s output as over budget', (unit) => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `├ ƒ /[locale]/pay   12 kB   1.02 ${unit}`));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[OVER] /[locale]/pay:');
    expect(result.stdout).not.toContain('[MISSING]');
  });

  it.each([
    [PAY_ROW, '/[locale]/pay', '426001 B', '426.001', 426],
    [PAY_ROW, '/[locale]/pay', '427 kB', '427', 426],
    [TIP_ROW, '/[locale]/tip/[address]', '421001 B', '421.001', 421],
    [TIP_ROW, '/[locale]/tip/[address]', '422 kB', '422', 421],
  ])('enforces the tightened budget for %s with %s at %s', (row, route, size, expectedKb, budget) => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(row, `├ ƒ ${route}   12 kB   ${size}`));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`[OVER] ${route}: ${expectedKb} kB / 予算 ${budget} kB`);
  });

  it.each(BUDGETED)('fails when the budgeted entry %s is absent', (route) => {
    const missingOutput = NORMAL_BUILD_OUTPUT.split('\n')
      .filter((line) => route === '__shared__' ? line !== SHARED_ROW : !line.includes(` ${route} `))
      .join('\n');
    const result = runGate(missingOutput);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`[MISSING] ${route}:`);
    expect(result.stdout).toContain('BUDGETS_KB');
    expect(result.stderr).toContain('FAIL:');
    expect(result.stdout).not.toContain('OK: 全ルートが予算内');
  });

  it('requires a deliberate budget table update when a route is renamed', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace('/[locale]/pay ', '/[locale]/payment '));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[MISSING] /[locale]/pay:');
    expect(result.stdout).toContain('BUDGETS_KB');
  });

  it('handles ANSI styling and CRLF in build output', () => {
    const coloredOutput = NORMAL_BUILD_OUTPUT.replace(/(\d+(?:\.\d+)? (?:kB|B))/g, '\u001b[1m\u001b[37m$1\u001b[39m\u001b[22m')
      .replace(/\n/g, '\r\n');
    const result = runGate(coloredOutput);

    expect(result.status).toBe(0);
    expect(result.stdout.match(/\[OK\]/g)).toHaveLength(BUDGETED.length);
  });

  it.each(['', 'Failed to compile.\n'])('preserves exit 2 for output with no route table (%j)', (input) => {
    const result = runGate(input);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ERROR: build 出力から Route 表をパースできませんでした');
  });
});
