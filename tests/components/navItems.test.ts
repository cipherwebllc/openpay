import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, pathMatches, pathRestForLocale } from '@/components/navItems';

describe('navItems: NAV_ITEMS shape (regression fence)', () => {
  it('4 items が宣言されている (ホームは Nav から外す確定済)', () => {
    expect(NAV_ITEMS).toHaveLength(4);
  });

  it('1 slot 目は「スキャン (/scan)」で支払う動線', () => {
    expect(NAV_ITEMS[0]).toMatchObject({ key: 'scan', href: '/scan' });
  });

  it('全 item key は { scan / create / history / explore } のいずれか', () => {
    const valid = new Set(['scan', 'create', 'history', 'explore']);
    for (const item of NAV_ITEMS) {
      expect(valid.has(item.key)).toBe(true);
    }
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
    ['/ja', '', { scan: false, create: false, history: false, explore: false }],
    [
      '/ja/scan',
      '/scan',
      { scan: true, create: false, history: false, explore: false },
    ],
    [
      '/ja/scan/help',
      '/scan/help',
      { scan: true, create: false, history: false, explore: false },
    ],
    [
      '/ja/create',
      '/create',
      { scan: false, create: true, history: false, explore: false },
    ],
    [
      '/ja/history',
      '/history',
      { scan: false, create: false, history: true, explore: false },
    ],
    [
      '/ja/explore',
      '/explore',
      { scan: false, create: false, history: false, explore: true },
    ],
  ])('pathname=%s → rest=%s, 期待 active=%j', (pathname, expectedRest, active) => {
    const rest = pathRestForLocale(pathname, 'ja');
    expect(rest).toBe(expectedRest);
    for (const item of NAV_ITEMS) {
      expect(pathMatches(rest, item.href)).toBe(
        (active as Record<string, boolean>)[item.key],
      );
    }
  });
});
