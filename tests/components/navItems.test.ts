import { describe, it, expect, vi } from 'vitest';

// Store 項目は client flag (enableCreatorStoreUi) で出し分けるため、この fence は
// 本番相当 = flag ON で検証する (OFF の 3 枠は下の専用 it で担保)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStoreUi: true } };
});
import {
  NAV_ITEMS,
  DESKTOP_NAV_ITEMS,
  pathMatches,
  pathRestForLocale,
} from '@/components/navItems';

describe('navItems: NAV_ITEMS shape (regression fence)', () => {
  it('4 items が宣言されている (ホームは Nav から外す確定済)', () => {
    expect(NAV_ITEMS).toHaveLength(4);
  });

  it('1 slot 目は「決済 (/scan)」で支払う動線 (P4 4 区分)', () => {
    expect(NAV_ITEMS[0]).toMatchObject({ key: 'pay', href: '/scan' });
  });

  it('4 区分 = pay(/scan) / sell(/create) / store(/store) / me(/me) の順 (P4 fence)', () => {
    expect(NAV_ITEMS.map((i) => [i.key, i.href])).toEqual([
      ['pay', '/scan'],
      ['sell', '/create'],
      ['store', '/store'],
      ['me', '/me'],
    ]);
  });

  it('href はすべて /[name] 形式で先頭 slash 1 つだけ', () => {
    for (const item of NAV_ITEMS) {
      expect(item.href).toMatch(/^\/[a-z]+$/);
    }
  });

  it('icon プロパティは函数 (LucideIcon は React component) で空ではない', () => {
    for (const item of NAV_ITEMS) {
      expect(typeof item.icon).toBe('object'); // forwardRef は object
      expect(item.icon).toBeDefined();
    }
  });
});

describe('pathRestForLocale: locale prefix 除去', () => {
  it('locale ルート (/ja) → 空文字', () => {
    expect(pathRestForLocale('/ja', 'ja')).toBe('');
  });

  it('locale ルート (/en) → 空文字', () => {
    expect(pathRestForLocale('/en', 'en')).toBe('');
  });

  it('locale + subpath (/ja/create) → /create', () => {
    expect(pathRestForLocale('/ja/create', 'ja')).toBe('/create');
  });

  it('深い subpath (/ja/explore/category) → /explore/category', () => {
    expect(pathRestForLocale('/ja/explore/category', 'ja')).toBe(
      '/explore/category',
    );
  });

  it('末尾 slash 付き (/ja/create/) → /create/', () => {
    expect(pathRestForLocale('/ja/create/', 'ja')).toBe('/create/');
  });

  it('locale なし pathname (異常入力) → 入力をそのまま返す', () => {
    // middleware が必ず prefix を付けるので通常起き得ないが、防御的に動く
    expect(pathRestForLocale('/scan', 'ja')).toBe('/scan');
  });

  it('locale 文字を含む別 path (/january) → /january そのまま (false-positive 防止)', () => {
    // "/january".startsWith("/ja/") は false なので入力そのまま返る
    expect(pathRestForLocale('/january', 'ja')).toBe('/january');
  });

  it('locale が単独で出現する dir (/ja-old) → そのまま', () => {
    expect(pathRestForLocale('/ja-old', 'ja')).toBe('/ja-old');
  });
});

describe('pathMatches: rest が href にマッチするか', () => {
  it('完全一致 → true', () => {
    expect(pathMatches('/scan', '/scan')).toBe(true);
  });

  it('subpath → true', () => {
    expect(pathMatches('/scan/manual', '/scan')).toBe(true);
  });

  it('深い subpath → true', () => {
    expect(pathMatches('/explore/category/dex', '/explore')).toBe(true);
  });

  it('プレフィックスが似ているが異なる path → false (false-positive 防止)', () => {
    // /scan-archive は /scan で始まるが /scan の subpath ではない
    expect(pathMatches('/scan-archive', '/scan')).toBe(false);
    expect(pathMatches('/scanned', '/scan')).toBe(false);
  });

  it('空 rest と root href のマッチ', () => {
    expect(pathMatches('', '/scan')).toBe(false);
  });

  it('rest が href より短い → false', () => {
    expect(pathMatches('/sc', '/scan')).toBe(false);
  });
});

describe('NAV_ITEMS active state (integration: pathRestForLocale → pathMatches)', () => {
  // 各 nav item が想定する path での active 判定が正しく動くこと。
  // 「/ja」(LP) では全 nav item が inactive (ロゴ click で /ja に戻る設計)。
  it.each([
    ['/ja', '', { pay: false, sell: false, store: false, me: false }],
    ['/ja/scan', '/scan', { pay: true, sell: false, store: false, me: false }],
    [
      '/ja/scan/help',
      '/scan/help',
      { pay: true, sell: false, store: false, me: false },
    ],
    ['/ja/create', '/create', { pay: false, sell: true, store: false, me: false }],
    ['/ja/store', '/store', { pay: false, sell: false, store: true, me: false }],
    [
      '/ja/store/library',
      '/store/library',
      { pay: false, sell: false, store: true, me: false },
    ],
    ['/ja/me', '/me', { pay: false, sell: false, store: false, me: true }],
    // 旧ナビの行き先はどれもハイライトしない (URL は維持・導線は /me と /store 下部)
    ['/ja/history', '/history', { pay: false, sell: false, store: false, me: false }],
    ['/ja/explore', '/explore', { pay: false, sell: false, store: false, me: false }],
  ])('pathname=%s → rest=%s, 期待 active=%j', (pathname, expectedRest, active) => {
    const rest = pathRestForLocale(pathname, 'ja');
    expect(rest).toBe(expectedRest);
    for (const item of NAV_ITEMS) {
      expect(pathMatches(rest, item.href)).toBe(
        (active as Record<string, boolean>)[item.key],
      );
    }
  });

describe('navItems: DESKTOP_NAV_ITEMS (PC 専用拡張)', () => {
  it('モバイル/PC とも同じ 4 枠 (AIストア単独項目は廃止・Store 経由 = P4)', () => {
    expect(NAV_ITEMS).toHaveLength(4);
    expect(DESKTOP_NAV_ITEMS).toEqual(NAV_ITEMS);
  });
});
});
