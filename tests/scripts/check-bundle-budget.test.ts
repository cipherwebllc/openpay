import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('./scripts/check-bundle-budget.mjs');
const PAY_ROW = '├ ● /[locale]/pay                                 10.3 kB         426 kB';
const TIP_ROW = '├ ƒ /[locale]/tip/[address]                       12.5 kB         421 kB';
const MANIFEST_ROW = '├ ○ /manifest.webmanifest                           620 B         194 kB';
const SHARED_ROW = '+ First Load JS shared by all                      193 kB';

// 2026-10-30 第 8 回レビュー F-11 で足した /[locale] のページと、その実測 (main b90757b9 の CI の Route 表・kB)。
// 予算は実測 + 5。表に無い route は 300 kB を超えるまで落ちなかったので、/[locale] のページを全部載せた。
const F11_PAGES: Array<[string, number]> = [
  ['/[locale]/admin/billing', 259],
  ['/[locale]/directory', 236],
  ['/[locale]/disclaimer', 214],
  ['/[locale]/explore', 243],
  ['/[locale]/guide', 236],
  ['/[locale]/guide/agent', 238],
  ['/[locale]/guide/ai-pay', 239],
  ['/[locale]/guide/image-url', 237],
  ['/[locale]/guide/mobile-order', 237],
  ['/[locale]/guide/pay', 239],
  ['/[locale]/guide/pos', 237],
  ['/[locale]/guide/qr', 239],
  ['/[locale]/guide/sell', 238],
  ['/[locale]/guide/shop', 239],
  ['/[locale]/guide/start', 237],
  ['/[locale]/guide/store', 239],
  ['/[locale]/guide/wallet', 237],
  ['/[locale]/kit', 236],
  ['/[locale]/license-terms/directory-v1', 236],
  ['/[locale]/license-terms/standard-v1', 236],
  ['/[locale]/me', 237],
  ['/[locale]/news', 254],
  ['/[locale]/order/status', 201],
  ['/[locale]/orders/hall', 260],
  ['/[locale]/orders/kitchen', 260],
  ['/[locale]/orders/pickup', 223],
  ['/[locale]/pricing', 238],
  ['/[locale]/privacy', 215],
  ['/[locale]/store/library', 257],
  ['/[locale]/store/seller/[address]', 236],
  ['/[locale]/terms', 215],
  ['/[locale]/tokutei', 215],
  ['/[locale]/transparency', 236],
];

// 予算対象の route (2026-10-10 第 7 回レビュー F2/E22 で締め直した表と同じ 17 件 + 2026-10-20 の Arc の売上の受け取りページ
// + 2026-10-30 F-11 の 33 ページ)。
const BUDGETED = [
  '/_not-found',
  '/[locale]',
  '/[locale]/[handle]',
  '/[locale]/agent',
  '/[locale]/billing',
  '/[locale]/checkout',
  '/[locale]/create',
  '/[locale]/discovery',
  '/[locale]/discovery/arc-payout',
  '/[locale]/experimental/cross-chain-demo',
  '/[locale]/history',
  '/[locale]/order',
  '/[locale]/pay',
  '/[locale]/scan',
  '/[locale]/store',
  '/[locale]/tip/[address]',
  '/manifest.webmanifest',
  '__shared__',
  ...F11_PAGES.map(([route]) => route),
];

