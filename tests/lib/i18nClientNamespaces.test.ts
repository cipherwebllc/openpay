// i18n/clientNamespaces.ts のフェンス。
//
// locale layout は messages 全量ではなく namespace 単位の pick を
// <NextIntlClientProvider> に渡す (ページ HTML から ~130 KB の JSON を落とすため)。
// その代償として「宣言漏れ = 実行時 MISSING_MESSAGE」になるので、各ページの
// client 依存グラフを静的に辿った結果と宣言リストが一致することを CI で検証する。
//
// 落ちたときの直し方:
//   - 新しい useTranslations('X') を足した → 該当ルートの配列に 'X' を足す
//   - ページを新設した → i18n/clientNamespaces.ts に route を足し、
//     app/[locale]/<route>/layout.tsx に <RouteMessages route="..."> を置く
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROUTE_CLIENT_NAMESPACES,
  SHARED_CLIENT_NAMESPACES,
} from '@/i18n/clientNamespaces';
import jaMessages from '@/messages/ja.json';
import {
  LOCALE_LAYOUT,
  REPO_ROOT,
  collectNamespaces,
  listLocalePages,
} from '@/scripts/lib/client-namespace-graph.mjs';

const declared = ROUTE_CLIENT_NAMESPACES as Record<string, readonly string[]>;
const shared = SHARED_CLIENT_NAMESPACES as readonly string[];
const pages = listLocalePages();

describe('i18n client namespaces フェンス', () => {
  it('SHARED は locale layout の依存グラフと一致する', () => {
    expect([...shared].sort()).toEqual(collectNamespaces(LOCALE_LAYOUT));
  });

  it('宣言されたルートと app/[locale] の page.tsx が 1:1 で対応する', () => {
    expect(Object.keys(declared).sort()).toEqual(
      pages.map((page) => page.route).sort(),
    );
  });

  it.each(pages)('$route の宣言が依存グラフと一致する', ({ route, file }) => {
    const used = collectNamespaces(file).filter((ns) => !shared.includes(ns));
    expect({ route, namespaces: [...declared[route]].sort() }).toEqual({
      route,
      namespaces: used,
    });
  });

  it('宣言された namespace はすべて messages/ja.json に存在する', () => {
    const known = new Set(Object.keys(jaMessages));
    const unknown = [...shared, ...Object.values(declared).flat()].filter(
      (ns) => !known.has(ns),
    );
    expect(unknown).toEqual([]);
  });

  it('root 以外の全ルートに RouteMessages を張る layout.tsx がある', () => {
    const missing: string[] = [];
    for (const { route } of pages) {
      // route '' (トップ LP) は locale layout と同じディレクトリなので page.tsx 側で包む。
      const target =
        route === ''
          ? path.join(REPO_ROOT, 'app', '[locale]', 'page.tsx')
          : path.join(REPO_ROOT, 'app', '[locale]', route, 'layout.tsx');
      if (
        !existsSync(target) ||
        !readFileSync(target, 'utf8').includes(`<RouteMessages route="${route}"`)
      ) {
        missing.push(route === '' ? '(root)' : route);
      }
    }
    expect(missing).toEqual([]);
  });

  // 入れ子 layout で setRequestLocale を忘れると getMessages() が headers() 経由になり、
  // そのルートが静的プリレンダリングから外れる (実測: prerender 対象 65 → 3 ページ)。
  // next build のルート表は ● のままで気づけないので、ここで固定する。
  it('各ルート layout は setRequestLocale を呼ぶ (静的プリレンダリング維持)', () => {
    const missing = pages
      .filter(({ route }) => route !== '')
      .filter(
        ({ route }) =>
          !readFileSync(
            path.join(REPO_ROOT, 'app', '[locale]', route, 'layout.tsx'),
            'utf8',
          ).includes('setRequestLocale(locale)'),
      )
      .map(({ route }) => route);
    expect(missing).toEqual([]);
  });
});
