import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// app/**/page.tsx + app/**/layout.tsx + app/**/route.ts の「規定外 value export」ガード (CLAUDE.md 掟 3)。
// Next.js の Page / Layout / Route ファイルは default / generateMetadata 等の規定 export 以外の
// value export を許さず、違反は typecheck/vitest を通過して `next build` でのみ
// "not a valid Page export field" で落ちる (#109 で Vercel deploy が失敗した罠)。
// ここで vitest 段に前倒しして検出する。`export type` は型なので許容。
// layout も page と同じ規定 export 集合 (default / metadata / generateMetadata / viewport /
// generateViewport / generateStaticParams + segment config) を取るため allowlist を共有する。
// route.ts は HTTP メソッド + segment config だけ (default / metadata は無い) なので別 allowlist
// (第 7 回レビュー E10: 以前は page/layout だけで route handler は網の外だった)。
// どちらの集合も next/dist/build/webpack/plugins/next-types-plugin が生成する checkFields の型
// (HTTP_METHODS / config / generateStaticParams / segment config / metadata 系) から写している。

const ALLOWED_PAGE_EXPORTS = new Set([
  'default',
  'metadata',
  'generateMetadata',
  'viewport',
  'generateViewport',
  'generateStaticParams',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'experimental_ppr',
]);

// route handler の規定 export: HTTP メソッド + segment config (+ 旧 config)。default は無い。
const ALLOWED_ROUTE_EXPORTS = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'config',
  'generateStaticParams',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
]);

const PAGE_FILE_NAMES = new Set([
  'page.tsx',
  'page.ts',
  'layout.tsx',
  'layout.ts',
]);
const ROUTE_HANDLER_FILE_NAMES = new Set(['route.ts', 'route.tsx']);

function collectFiles(dir: string, names: ReadonlySet<string>, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      collectFiles(p, names, out);
    } else if (names.has(name)) {
      out.push(p);
    }
  }
  return out;
}

// export される value 名を TypeScript の AST から列挙する (型 export は除外)。
// 正規表現では `export const GET = …, extra = 1` の 2 つ目や `export enum` を見逃した (第 7 回レビュー Codex 指摘)。
//   export default … / export default function|class   → 'default'
//   export (async) function NAME / class / enum / namespace → NAME
//   export const/let/var A = …, B = … / const { a, b } = … → A, B / a, b
//   export { A, B as C } (from も可)                      → A, C (type-only は除外)
//   export * from / export * as ns from                  → stars (再 export 名が静的に読めないので行ごと拒否)
//   export interface / export type / export type {…}     → 型なので無視
//   上記以外の export 文                                   → `(SyntaxKind)` として規定外に数える (黙って通さない)
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
  return modifiers.some((m) => m.kind === kind);
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out);
  }
}

// `declare namespace` / 中身が型宣言だけ (interface / type / declare / 入れ子の型だけの namespace) の namespace は
// 値を生まない (TS が JS を出さない) ので規定外 value export に数えない。
function isTypeOnlyNamespace(node: ts.ModuleDeclaration): boolean {
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return true;
  const body = node.body;
  if (!body) return true;
  if (ts.isModuleDeclaration(body)) return isTypeOnlyNamespace(body); // namespace A.B {…}
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.every(
    (s) =>
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      hasModifier(s, ts.SyntaxKind.DeclareKeyword) ||
      (ts.isModuleDeclaration(s) && isTypeOnlyNamespace(s)) ||
      (ts.isExportDeclaration(s) && s.isTypeOnly),
  );
}

function extractExports(source: string, fileName: string): { values: string[]; stars: string[] } {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const values: string[] = [];
  const stars: string[] = [];
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) {
      values.push('default'); // export default <expr> / export = x
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      if (!st.exportClause || ts.isNamespaceExport(st.exportClause)) {
        stars.push(st.getText(sf).trim());
        continue;
      }
      for (const element of st.exportClause.elements) {
        if (!element.isTypeOnly) values.push(element.name.text);
      }
      continue;
    }
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue;
    if (ts.isModuleDeclaration(st) && isTypeOnlyNamespace(st)) continue;
    if (ts.isVariableStatement(st)) {
      for (const declaration of st.declarationList.declarations) bindingNames(declaration.name, values);
      continue;
    }
    if (
      ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isEnumDeclaration(st) ||
      ts.isModuleDeclaration(st)
    ) {
      if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) values.push('default');
      else if (st.name) values.push(ts.isIdentifier(st.name) ? st.name.text : st.name.getText(sf));
      else values.push('default');
      continue;
    }
    values.push(`(${ts.SyntaxKind[st.kind]})`);
  }
  return { values, stars };
}