// origin/main 9f80dfda を本番 flag (e2e/prodFlags.env) で build した Route 表 (Next 15.5) から抜粋。
// 予算対象・子ルート・予算外の軽い route (API・metadata)・共有チャンク・Middleware の行を元の表記のまま残す。
// F-11 で足した 33 ページの行は main b90757b9 の CI の Route 表から取った (guide/qr・orders/hall はその値に置き換えた)。
// /pay と /tip は予算ちょうどの値にして「上限は通る」を固定する。
const NORMAL_BUILD_OUTPUT = `
Route (app)                                          Size  First Load JS
┌ ○ /_not-found                                   1.16 kB         195 kB
├ ƒ /.well-known/x402                               621 B         194 kB
├ ● /[locale]                                     9.51 kB         268 kB
├   ├ /ja
├   └ /en
├ ƒ /[locale]/[handle]                              25 kB         459 kB
├ ● /[locale]/admin/billing                       5.68 kB         259 kB
├ ● /[locale]/agent                               19.7 kB         322 kB
├   ├ /ja/agent
├   └ /en/agent
├ ● /[locale]/billing                             12.4 kB         331 kB
├ ● /[locale]/checkout                            20.2 kB         431 kB
├   ├ /ja/checkout
├   └ /en/checkout
├ ● /[locale]/create                              44.3 kB         364 kB
├ ● /[locale]/directory                           3.16 kB         236 kB
├ ● /[locale]/disclaimer                          1.83 kB         214 kB
├ ● /[locale]/discovery                           28.3 kB         310 kB
├ ● /[locale]/discovery/arc-payout                21.8 kB         377 kB
├ ● /[locale]/experimental/cross-chain-demo       18.2 kB         357 kB
├ ● /[locale]/explore                             9.76 kB         243 kB
├ ● /[locale]/guide                               2.46 kB         236 kB
├ ● /[locale]/guide/agent                         1.04 kB         238 kB
├ ● /[locale]/guide/ai-pay                        2.23 kB         239 kB
├ ● /[locale]/guide/image-url                       428 B         237 kB
├ ● /[locale]/guide/mobile-order                    427 B         237 kB
├ ● /[locale]/guide/pay                           1.85 kB         239 kB
├ ● /[locale]/guide/pos                             427 B         237 kB
├ ● /[locale]/guide/qr                            1.85 kB         239 kB
├ ● /[locale]/guide/sell                          1.04 kB         238 kB
├ ● /[locale]/guide/shop                          1.85 kB         239 kB
├ ● /[locale]/guide/start                           427 B         237 kB
├ ● /[locale]/guide/store                         2.23 kB         239 kB
├ ● /[locale]/guide/wallet                          427 B         237 kB
├ ● /[locale]/history                               35 kB         407 kB
├ ● /[locale]/kit                                 2.76 kB         236 kB
├ ● /[locale]/license-terms/directory-v1          2.46 kB         236 kB
├ ● /[locale]/license-terms/standard-v1           2.46 kB         236 kB
├ ● /[locale]/me                                  4.16 kB         237 kB
├ ● /[locale]/news                                20.7 kB         254 kB
├ ● /[locale]/order                               9.47 kB         366 kB
├ ● /[locale]/order/status                        4.72 kB         201 kB
├ ● /[locale]/orders/hall                           358 B         260 kB
├ ● /[locale]/orders/kitchen                        357 B         260 kB
├ ● /[locale]/orders/pickup                       4.92 kB         223 kB
${PAY_ROW}
├   ├ /ja/pay
├   └ /en/pay
├ ● /[locale]/pricing                             4.94 kB         238 kB
├ ● /[locale]/privacy                             1.93 kB         215 kB
├ ● /[locale]/scan                                17.4 kB         388 kB
├ ● /[locale]/store                               5.38 kB         259 kB
├ ● /[locale]/store/library                       15.9 kB         257 kB
├ ƒ /[locale]/store/seller/[address]              2.52 kB         236 kB
├ ● /[locale]/terms                               1.93 kB         215 kB
${TIP_ROW}
├ ● /[locale]/tokutei                             2.19 kB         215 kB
├ ● /[locale]/transparency                        2.98 kB         236 kB
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
    // 予算表の外の API・metadata の route (/.well-known/x402・/api/relay/jpyc・/sitemap.xml) は出さない
    expect(result.stdout).not.toContain('[NO BUDGET]');
  });

  // 第 8 回レビュー F-11: 予算表に無い route は 300 kB を超えるまで落ちなかった (/store/library が 257→290 kB でも通る)。
  // 足した 33 ページが「実測 + 5」で表に載り、予算を 1 kB 超えたら落ちることを固定する。
  it.each(F11_PAGES)('budgets %s at measured %i kB + 5 (F-11)', (route, measured) => {
    const result = runGate(NORMAL_BUILD_OUTPUT);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[OK] ${route}: ${measured} kB / 予算 ${measured + 5} kB`);
  });

  it.each(F11_PAGES)('fails %s 1 kB over its budget (F-11)', (route, measured) => {
    const row = NORMAL_BUILD_OUTPUT.split('\n').find((line) => line.includes(` ${route} `));
    expect(row).toBeDefined();
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(row as string, `├ ● ${route}   1 kB   ${measured + 6} kB`));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`[OVER] ${route}: ${measured + 6} kB / 予算 ${measured + 5} kB`);
    expect(result.stderr).toContain('FAIL:');
  });

  // 第 7 回レビュー E22/F2: 顧客の支払い導線・主要画面が予算の外にあった。表に載っていることを固定する。
  it.each([
    ['/[locale]/order', 371],
    ['/[locale]/scan', 393],
    ['/[locale]/history', 412],
    ['/[locale]/store', 264],
    ['/[locale]/billing', 336],
    ['/[locale]/discovery', 315],
    ['/[locale]/discovery/arc-payout', 382],
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

  // F-11: 300 kB 以下の表に無いページは fail させない (E22 の上限の設計どおり) が、表に無いことは出す。
  it('reports an unbudgeted page route at or below 300 kB without failing (F-11)', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `${PAY_ROW}\n├ ● /[locale]/new-light   12 kB   300 kB`));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('[UNBUDGETED]');
    expect(result.stdout).toContain('[NO BUDGET] /[locale]/new-light: 300 kB');
    expect(result.stdout).toContain('BUDGETS_KB');
    expect(result.stdout).toContain('OK: 全ルートが予算内');
  });

  it('does not report an unbudgeted API route at or below 300 kB (no client JS of its own)', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `${PAY_ROW}\n├ ƒ /api/new-endpoint   620 B   250 kB`));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('[NO BUDGET]');
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

  // Next 15 は生成に 300 ms を超えた route の名前の直後に "(301 ms)" を出す (next/dist/build/utils.js の
  // MIN_DURATION)。この注記を許容しないと、注記付きの予算対象は [MISSING]・予算外の重い route は素通りになる (Codex #789 2 回目 P2)。
  describe('rows with a generation-time note after the route name', () => {
    it('reads a budgeted route with a note within budget', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '├ ● /[locale]/pay (301 ms)                        10.3 kB         426 kB'));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[OK] /[locale]/pay: 426 kB / 予算 426 kB');
      expect(result.stdout).not.toContain('[MISSING]');
    });

    it('fails a budgeted route with a note over budget', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '├ ● /[locale]/pay (1.2 s)                         10.3 kB         427 kB'));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[OVER] /[locale]/pay: 427 kB / 予算 426 kB');
    });

    it('fails an unbudgeted route with a note above 300 kB', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `${PAY_ROW}\n├ ● /[locale]/new-page (301 ms)                   12 kB           301 kB`));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[UNBUDGETED] /[locale]/new-page: 301 kB > 300 kB');
    });

    it('reads a note together with ISR columns', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '├ ◐ /[locale]/pay (2345 ms)                       10.3 kB         427 kB          5m      1y'));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[OVER] /[locale]/pay: 427 kB / 予算 426 kB');
    });

    it('does not count a child path with a note (no sizes) as a route', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace('├   ├ /ja/pay', '├   ├ /ja/pay (450 ms)'));

      expect(result.status).toBe(0);
      expect(result.stdout.match(/\[OK\]/g)).toHaveLength(BUDGETED.length);
    });
  });

  // Next の printTreeView は表が 1 行だけのとき行頭を "─" にする (next/dist/build/utils.js の border 選択)。
  // Pages Router を併設した単一ルートの表などで、`[┌├└]` だけだと数え落として 300 kB 超でも exit 0 になる (Codex #789 3 回目 P3)。
  describe('single-row route table (─ border)', () => {
    const SINGLE_ROW_TABLE = `
Route (pages)                                        Size  First Load JS
─ ○ /legacy-report                                  12 kB         301 kB
${SHARED_ROW}
`;

    it('fails an unbudgeted heavy route in a single-row table', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT + SINGLE_ROW_TABLE);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[UNBUDGETED] /legacy-report: 301 kB > 300 kB');
    });

    it('fails a budgeted route over budget when it is the only row', () => {
      const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '─ ● /[locale]/pay                                 10.3 kB         427 kB'));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[OVER] /[locale]/pay: 427 kB / 予算 426 kB');
    });
  });

  // Next は App / Pages の表ごとに "First Load JS shared by all" を出す。後の値で上書きすると、先の表の
  // 超過が後の表の小さい値に消される (Codex #789 4 回目 P3)。共有値は最大値を保持する。
  it('keeps the largest shared total when a later table (Pages) prints a smaller one', () => {
    const pagesTable = `
Route (pages)                                        Size  First Load JS
─ ○ /legacy-report                                  12 kB         100 kB
+ First Load JS shared by all                      100 kB
`;
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(SHARED_ROW, '+ First Load JS shared by all                      199 kB') + pagesTable);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[OVER] __shared__: 199 kB / 予算 198 kB');
    expect(result.stdout).not.toContain('[OK] __shared__');
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
