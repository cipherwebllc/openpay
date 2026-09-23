import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('./scripts/check-bundle-budget.mjs');
const PAY_ROW = '├ ● /[locale]/pay                                 15.4 kB         448 kB';
const TIP_ROW = '├ ƒ /[locale]/tip/[address]                       10.8 kB         446 kB';
const MANIFEST_ROW = '├ ○ /manifest.webmanifest                           606 B         231 kB';
const SHARED_ROW = '+ First Load JS shared by all                      231 kB';

// main CI run 35783655215 (a93cdb57、Next 15.5.25) の実 build ログから抜粋。
// 予算対象・子ルート・共有チャンク・Middleware の行を元の表記のまま残す。
const NORMAL_BUILD_OUTPUT = `
Route (app)                                          Size  First Load JS
┌ ○ /_not-found                                   1.17 kB         232 kB
├ ● /[locale]                                     9.67 kB         301 kB
├   ├ /ja
├   └ /en
├ ƒ /[locale]/[handle]                            34.6 kB         485 kB
├ ● /[locale]/agent                               9.57 kB         354 kB
├   ├ /ja/agent
├   └ /en/agent
├ ● /[locale]/checkout                            14.2 kB         451 kB
├   ├ /ja/checkout
├   └ /en/checkout
├ ● /[locale]/create                              31.4 kB         385 kB
├   ├ /ja/create
├   └ /en/create
${PAY_ROW}
├   ├ /ja/pay
├   └ /en/pay
${TIP_ROW}
${MANIFEST_ROW}
└ ○ /sitemap.xml                                    606 B         231 kB
${SHARED_ROW}
  ├ chunks/2432-5a43ac95e33516bc.js                130 kB
  ├ chunks/4a7b0c69-fc65e240f3a3de4f.js             38 kB
  ├ chunks/4bd1b696-b69dfe69e139caf2.js           54.4 kB
  └ other shared chunks (total)                   8.06 kB


ƒ Middleware                                       133 kB

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
  it('passes normal build output, including B sizes and unchanged pay/tip budgets', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.match(/\[OK\]/g)).toHaveLength(10);
    expect(result.stdout).toContain('[OK] /manifest.webmanifest: 231 kB / 予算 250 kB');
    expect(result.stdout).toContain('[OK] /[locale]/pay: 448 kB / 予算 448 kB');
    expect(result.stdout).toContain('[OK] /[locale]/tip/[address]: 446 kB / 予算 446 kB');
    expect(result.stdout).toContain('OK: 全ルートが予算内');
  });

  it('accepts a route with zero-byte First Load JS', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(MANIFEST_ROW, '├ ○ /manifest.webmanifest   0 B   0 B'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[OK] /manifest.webmanifest: 0 kB / 予算 250 kB');
  });

  it('fails an MB-sized route with its converted size, not a missing measurement', () => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, '├ ƒ /[locale]/pay   12 kB   1.02 MB'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[OVER] /[locale]/pay: 1020 kB / 予算 448 kB');
    expect(result.stderr).toContain('FAIL:');
    expect(result.stdout).not.toContain('OK: 全ルートが予算内');
  });

  it.each([
    ['0 B', '0', 0],
    ['999 B', '0.999', 0],
    ['249 kB', '249', 0],
    ['1.02 MB', '1020', 1],
    ['2.01 MB', '2010', 1],
  ])('checks shared chunks printed as %s', (size, expectedKb, status) => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(SHARED_ROW, `+ First Load JS shared by all   ${size}`));

    expect(result.status).toBe(status);
    expect(result.stdout).toContain(`[${status === 0 ? 'OK' : 'OVER'}] __shared__: ${expectedKb} kB / 予算 250 kB`);
  });

  it.each(['GB', 'TB', 'PB', 'EB', 'ZB', 'YB'])('recognizes Next.js %s output as over budget', (unit) => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(PAY_ROW, `├ ƒ /[locale]/pay   12 kB   1.02 ${unit}`));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[OVER] /[locale]/pay:');
    expect(result.stdout).not.toContain('[MISSING]');
  });

  it.each([
    [PAY_ROW, '/[locale]/pay', '448001 B', '448.001', 448],
    [PAY_ROW, '/[locale]/pay', '449 kB', '449', 448],
    [TIP_ROW, '/[locale]/tip/[address]', '446001 B', '446.001', 446],
    [TIP_ROW, '/[locale]/tip/[address]', '447 kB', '447', 446],
  ])('enforces the existing budget for %s with %s at %s', (row, route, size, expectedKb, budget) => {
    const result = runGate(NORMAL_BUILD_OUTPUT.replace(row, `├ ƒ ${route}   12 kB   ${size}`));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`[OVER] ${route}: ${expectedKb} kB / 予算 ${budget} kB`);
  });

  it.each([
    '/_not-found',
    '/[locale]',
    '/[locale]/[handle]',
    '/[locale]/agent',
    '/[locale]/checkout',
    '/[locale]/create',
    '/[locale]/pay',
    '/[locale]/tip/[address]',
    '/manifest.webmanifest',
    '__shared__',
  ])('fails when the budgeted entry %s is absent', (route) => {
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
    expect(result.stdout.match(/\[OK\]/g)).toHaveLength(10);
  });

  it.each(['', 'Failed to compile.\n'])('preserves exit 2 for output with no route table (%j)', (input) => {
    const result = runGate(input);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ERROR: build 出力から Route 表をパースできませんでした');
  });
});
