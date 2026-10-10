// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from '../../next.config.mjs';
import { scanClientSource } from '../../scripts/lib/clientSyntax.mjs';

const SCRIPT = resolve('scripts/check-client-syntax.mjs');

// 2026-10 本番 Sentry `SyntaxError: Unexpected token '{'` (6091-59c17c5ca343f071.js:3:1739) の chunk に相当する fixture。
// intl-messageformat のクラス (static ブロック 4 つ) を webpack の chunk の形に入れ、最初の static ブロックの `{` を
// 本番と同じ 3 行目 1739 桁目に置く (ブラウザは `{` の位置を報告する)。前置きには走査が飛ばすべき文字列・正規表現・
// template の中の `{static{` を入れる。
const INTL_CLASS = 'var em=class e{constructor(t,r=e.defaultLocale,i,n){this.formatterCache={number:{},dateTime:{},pluralRules:{}},'
  + 'this.formatters=function(e){return{getNumberFormat:(0,ei.B)((...e)=>new Intl.NumberFormat(...e),{cache:ec(e.number),'
  + 'strategy:_.variadic})}}(this.formatterCache)}static{this.memoizedDefaultLocale=null}static get defaultLocale(){return '
  + 'e.memoizedDefaultLocale||(e.memoizedDefaultLocale=new Intl.NumberFormat().resolvedOptions().locale),e.memoizedDefaultLocale}'
  + 'static{this.resolveLocale=e=>{if(void 0===Intl.Locale)return;let t=Intl.NumberFormat.supportedLocalesOf(e);return new '
  + 'Intl.Locale(t.length>0?t[0]:"string"==typeof e?e:e[0])}}static{this.__parse=en}static{this.formats={number:{integer:'
  + '{maximumFractionDigits:0},currency:{style:"currency"}}}}};';
const INTL_HEAD = '12345:(e,t,r)=>{r.d(t,{A:()=>em});let s="{static{",u=/{static{/g,c=`{static{${s}`;';
const PAD = 1739 - 1 - INTL_HEAD.length - 'var p="";'.length - (INTL_CLASS.indexOf('}static{') + '}static'.length);
const INTL_CHUNK = '"use strict";\n(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[6091],{\n'
  + `${INTL_HEAD}var p="${'x'.repeat(PAD)}";${INTL_CLASS}}\n}]);`;

describe('scanClientSource', () => {
  it.each([
    ['the minified class body start', 'var a=class{static{this.x=1}};'],
    ['after a method', 'class A{m(){}static{this.x=1}}'],
    ['after a field', 'class A{x=1;static{this.y=2}}'],
    ['a formatted class', 'class A {\n  m() {}\n  static {\n    this.x = 1;\n  }\n}'],
    ['after a field ended by a newline (ASI)', 'class A {\n  x = 1\n  static {}\n}'],
    ['the first line of a file', 'static{}'],
    // Codex 1 回目 P2: コメントは空白として扱う (正規表現の版は `\s*` しか見ず偽 green だった)
    ['a comment before static', 'class A{/*note*/static{globalThis.x=1}}'],
    ['a block comment between static and {', 'class A{static/*note*/{globalThis.x=1}}'],
    ['a line comment between static and {', 'class A{static//note\n{globalThis.x=1}}'],
    ['a line comment ended by U+2028', 'class A{static//note\u2028{globalThis.x=1}}'],
    ['a class inside a template substitution', 'var s=`a${class{static{}}}b`;'],
    ['code after a string with escaped quotes', 'var s="a\\"b{";class A{static{}}'],
    ['code after a division (not read as a regex)', 'x=a/b;y="/";class A{static{}}'],
    ['code after a division by a parenthesized value', 'x=(a)/2;y="/";class A{static{}}'],
    ['code after a division of an object literal', 'x={a:1}/2;y="/";class A{static{}}'],
    ['code after a regex that follows a block', 'function f(){}/"/.test(s);class A{static{}}'],
    ['code after a regex that follows if (…)', 'if(a)/"/.test(b);class A{static{}}'],
    ['code after a regex with / in a class', 'x=/[/"]/g;class A{static{}}'],
    ['code after a template with an object literal inside', 'x=`${{a:1}.a}`;class A{static{}}'],
  ])('finds a static block: %s', (_label, source) => {
    expect(scanClientSource(source)).toEqual({ staticBlocks: [expect.any(Object)], error: null });
  });

  it.each([
    // Codex 1 回目 P3: 文字列・正規表現の中は飛ばす (正規表現の版は偽 red だった)
    ['a string', 'globalThis.example="{static{";'],
    ['a regex at the start of a statement', '/{static{/.test(s);'],
    ['a regex after =', 'x=/{static{/g;'],
    ['a single-quoted string with an escape', "x='it\\'s {static{';"],
    ['template text', 'x=`{static{ ${1} static{`;'],
    ['comments', '/* class A{static{}} */\n// static{\nx=1;'],
    ['a method named static', 'class A{static(){return 1}}'],
    ['a static method', 'class A{static m(){}static get x(){return 1}static async*g(){}}'],
    ['a static field', 'class A{static x=1;static y}'],
    ['a property named static', 'var o={static:{a:1}};'],
    ['a member access', 'a.static\n{}'],
    ['a private name', 'class A{#static(){}}'],
    ['an identifier ending in static', 'var o={isstatic:1};if(isstatic){}'],
    ['the lowered output of SWC (no static block)', 'var e=((i=class e{static get defaultLocale(){return e.m}}).m=null,i);'],
  ])('ignores %s', (_label, source) => {
    expect(scanClientSource(source)).toEqual({ staticBlocks: [], error: null });
  });

  it('finds every block of a class', () => {
    const { staticBlocks, error } = scanClientSource('class A{static{this.a=1}static{this.b=2}m(){}static{this.c=3}}');
    expect(error).toBeNull();
    expect(staticBlocks).toHaveLength(3);
  });

  it('finds the 4 blocks of the intl-messageformat chunk at the production position (Sentry 3:1739)', () => {
    expect(PAD).toBeGreaterThan(0);
    const { staticBlocks, error } = scanClientSource(INTL_CHUNK);
    expect(error).toBeNull();
    expect(staticBlocks).toHaveLength(4);
    expect(staticBlocks[0]).toMatchObject({ line: 3, column: 1739 });
    expect(staticBlocks[0].sample).toContain('}static{this.memoizedDefaultLocale=null}');
  });

  // 走査が同期を失った形は error にする (読み違えた範囲に static ブロックが隠れて偽 green になるのを防ぐ)。
  it.each([
    ['an unterminated string', 'x="abc;class A{static{}}', '閉じていない文字列'],
    ['an unterminated comment', 'x=1;/* class A{static{}}', '閉じていないコメント'],
    ['an unterminated template', 'x=`a${b', '閉じていない template'],
    ['an unterminated regex', 'x=/abc\n', '閉じていない正規表現'],
    ['an unclosed brace', 'class A{m(){}', '閉じていない {'],
    ['a closer without an opener', 'a);class A{static{}}', '対応しない )'],
  ])('reports %s', (_label, source, message) => {
    expect(scanClientSource(source).error?.message).toContain(message);
  });
});

