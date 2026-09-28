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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROUTE_CLIENT_KEY_PREFIXES,
  ROUTE_CLIENT_NAMESPACES,
  SHARED_CLIENT_NAMESPACES,
} from '@/i18n/clientNamespaces';
import { pickNamespaces } from '@/i18n/clientMessages';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import {
  LOCALE_LAYOUT,
  REPO_ROOT,
  collectKeysForNamespace,
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

// ROUTE_CLIENT_KEY_PREFIXES: namespace の一部のキーだけを渡すルート。キーの渡し漏れも実行時の
// MISSING_MESSAGE になるので、そのルートの client 依存グラフで引いているキーを静的に集めて照合する。
describe('一部のキーだけ渡す namespace (ROUTE_CLIENT_KEY_PREFIXES)', () => {
  const entries = Object.entries(ROUTE_CLIENT_KEY_PREFIXES).flatMap(([route, byNamespace]) =>
    Object.entries(byNamespace ?? {}).map(([namespace, prefixes]) => ({ route, namespace, prefixes })),
  );

  it('少なくとも 1 つ宣言がある (トップの Landing)', () => {
    expect(entries).toContainEqual({ route: '', namespace: 'Landing', prefixes: ['cashSim'] });
  });

  it.each(entries.map((entry) => ({ ...entry, label: entry.route || '(トップ)' })))('$label の $namespace: client が引くキーはすべて接頭辞に収まり、動的なキーがない', ({ route, namespace, prefixes }) => {
    const page = pages.find((p) => p.route === route);
    expect(page).toBeDefined();
    expect(declared[route]).toContain(namespace);
    const { files, keys, dynamic } = collectKeysForNamespace(page!.file, namespace);
    expect(files.length).toBeGreaterThan(0);
    expect(dynamic).toEqual([]);
    expect(keys.filter((key: string) => !prefixes.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    // 接頭辞はどれも実在のキーに当たる (古い接頭辞を残さない)。
    const namespaceKeys = Object.keys((jaMessages as Record<string, Record<string, unknown>>)[namespace]);
    for (const prefix of prefixes) expect(namespaceKeys.some((key) => key.startsWith(prefix)), prefix).toBe(true);
    // 絞ったあとの messages に、client が引くキーがすべて残る (ja/en)。
    for (const messages of [jaMessages, enMessages] as Record<string, unknown>[]) {
      const picked = pickNamespaces(messages, [namespace], { [namespace]: prefixes })[namespace] as Record<string, unknown>;
      for (const key of keys) expect(picked, key).toHaveProperty(key);
    }
  });

  it('pickNamespaces: 接頭辞の指定がある namespace だけを絞り、ほかはそのまま渡す', () => {
    const messages = { A: { cashSimX: 'x', faqQ1: 'q' }, B: { k: 'v' } };
    expect(pickNamespaces(messages, ['A', 'B'], { A: ['cashSim'] })).toEqual({ A: { cashSimX: 'x' }, B: { k: 'v' } });
    expect(pickNamespaces(messages, ['A'])).toEqual({ A: { cashSimX: 'x', faqQ1: 'q' } });
  });

  // 解析器が「読めない書き方」を見逃さない (見逃すと接頭辞で絞った messages にないキーを実行時に引いてしまう)。
  describe('collectKeysForNamespace は読み取れない使い方を dynamic として返す', () => {
    const cases: [string, string][] = [
      ['props で translator を渡す', "const t = useTranslations('Landing');\nexport const A = () => <B label={t} />;"],
      ['別名に入れる', "const t = useTranslations('Landing');\nconst tt = t;\ntt('faqA1');"],
      ['optional call', "const t = useTranslations('Landing');\nt?.('heroTitle');"],
      ['hook から返す', "export function useL() { return useTranslations('Landing'); }"],
      ['下位の namespace', "const t = useTranslations('Landing.sub');\nt('x');"],
      ['generic 付き', "const t = useTranslations<'Landing'>('Landing');\nt('x');"],
      ['キーの連結', "const t = useTranslations('Landing');\nt('cashSimChip' + id);"],
      ['template literal', "const t = useTranslations('Landing');\nt(`cashSim${id}`);"],
    ];
    let dir = '';
    beforeAll(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'ns-keys-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it.each(cases.map(([label, body], index) => ({ label, body, index })))('$label', ({ label, body, index }) => {
      const file = path.join(dir, `case-${index}.tsx`);
      writeFileSync(file, body);
      const { dynamic } = collectKeysForNamespace(file, 'Landing');
      expect(dynamic.length, label).toBeGreaterThan(0);
    });
    it('読める書き方 (複数行・rich・has) はキーとして集める', () => {
      const file = path.join(dir, 'ok.tsx');
      writeFileSync(file, "const t = useTranslations('Landing');\nt(\n  'cashSimTitle',\n);\nt.rich('cashSimNote', { b: (c) => c });\nt.has('cashSimX');");
      expect(collectKeysForNamespace(file, 'Landing')).toMatchObject({ keys: ['cashSimNote', 'cashSimTitle', 'cashSimX'], dynamic: [] });
    });
  });
});
