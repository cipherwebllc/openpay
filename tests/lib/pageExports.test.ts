import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

// export される value 名を列挙する (型 export は除外)。
//   export default …                  → 'default'
//   export (async) function NAME      → NAME
//   export const/let/var NAME         → NAME
//   export class NAME                 → NAME
//   export { A, B as C }              → A, C ('export type {…}' は除外)
function extractValueExports(source: string): string[] {
  const names: string[] = [];
  if (/^export\s+default\b/m.test(source)) names.push('default');
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.push(m[1]);
  }
  for (const m of source.matchAll(/^export\s+\{([^}]+)\}/gm)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || part.startsWith('type ')) continue;
      const asMatch = part.match(/\bas\s+([A-Za-z0-9_$]+)\s*$/);
      names.push(asMatch ? asMatch[1] : part.split(/\s+/)[0]);
    }
  }
  return names;
}

// `export * from './x'` / `export * as ns from './x'` は再 export される名前が
// 静的に読めないため、上の extractValueExports では規定外 export を見逃す
// (次に './x' へ value を足した時点で next build だけが落ちる)。行ごと拒否する。
// `export type * from …` は型のみなので対象外。
function extractExportStars(source: string): string[] {
  return [...source.matchAll(/^export\s+\*.*$/gm)].map((m) => m[0].trim());
}

function assertOnlyAllowedExports(rel: string, allowed: ReadonlySet<string>, moveTo: string) {
  const source = readFileSync(join(process.cwd(), rel), 'utf8');
  const offenders = extractValueExports(source).filter((n) => !allowed.has(n));
  expect(
    offenders,
    `${rel} が規定外の value export を持つ (next build が落ちる)。${moveTo} へ移動すること: ${offenders.join(', ')}`,
  ).toEqual([]);

  const stars = extractExportStars(source);
  expect(
    stars,
    `${rel} が export * を持つ (再 export される名前が静的に読めず、規定外 export を検出できない)。名前を明示するか ${moveTo} へ移動すること: ${stars.join(', ')}`,
  ).toEqual([]);
}

const toRel = (p: string) => [p.replace(process.cwd() + '/', '')] as const;

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
