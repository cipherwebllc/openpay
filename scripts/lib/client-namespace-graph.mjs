// 各ページの **client component 依存グラフ** を静的に辿り、そこで参照される
// next-intl namespace (`useTranslations('X')`) を集める解析器。
//
// 用途は 2 つ:
//   1. `i18n/clientNamespaces.ts` の宣言リストを作るときの下敷き (人手で更新)
//   2. `tests/lib/i18nClientNamespaces.test.ts` のフェンス
//      (宣言リストに載っていない namespace を新たに使い始めたら CI で落とす)
//
// フェンスが必要な理由: locale layout が messages 全量 (268 KB) を毎ページの HTML へ
// inline していたのを namespace 単位の pick に絞ったため、宣言漏れは
// 実行時の MISSING_MESSAGE に直結する。静的解析で検出できるようにしておく。
//
// 解析方針 (意図的に「広めに拾う」):
//   - import 先が repo 内 (.ts/.tsx) なら server/client を区別せず再帰的に辿る。
//     `useTranslations` は client でしか動かないので、拾いすぎる方向の誤差しか出ない。
//   - `import type` 行は辿らない (型だけの依存で namespace は増えない)。
//   - `next/dynamic` の `import('...')` も `from '...'` と同じく辿る。
//   - namespace が変数の 2 コンポーネント (EntitlementPaywall / OnrampCta) は
//     呼び出し側が値を決めるので EXTRA_NAMESPACES で明示する。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const EXTS = ['.tsx', '.ts'];

// namespace を prop/config 経由で受け取るコンポーネントの実際の値。
// (EntitlementPaywall は wrapper が config.namespace を決める。OnrampCta の
//  namespace は呼び出し元 3 form の namespace と同じなので追加不要。)
const EXTRA_NAMESPACES = {
  'components/CsvPassPaywall.tsx': ['CsvPass'],
  'components/ProPaywall.tsx': ['Pro'],
};

function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = path.join(REPO_ROOT, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../'))
    base = path.resolve(path.dirname(fromFile), spec);
  else return null; // bare specifier = node_modules

  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  for (const ext of EXTS) {
    const idx = path.join(base, `index${ext}`);
    if (existsSync(idx)) return idx;
  }
  return null;
}

// コメント内の例示 (`useTranslations('X')` 等) を拾わないよう除去する。
//   - 行コメントを先に落とす。ブロックコメントを先に落とすと、行コメント中の
//     `messages/*.json` のような glob が開始トークンに化けて後続の import 行まで
//     食い潰す (実害あり)。
//   - 行コメント判定は直前が ':' でないものに限る (`https://...` を壊さない)。
function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function importSpecifiers(source) {
  const specs = [];
  // `import type { X } from '...'` は型のみ → 辿らない。
  const withoutTypeImports = source.replace(
    /^\s*import\s+type\s[^;]*?;/gm,
    '',
  );
  for (const m of withoutTypeImports.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g))
    specs.push(m[1]);
  for (const m of withoutTypeImports.matchAll(
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ))
    specs.push(m[1]);
  return specs;
}

function namespacesIn(source) {
  const found = [];
  for (const m of source.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]/g))
    found.push(m[1].split('.')[0]);
  return found;
}

/**
 * entry ファイルから到達可能な repo 内モジュールを辿り、参照される namespace の
 * ソート済み配列を返す。
 * @param {string} entryFile 絶対パス
 * @param {{skipChildren?: boolean}} [options]
 */
export function collectNamespaces(entryFile) {
  const seen = new Set();
  const namespaces = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;

    const source = stripComments(readFileSync(file, 'utf8'));
    for (const ns of namespacesIn(source)) namespaces.add(ns);

    const rel = path.relative(REPO_ROOT, file);
    for (const ns of EXTRA_NAMESPACES[rel] ?? []) namespaces.add(ns);

    for (const spec of importSpecifiers(source)) {
      const resolved = resolveImport(spec, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return [...namespaces].sort();
}

/** app/[locale] 配下の page.tsx を列挙し、route key (layout からの相対ディレクトリ) を返す。 */
export function listLocalePages() {
  const localeRoot = path.join(REPO_ROOT, 'app', '[locale]');
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'page.tsx') {
        const route = path
          .relative(localeRoot, path.dirname(full))
          .split(path.sep)
          .join('/');
        pages.push({ route, file: full });
      }
    }
  };
  walk(localeRoot);
  return pages;
}

export const LOCALE_LAYOUT = path.join(
  REPO_ROOT,
  'app',
  '[locale]',
  'layout.tsx',
);