describe('check-client-syntax CLI', () => {
  let root: string;

  function chunk(path: string, text: string) {
    const file = join(root, '.next/static', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  function run() {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    return result;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-client-syntax-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes client chunks without static blocks (strings and regexes may contain the text)', () => {
    chunk('chunks/1-a.js', 'class A{static m(){}}globalThis.example="{static{";');
    chunk('chunks/app/[locale]/page-b.js', 'var o={static:1},r=/{static{/;');
    chunk('build-id/_buildManifest.js', 'self.__BUILD_MANIFEST={}');
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-client-syntax: OK (3 files');
  });

  it('fails with the file, the position and the sample when a nested chunk has static blocks', () => {
    chunk('chunks/1-a.js', 'class A{static m(){}}');
    chunk('chunks/app/[locale]/layout-c.js', INTL_CHUNK);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[NG] static ブロック: ${join('.next/static/chunks/app/[locale]/layout-c.js')}:3:1739`);
    expect(result.stderr).toContain('static{this.memoizedDefaultLocale=null}');
    expect(result.stderr).toContain('static ブロックが 4 件');
    expect(result.stderr).toContain('transpilePackages');
  });

  it('fails when the scan loses sync with a file (a block could hide behind it)', () => {
    chunk('chunks/1-a.js', 'class A{static m(){}}');
    chunk('chunks/2-b.js', 'x="abc;class A{static{}}');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`字句走査が同期を失った (閉じていない文字列): ${join('.next/static/chunks/2-b.js')}:1:3`);
  });

  it('fails closed without a build (no .next/static, or no .js in it)', () => {
    expect(run().status).toBe(2);
    chunk('css/a.css', '.static{}');
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('.js がありません');
  });
});

// 再発防止の検査を CI の build step から外さない (ci.yml の run と PIPEFAIL_BUILD_RUN の完全一致は workflow-run.test.ts)。
it('the CI build step runs check-client-syntax after the build', () => {
  const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const build = ci.indexOf('npm run build 2>&1 | tee build.log');
  expect(build).toBeGreaterThan(-1);
  expect(ci.indexOf('node scripts/check-client-syntax.mjs')).toBeGreaterThan(build);
});

// static ブロックを出荷している依存は SWC に下げさせる (外すと本番 Sentry の SyntaxError に戻る)。
it('next.config.mjs transpiles intl-messageformat', () => {
  expect(config.transpilePackages).toContain('intl-messageformat');
});
