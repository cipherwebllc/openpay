// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from '../../next.config.mjs';
import { findStaticBlocks } from '../../scripts/lib/clientSyntax.mjs';

const SCRIPT = resolve('scripts/check-client-syntax.mjs');

// 2026-10 本番 Sentry `SyntaxError: Unexpected token '{'` (6091-59c17c5ca343f071.js:3:1739) の chunk の 3 行目の
// 1700 文字目付近 (intl-messageformat のクラスの static ブロック)。ブラウザは `{` の位置を報告する。
const PROD_SAMPLE = 'variadic})}}(this.formatterCache)}static{this.memoizedDefaultLocale=null}static get defaultLocale(){return 1}';

describe('findStaticBlocks', () => {
  it.each([
    ['the minified class body start', 'var a=class{static{this.x=1}};'],
    ['after a method', 'class A{m(){}static{this.x=1}}'],
    ['after a field', 'class A{x=1;static{this.y=2}}'],
    ['a formatted class', 'class A {\n  m() {}\n  static {\n    this.x = 1;\n  }\n}'],
    ['after a field ended by a newline (ASI)', 'class A {\n  x = 1\n  static {}\n}'],
    ['the first line of a file', 'static{}'],
  ])('finds a static block at %s', (_label, source) => {
    expect(findStaticBlocks(source)).toHaveLength(1);
  });

  it('reports the line and the column of `{` as the browser does (Sentry 3:1739 in production)', () => {
    const line3 = `${'x'.repeat(1739 - 1 - PROD_SAMPLE.indexOf('static{') - 'static'.length)}${PROD_SAMPLE}`;
    const hits = findStaticBlocks(`line1\nline2\n${line3}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 3, column: 1739 });
    expect(hits[0].sample).toContain('}static{this.memoizedDefaultLocale=null}');
  });

  it('finds every block of a class', () => {
    expect(findStaticBlocks('class A{static{this.a=1}static{this.b=2}m(){}static{this.c=3}}')).toHaveLength(3);
  });

  it.each([
    ['a method named static', 'class A{static(){return 1}}'],
    ['a static method', 'class A{static m(){}static get x(){return 1}static async*g(){}}'],
    ['a static field', 'class A{static x=1;static y}'],
    ['a property named static', 'var o={static:{a:1}};'],
    ['a member access', 'a.static{'],
    ['an identifier ending in static', 'var o={isstatic:1};if(isstatic){}'],
    ['the lowered output of SWC (no static block)', 'var e=((i=class e{static get defaultLocale(){return e.m}}).m=null,i);'],
  ])('ignores %s', (_label, source) => {
    expect(findStaticBlocks(source)).toEqual([]);
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

  it('passes client chunks without static blocks', () => {
    chunk('chunks/1-a.js', 'class A{static m(){}}');
    chunk('chunks/app/[locale]/page-b.js', 'var o={static:1};');
    chunk('build-id/_buildManifest.js', 'self.__BUILD_MANIFEST={}');
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-client-syntax: OK (3 files');
  });

  it('fails with the file, the position and the sample when a nested chunk has a static block', () => {
    chunk('chunks/1-a.js', 'class A{static m(){}}');
    chunk('chunks/app/[locale]/layout-c.js', `line1\nline2\n${PROD_SAMPLE}`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[NG] static ブロック: ${join('.next/static/chunks/app/[locale]/layout-c.js')}:3:${PROD_SAMPLE.indexOf('static{') + 'static{'.length}`);
    expect(result.stderr).toContain('static{this.memoizedDefaultLocale=null}');
    expect(result.stderr).toContain('transpilePackages');
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
