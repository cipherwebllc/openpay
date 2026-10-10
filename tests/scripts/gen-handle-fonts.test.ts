// @vitest-environment node
// scripts/gen-handle-fonts.mjs は npm から取った展開物 (信用しない入力) を読んでリポに書く。
// 展開物の package.json の version はディレクトリ名に入るので、`5.3.0/../../x` のような値や
// 偽の woff2 で public/fonts/handle/ の外へ書いたり、既存のフォントを消したりしないこと。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertInside, generateHandleFonts } from '@/scripts/gen-handle-fonts.mjs';

const OFL = 'Copyright\n\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n';
const WOFF2 = Buffer.from('wOF2fake-font-bytes');

let tmp: string;
let repo: string;
let serifPkg: string;
let maruPkg: string;
let sentinel: string;

function faceCss(file: string, weight: string, range = 'U+0000-00FF,U+0131') {
  return `/* x */\n@font-face {\n  font-family: 'X';\n  font-style: normal;\n  font-display: swap;\n  font-weight: ${weight};\n  src: url(./files/${file}) format('woff2');\n  unicode-range: ${range};\n}\n`;
}

function writePkg(dir: string, pkg: Record<string, unknown>, css: Record<string, string>, files: string[]) {
  mkdirSync(join(dir, 'files'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'LICENSE'), OFL);
  for (const [name, body] of Object.entries(css)) writeFileSync(join(dir, name), body);
  for (const f of files) writeFileSync(join(dir, 'files', f), WOFF2);
}

function setup({ serifVersion = '5.3.0' as unknown, maruVersion = '5.3.0' as unknown } = {}) {
  writePkg(serifPkg, { name: '@fontsource-variable/noto-serif-jp', version: serifVersion, license: 'OFL-1.1' },
    { 'wght.css': faceCss('noto-serif-jp-0-wght-normal.woff2', '200 900') }, ['noto-serif-jp-0-wght-normal.woff2']);
  writePkg(maruPkg, { name: '@fontsource/zen-maru-gothic', version: maruVersion, license: 'OFL-1.1' }, {
    '400.css': faceCss('zen-maru-gothic-0-400-normal.woff2', '400'),
    '700.css': faceCss('zen-maru-gothic-0-700-normal.woff2', '700'),
  }, ['zen-maru-gothic-0-400-normal.woff2', 'zen-maru-gothic-0-700-normal.woff2']);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gen-handle-fonts-'));
  repo = join(tmp, 'repo');
  serifPkg = join(tmp, 'serif', 'package');
  maruPkg = join(tmp, 'maru', 'package');
  mkdirSync(join(repo, 'components'), { recursive: true });
  // 既存のフォント (中断時に消えていないことの目印)
  sentinel = join(repo, 'public/fonts/handle/existing.txt');
  mkdirSync(join(repo, 'public/fonts/handle'), { recursive: true });
  writeFileSync(sentinel, 'keep');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function expectUntouched() {
  expect(existsSync(sentinel)).toBe(true);
  expect(existsSync(join(repo, 'components/handleFonts.css'))).toBe(false);
  // repo の外 (一時ディレクトリ直下) には展開物とリポ以外が増えていない
  expect(readdirSync(tmp).sort()).toEqual(['maru', 'repo', 'serif']);
  expect(readdirSync(join(repo, 'public/fonts/handle'))).toEqual(['existing.txt']);
}

describe('generateHandleFonts', () => {
  it('rebuilds public/fonts/handle/ and the CSS from well-formed packages', () => {
    setup();
    const r = generateHandleFonts({ serifPkg, maruPkg, repo });
    expect(r).toMatchObject({ woff2: 3, faces: 4 });
    expect(existsSync(sentinel)).toBe(false);
    expect(readdirSync(join(repo, 'public/fonts/handle')).sort()).toEqual([
      'OFL-NotoSerifJP.txt', 'OFL-ZenMaruGothic.txt', 'noto-serif-jp-5.3.0', 'zen-maru-gothic-5.3.0',
    ]);
    const css = readFileSync(join(repo, 'components/handleFonts.css'), 'utf8');
    expect(css).toContain("src: url('/fonts/handle/noto-serif-jp-5.3.0/noto-serif-jp-0-wght-normal.woff2') format('woff2');");
    expect(css).toContain("src: url('/fonts/handle/zen-maru-gothic-5.3.0/zen-maru-gothic-0-700-normal.woff2') format('woff2');");
  });

  it.each([
    '5.3.0/../../../x',
    '../../../../escape',
    '5.3.0/..',
    '5.3.0-beta.1',
    '5.3',
    '',
    5,
    null,
  ])('refuses a non-SemVer version (%s) before deleting or writing anything', (version) => {
    setup({ serifVersion: version });
    expect(() => generateHandleFonts({ serifPkg, maruPkg, repo })).toThrow(/SemVer/);
    expectUntouched();
    setup({ maruVersion: version });
    expect(() => generateHandleFonts({ serifPkg, maruPkg, repo })).toThrow(/SemVer/);
    expectUntouched();
  });

  it('refuses a fake woff2 before deleting the existing fonts', () => {
    setup();
    writeFileSync(join(maruPkg, 'files', 'zen-maru-gothic-0-700-normal.woff2'), 'not a font');
    expect(() => generateHandleFonts({ serifPkg, maruPkg, repo })).toThrow(/not woff2/);
    expectUntouched();
  });

  it('refuses a LICENSE that is not the OFL 1.1 text', () => {
    setup();
    writeFileSync(join(serifPkg, 'LICENSE'), 'MIT License');
    expect(() => generateHandleFonts({ serifPkg, maruPkg, repo })).toThrow(/OFL 1\.1/);
    expectUntouched();
  });
});

describe('assertInside', () => {
  const root = join(tmpdir(), 'x', 'public', 'fonts', 'handle');
  it('accepts paths under the root', () => {
    expect(assertInside(root, join(root, 'a-5.3.0', 'f.woff2'))).toBe(join(root, 'a-5.3.0', 'f.woff2'));
  });
  it.each([
    ['the root itself', root],
    ['a parent', join(root, '..')],
    ['a traversal', join(root, 'a-5.3.0/../../../x')],
    ['a sibling sharing the prefix', `${root}-evil/f.woff2`],
    ['an unrelated absolute path', join(tmpdir(), 'elsewhere')],
  ])('rejects %s', (_label, target) => {
    expect(() => assertInside(root, target)).toThrow(/outside/);
  });
});
