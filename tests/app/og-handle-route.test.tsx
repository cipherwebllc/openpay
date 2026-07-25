import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';

// next/og の ImageResponse は Satori + wasm を要するため、描画せず引数を捕捉する軽量
// モックに差し替え、route の配線 (KV 解決 → モデル → 要素 / avatar fetch / fallback) を
// 検証する (og-tip-route.test と同じ流儀)。
const ctorCalls: Array<{ element: ReactElement; options: Record<string, unknown> }> = [];
vi.mock('next/og', () => ({
  ImageResponse: vi.fn(function (
    this: unknown,
    element: ReactElement,
    options: Record<string, unknown>,
  ) {
    ctorCalls.push({ element, options });
    return { element, options, status: 200 };
  }),
}));

const h = vi.hoisted(() => ({
  enableHandles: true,
  enableMobileOrder: false,
  record: null as unknown,
  resolveOk: true,
}));
const ssrf = vi.hoisted(() => ({
  fetchSafe: vi.fn(),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
      get enableMobileOrder() {
        return h.enableMobileOrder;
      },
    },
  };
});
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: vi.fn(async () =>
    h.resolveOk ? { ok: true, record: h.record } : { ok: false },
  ),
}));
vi.mock('@/lib/x402/moderation', () => ({
  fetchSsrfSafe: ssrf.fetchSafe,
}));

import { GET } from '@/app/api/og/handle/route';

function collectText(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return collectText(props?.children);
  }
  return [];
}

function collectImgSrcs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectImgSrcs);
  if (node && typeof node === 'object' && 'props' in node) {
    const n = node as {
      type?: unknown;
      props?: { src?: string; children?: unknown };
    };
    const own = n.type === 'img' && n.props?.src ? [n.props.src] : [];
    return [...own, ...collectImgSrcs(n.props?.children)];
  }
  return [];
}

async function callGet(query: string) {
  ctorCalls.length = 0;
  await GET(new Request(`https://open-pay.jp/api/og/handle?${query}`));
  return ctorCalls[0];
}

const RECORD = {
  owner: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  config: {
    to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    name: '山田太郎',
    color: '#2563eb',
    methods: [
      { token: 'jpyc', chain: 'polygon' },
      { token: 'jpyc', chain: 'kaia' },
    ],
  },
  profile: { bio: 'Web3 クリエイター', avatar: 'https://cdn.example.com/a.png' },
  createdAt: 1,
  updatedAt: 2,
};

// storefront 公開済みレコード (handleStorefrontConfig が MobileOrderConfig を返せる形)。
const STORE_RECORD = {
  owner: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  config: {
    to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    name: '山田太郎',
    methods: [{ token: 'jpyc', chain: 'polygon' }],
  },
  profile: { avatar: 'https://cdn.example.com/p.png' },
  storefront: {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    shopName: '山田カフェ',
    tagline: 'こだわり珈琲とケーキ',
    avatar: 'https://cdn.example.com/shop.png',
    menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
  },
  createdAt: 1,
  updatedAt: 2,
};