function assertOnlyAllowedExports(rel: string, allowed: ReadonlySet<string>, moveTo: string) {
  const source = readFileSync(join(process.cwd(), rel), 'utf8');
  const { values, stars } = extractExports(source, rel);
  const offenders = values.filter((n) => !allowed.has(n));
  expect(
    offenders,
    `${rel} が規定外の value export を持つ (next build が落ちる)。${moveTo} へ移動すること: ${offenders.join(', ')}`,
  ).toEqual([]);

  expect(
    stars,
    `${rel} が export * を持つ (再 export される名前が静的に読めず、規定外 export を検出できない)。名前を明示するか ${moveTo} へ移動すること: ${stars.join(', ')}`,
  ).toEqual([]);
}

const toRel = (p: string) => [p.replace(process.cwd() + '/', '')] as const;

describe('export 抽出器 (regex で見逃した形を AST で拾う)', () => {
  const extract = (src: string) => extractExports(src, 'probe/route.ts');

  it('複数宣言・分割代入・enum・abstract class・namespace・default function/class を value export として列挙する', () => {
    expect(extract('export const GET = handler(a, b), extra = 1;').values).toEqual(['GET', 'extra']);
    expect(extract('export let a = 1, b = 2;\nexport var c = 3;').values).toEqual(['a', 'b', 'c']);
    expect(extract('export const { x, y: z } = obj;\nexport const [first] = arr;').values).toEqual(['x', 'z', 'first']);
    expect(extract('export enum Internal { A }').values).toEqual(['Internal']);
    expect(extract('export const enum Flags { A }').values).toEqual(['Flags']);
    expect(extract('export abstract class Base {}\nexport class Impl extends Base {}').values).toEqual(['Base', 'Impl']);
    expect(extract('export namespace NS { export const v = 1; }').values).toEqual(['NS']);
    expect(extract('export default function Page() { return null; }').values).toEqual(['default']);
    expect(extract('export default async function () {}').values).toEqual(['default']);
    expect(extract('export default class {}').values).toEqual(['default']);
    expect(extract('const x = 1;\nexport default x;').values).toEqual(['default']);
    expect(extract('export async function GET() {}\nexport function POST() {}').values).toEqual(['GET', 'POST']);
  });

  it('名前付き re-export は type-only を除いて列挙し、export * は stars として拒否する', () => {
    expect(extract("export { a as b, type T, c } from './x';").values).toEqual(['b', 'c']);
    expect(extract('const a = 1;\nexport { a };').values).toEqual(['a']);
    expect(extract("export type { X } from './x';").values).toEqual([]);
    expect(extract("export * from './x';").stars).toEqual(["export * from './x';"]);
    expect(extract("export * as ns from './x';").stars).toEqual(["export * as ns from './x';"]);
    expect(extract("export type * from './x';").stars).toEqual([]);
  });

  it('型だけの export (interface / type alias / declare module) は数えない', () => {
    const { values, stars } = extract(
      "export interface Props { a: string }\nexport type Id = string;\ndeclare module 'x' { export const q: number; }\nexport const dynamic = 'force-dynamic';",
    );
    expect(values).toEqual(['dynamic']);
    expect(stars).toEqual([]);
  });

  it('中身が型だけの namespace は値を生まないので数えず、値を含む namespace は数える', () => {
    expect(extract('export namespace Types { export interface Props {} export type Id = string; }').values).toEqual([]);
    expect(extract('export namespace Outer { export namespace Inner { export interface I {} } }').values).toEqual([]);
    expect(extract('export namespace A.B { export type T = 1; }').values).toEqual([]);
    expect(extract('export declare namespace D { const v: number; }').values).toEqual([]);
    expect(extract('export namespace Empty {}').values).toEqual([]);
    expect(extract('export namespace Mixed { export interface I {} export const v = 1; }').values).toEqual(['Mixed']);
    expect(extract('export namespace Outer { export namespace Inner { export function f() {} } }').values).toEqual(['Outer']);
  });
});

describe('app/**/{page,layout}.tsx の export ガード (next build でしか落ちない罠の前倒し)', () => {
  const pages = collectFiles(join(process.cwd(), 'app'), PAGE_FILE_NAMES);

  it('page / layout ファイルを検出できている (自己検証)', () => {
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.some((p) => /\/layout\.tsx?$/.test(p))).toBe(true);
  });

  it.each(pages.map(toRel))('%s は規定 export のみ', (rel) => {
    assertOnlyAllowedExports(rel, ALLOWED_PAGE_EXPORTS, 'components/');
  });
});

describe('app/**/route.ts の export ガード (route handler も同じ罠)', () => {
  const routes = collectFiles(join(process.cwd(), 'app'), ROUTE_HANDLER_FILE_NAMES);

  it('route ファイルを検出できている (自己検証)', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it.each(routes.map(toRel))('%s は HTTP メソッドと segment config のみ', (rel) => {
    assertOnlyAllowedExports(rel, ALLOWED_ROUTE_EXPORTS, 'lib/');
  });
});
