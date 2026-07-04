import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// app/**/page.tsx の「規定外 value export」ガード (CLAUDE.md 掟 3)。
// Next.js の Page ファイルは default / generateMetadata 等の規定 export 以外の
// value export を許さず、違反は typecheck/vitest を通過して `next build` でのみ
// "not a valid Page export field" で落ちる (#109 で Vercel deploy が失敗した罠)。
// ここで vitest 段に前倒しして検出する。`export type` は型なので許容。

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

function collectPageFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      collectPageFiles(p, out);
    } else if (name === 'page.tsx' || name === 'page.ts') {
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

describe('app/**/page.tsx の export ガード (next build でしか落ちない罠の前倒し)', () => {
  const pages = collectPageFiles(join(process.cwd(), 'app'));

  it('page ファイルを検出できている (自己検証)', () => {
    expect(pages.length).toBeGreaterThan(5);
  });

  it.each(pages.map((p) => [p.replace(process.cwd() + '/', '')] as const))(
    '%s は規定 export のみ',
    (rel) => {
      const source = readFileSync(join(process.cwd(), rel), 'utf8');
      const offenders = extractValueExports(source).filter(
        (n) => !ALLOWED_PAGE_EXPORTS.has(n),
      );
      expect(
        offenders,
        `${rel} が規定外の value export を持つ (next build が落ちる)。components/ へ移動すること: ${offenders.join(', ')}`,
      ).toEqual([]);
    },
  );
});