beforeEach(() => {
  h.enableHandles = true;
  h.enableMobileOrder = false;
  h.resolveOk = true;
  h.record = RECORD;
  ssrf.fetchSafe.mockReset();
  ssrf.fetchSafe.mockImplementation(async (url: string, opts: RequestInit) => {
    if (new URL(url).hostname === 'localhost') return null;
    return fetch(url, { redirect: opts.redirect });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/og/handle', () => {
  it('レコードあり: 名前・@handle・bio・ピル + アバター (data URL) を描く', async () => {
    // アバター fetch を画像レスポンスでスタブ
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    const { element, options } = await callGet('h=masia&locale=ja');
    const text = collectText(element).join(' ');
    expect(text).toContain('山田太郎');
    expect(text).toContain('@masia');
    expect(text).toContain('Web3 クリエイター');
    expect(text).toContain('JPYC で応援');
    expect(text).toContain('ガス不要');
    // アバターが data URL の img として描かれる (ブランドアイコンとは別に 2 枚)
    const srcs = collectImgSrcs(element);
    expect(srcs.some((s) => s.startsWith('data:image/png;base64,'))).toBe(true);
    expect(srcs).toHaveLength(2);
    expect(ssrf.fetchSafe).toHaveBeenCalledWith('https://cdn.example.com/a.png', {
      redirect: 'error',
      timeoutMs: 3000,
      userAgent: 'OpenPay-og-avatar/1.0',
    });
    expect(options.width).toBe(1200);
    expect(options.height).toBe(630);
    const headers = options.headers as Record<string, string>;
    expect(headers['cache-control']).toContain('s-maxage=3600');
  });

  it('アバター fetch 失敗 (非画像) → イニシャル円へフォールバック', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const { element } = await callGet('h=masia&locale=ja');
    const srcs = collectImgSrcs(element);
    expect(srcs).toHaveLength(1); // ブランドアイコンのみ
    expect(collectText(element).join(' ')).toContain('山'); // initial
  });

  it('未存在 handle は汎用ブランドカード + 短期キャッシュ可 (200)', async () => {
    h.record = null;
    const { element, options } = await callGet('h=ghost&locale=ja');
    expect(collectText(element).join(' ')).toContain('チップを送る');
    expect(options.status ?? 200).toBe(200);
    expect((options.headers as Record<string, string>)['cache-control']).toContain(
      'max-age=300',
    );
  });

  it('KV 障害 (resolved.ok=false) は 503 + no-store で返す (汎用カードを固定化しない)', async () => {
    h.resolveOk = false;
    const { element, options } = await callGet('h=masia&locale=ja');
    expect(collectText(element).join(' ')).toContain('チップを送る');
    expect(options.status).toBe(503);
    expect((options.headers as Record<string, string>)['cache-control']).toBe(
      'no-store',
    );
  });

  it('webp/avif アバターは satori が decode 不可 → イニシャル円へフォールバック', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        }),
      ),
    );
    const { element } = await callGet('h=masia&locale=ja');
    const srcs = collectImgSrcs(element);
    expect(srcs).toHaveLength(1); // ブランドアイコンのみ (avatar は弾かれた)
    expect(srcs.some((s) => s.startsWith('data:image/webp'))).toBe(false);
    expect(collectText(element).join(' ')).toContain('山'); // initial fallback
  });

  it('Content-Length 上限超過のアバターは body を読まず弾く', async () => {
    const readSpy = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === 'content-type'
              ? 'image/png'
              : k.toLowerCase() === 'content-length'
                ? String(9_000_000)
                : null,
        },
        body: {
          getReader: () => {
            readSpy();
            return { read: async () => ({ done: true }), cancel: async () => {} };
          },
        },
      })),
    );
    const { element } = await callGet('h=masia&locale=ja');
    expect(readSpy).not.toHaveBeenCalled(); // content-length で早期 reject
    expect(collectImgSrcs(element)).toHaveLength(1); // avatar 不採用
  });

  it('flag OFF / 不正 handle も汎用カード', async () => {
    h.enableHandles = false;
    const { element } = await callGet('h=masia&locale=en');
    expect(collectText(element).join(' ')).toContain('Send a tip');
    h.enableHandles = true;
    const second = await callGet('h=!!&locale=ja');
    expect(collectText(second.element).join(' ')).toContain('チップを送る');
  });

  it('storefront 公開 + enableMobileOrder ON: モバイルオーダー店舗カード (店名/ひとこと/JPYC + 店舗アバター)', async () => {
    h.enableMobileOrder = true;
    h.record = STORE_RECORD;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    const { element } = await callGet('h=yamada&locale=ja');
    const text = collectText(element).join(' ');
    expect(text).toContain('山田カフェ'); // 店名 (プロフ名 '山田太郎' ではない)
    expect(text).not.toContain('山田太郎');
    expect(text).toContain('@yamada');
    expect(text).toContain('こだわり珈琲とケーキ'); // tagline = bio 行
    expect(text).toContain('スマホで注文');
    expect(text).toContain('JPYC で支払い');
    expect(text).not.toContain('JPYC で応援'); // プロフピルは出ない
    // 店舗アバターが data URL の img として描かれる。
    const srcs = collectImgSrcs(element);
    expect(srcs.some((s) => s.startsWith('data:image/png;base64,'))).toBe(true);
  });

  it('storefront あっても enableMobileOrder OFF はプロフカード (inert)', async () => {
    h.enableMobileOrder = false;
    h.record = STORE_RECORD;
    // プロフ経路の avatar fetch は非画像で null (実ネットワークを使わない)。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('x', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { element } = await callGet('h=yamada&locale=ja');
    const text = collectText(element).join(' ');
    expect(text).toContain('山田太郎'); // プロフ名
    expect(text).toContain('JPYC で応援'); // プロフピル
    expect(text).not.toContain('スマホで注文');
  });

  it('enableMobileOrder ON でも storefront 未公開ならプロフカード (else 分岐)', async () => {
    h.enableMobileOrder = true;
    h.record = RECORD; // storefront フィールド無し → handleStorefrontConfig は null
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('x', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const { element } = await callGet('h=masia&locale=ja');
    const text = collectText(element).join(' ');
    expect(text).toContain('山田太郎'); // プロフ名
    expect(text).toContain('JPYC で応援');
    expect(text).not.toContain('スマホで注文');
  });

  it('storefront アバターが localhost は SSRF ガードで弾かれイニシャルへ', async () => {
    h.enableMobileOrder = true;
    h.record = {
      ...STORE_RECORD,
      storefront: { ...STORE_RECORD.storefront, avatar: 'https://localhost/shop.png' },
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { element } = await callGet('h=yamada&locale=ja');
    expect(fetchSpy).not.toHaveBeenCalled(); // ブロックホストは fetch せず弾く
    expect(collectImgSrcs(element)).toHaveLength(1); // ブランドアイコンのみ (店舗アバターは弾かれた)
    expect(collectText(element).join(' ')).toContain('山'); // 店名イニシャル fallback
  });

  it('DNS 名が private IP を指す場合は safe fetch が接続前に弾き、イニシャルへ', async () => {
    h.record = {
      ...RECORD,
      profile: {
        ...RECORD.profile,
        avatar: 'https://private-dns.example/avatar.png',
      },
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    ssrf.fetchSafe.mockResolvedValueOnce(null);
    const { element } = await callGet('h=masia&locale=ja');
    expect(ssrf.fetchSafe).toHaveBeenCalledWith(
      'https://private-dns.example/avatar.png',
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(collectImgSrcs(element)).toHaveLength(1);
  });
});
