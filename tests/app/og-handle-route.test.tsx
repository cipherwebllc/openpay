import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CSSProperties, ReactElement } from 'react';

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
  enableCreatorStore: false,
  enableCreatorStoreUi: false,
  record: null as unknown,
  resolveOk: true,
}));
const ssrf = vi.hoisted(() => ({
  fetchSafe: vi.fn(),
}));
const hosted = vi.hoisted(() => ({
  listAvailableForOwner: vi.fn(),
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
      get enableCreatorStore() {
        return h.enableCreatorStore;
      },
      get enableCreatorStoreUi() {
        return h.enableCreatorStoreUi;
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
vi.mock('@/lib/x402/hostedStore', () => ({
  selectProfileProducts: (products: ReadonlyArray<{ featured?: boolean }>) => {
    const featured = products.filter((p) => p.featured === true);
    return featured.length === 0
      ? { shown: [...products], hiddenCount: 0 }
      : { shown: featured, hiddenCount: products.length - featured.length };
  },
  isHostedId: (value: unknown) =>
    typeof value === 'string' && /^h_[0-9a-f]{32}$/.test(value),
  listAvailableHostedForOwner: hosted.listAvailableForOwner,
}));

import { GET } from '@/app/api/og/handle/route';
import { ogCardElement } from '@/app/api/og/_card';
import { buildHandleOgModel } from '@/lib/ogTipCard';

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
  h.enableCreatorStore = false;
  h.enableCreatorStoreUi = false;
  h.resolveOk = true;
  h.record = RECORD;
  ssrf.fetchSafe.mockReset();
  ssrf.fetchSafe.mockImplementation(async (url: string, opts: RequestInit) => {
    if (new URL(url).hostname === 'localhost') return null;
    return fetch(url, { redirect: opts.redirect });
  });
  hosted.listAvailableForOwner.mockReset();
  hosted.listAvailableForOwner.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/og/handle', () => {
  it('cover と avatar を並列取得し data URL で ImageResponse を生成する', async () => {
    const coverUrl = 'https://cdn.example.com/cover.png';
    h.record = { ...RECORD, profile: { ...RECORD.profile, cover: coverUrl } };
    let finishAvatar!: (response: Response) => void;
    ssrf.fetchSafe.mockImplementation((url: string) => {
      if (url === RECORD.profile.avatar) {
        return new Promise<Response>((resolve) => { finishAvatar = resolve; });
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      }));
    });
    const pending = callGet('h=masia&locale=ja');
    try {
      await vi.waitFor(() => expect(ssrf.fetchSafe).toHaveBeenCalledTimes(2));
    } finally {
      finishAvatar(new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      }));
    }
    const { element, options } = await pending;
    expect(ssrf.fetchSafe).toHaveBeenCalledWith(coverUrl, {
      redirect: 'error', timeoutMs: 3000, userAgent: 'OpenPay-og-avatar/1.0',
    });
    expect(collectImgSrcs(element)).toEqual([
      'data:image/png;base64,AQID',
      'data:image/png;base64,iVBORw==',
      expect.stringContaining('data:image/png;base64,'),
    ]);
    expect(ctorCalls).toHaveLength(1);
    expect(options.status ?? 200).toBe(200);
    expect(options).toMatchObject({ width: 1200, height: 630 });
  });

  it('cover fetch が null でも 200 で cover 無しの従来カードを返す', async () => {
    ssrf.fetchSafe.mockResolvedValue(null);
    const baseline = await callGet('h=masia');
    const coverUrl = 'https://cdn.example.com/cover.png';
    h.record = { ...RECORD, profile: { ...RECORD.profile, cover: coverUrl } };
    const result = await callGet('h=masia');
    expect(ssrf.fetchSafe).toHaveBeenCalledWith(coverUrl, expect.any(Object));
    expect(result.options.status ?? 200).toBe(200);
    expect(result).toEqual(baseline);
  });

  it('http の cover は fetch せず従来カードを返す', async () => {
    ssrf.fetchSafe.mockResolvedValue(null);
    const baseline = await callGet('h=masia');
    ssrf.fetchSafe.mockClear();
    h.record = {
      ...RECORD,
      profile: { ...RECORD.profile, cover: 'http://cdn.example.com/cover.png' },
    };
    const result = await callGet('h=masia');
    expect(ssrf.fetchSafe).toHaveBeenCalledTimes(1);
    expect(ssrf.fetchSafe).toHaveBeenCalledWith(RECORD.profile.avatar, expect.any(Object));
    expect(result).toEqual(baseline);
  });

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

  it('有効な商品 deep link は KV 権威の商品カードを描く', async () => {
    h.record = { ...RECORD, profile: { ...RECORD.profile, cover: 'https://cdn.example.com/cover.png' } };
    const productId = `h_${'a'.repeat(32)}`;
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    hosted.listAvailableForOwner.mockResolvedValue([
      {
        id: productId,
        title: 'AI プロンプト集',
        emoji: '🧠',
        priceJpyc: '1200',
        saleActive: true,
        contentAvailable: true,
      },
    ]);

    const { element } = await callGet(
      `h=masia&locale=ja&product=${productId}&title=FORGED&price=999999`,
    );
    const text = collectText(element).join(' ');
    expect(hosted.listAvailableForOwner).toHaveBeenCalledWith(RECORD.owner);
    expect(text).toContain('AI プロンプト集');
    expect(text).toContain('🧠');
    expect(text).toContain('1,200 JPYC · Polygon');
    expect(text).toContain('山田太郎 · @masia');
    expect(text).not.toContain('Web3 クリエイター');
    expect(text).not.toContain('FORGED');
    expect(text).not.toContain('999999');
    expect(ssrf.fetchSafe).not.toHaveBeenCalled();
  });

  it('商品画像は KV 権威 URL を既存 avatar pipeline で data URL 化して描く', async () => {
    const productId = `h_${'d'.repeat(32)}`;
    const imageUrl = 'https://cdn.example.com/product.png';
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    hosted.listAvailableForOwner.mockResolvedValue([
      {
        id: productId,
        title: '画像つき商品',
        emoji: '🧠',
        imageUrl,
        priceJpyc: '800',
        saleActive: true,
        contentAvailable: true,
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const { element } = await callGet(
      `h=masia&locale=ja&product=${productId}&imageUrl=https://evil.example/forged.png`,
    );

    expect(ssrf.fetchSafe).toHaveBeenCalledWith(imageUrl, {
      redirect: 'error',
      timeoutMs: 3000,
      userAgent: 'OpenPay-og-avatar/1.0',
    });
    expect(
      collectImgSrcs(element).filter((src) =>
        src.startsWith('data:image/png;base64,'),
      ),
    ).toHaveLength(2);
    expect(collectText(element).join(' ')).not.toContain('🧠');
  });

  it('商品画像の取得失敗は絵文字円へ fallback する', async () => {
    const productId = `h_${'e'.repeat(32)}`;
    const imageUrl = 'https://private-dns.example/product.png';
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    hosted.listAvailableForOwner.mockResolvedValue([
      {
        id: productId,
        title: 'fallback 商品',
        emoji: '📦',
        imageUrl,
        priceJpyc: '500',
        saleActive: true,
        contentAvailable: true,
      },
    ]);
    ssrf.fetchSafe.mockResolvedValueOnce(null);

    const { element } = await callGet(
      `h=masia&locale=ja&product=${productId}`,
    );

    expect(ssrf.fetchSafe).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(collectImgSrcs(element)).toHaveLength(1);
    expect(collectText(element).join(' ')).toContain('📦');
  });

  it('商品不一致/販売不可/flag OFF は既存プロフカードへ fallback', async () => {
    const productId = `h_${'b'.repeat(32)}`;
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    hosted.listAvailableForOwner.mockResolvedValue([
      {
        id: productId,
        title: '販売停止商品',
        priceJpyc: '500',
        saleActive: false,
        contentAvailable: true,
      },
    ]);
    const inactive = await callGet(
      `h=masia&locale=ja&product=${productId}`,
    );
    expect(collectText(inactive.element).join(' ')).toContain('山田太郎');
    expect(collectText(inactive.element).join(' ')).not.toContain('販売停止商品');

    hosted.listAvailableForOwner.mockClear();
    const invalid = await callGet('h=masia&locale=ja&product=not-a-hosted-id');
    expect(collectText(invalid.element).join(' ')).toContain('Web3 クリエイター');
    expect(hosted.listAvailableForOwner).not.toHaveBeenCalled();

    h.enableCreatorStoreUi = false;
    const flagOff = await callGet(
      `h=masia&locale=ja&product=${productId}`,
    );
    expect(collectText(flagOff.element).join(' ')).toContain('JPYC で応援');
    expect(hosted.listAvailableForOwner).not.toHaveBeenCalled();
  });

  it('storefront 公開時は商品 query より既存店舗カードを優先する', async () => {
    const productId = `h_${'c'.repeat(32)}`;
    h.enableMobileOrder = true;
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    h.record = STORE_RECORD;
    hosted.listAvailableForOwner.mockResolvedValue([
      {
        id: productId,
        title: '店舗で出さない商品',
        priceJpyc: '500',
        saleActive: true,
        contentAvailable: true,
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const { element } = await callGet(
      `h=yamada&locale=ja&product=${productId}`,
    );
    const text = collectText(element).join(' ');
    expect(text).toContain('山田カフェ');
    expect(text).toContain('スマホで注文');
    expect(text).not.toContain('店舗で出さない商品');
    expect(hosted.listAvailableForOwner).not.toHaveBeenCalled();
  });

  it('storefront 公開 + enableMobileOrder ON: モバイルオーダー店舗カード (店名/ひとこと/JPYC + 店舗アバター)', async () => {
    h.enableMobileOrder = true;
    h.record = { ...STORE_RECORD, profile: { ...STORE_RECORD.profile, cover: 'https://cdn.example.com/cover.png' } };
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
    expect(ssrf.fetchSafe).toHaveBeenCalledTimes(1);
    expect(ssrf.fetchSafe).toHaveBeenCalledWith(STORE_RECORD.storefront.avatar, expect.any(Object));
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

describe('ogCardElement cover 背景レイヤ', () => {
  const model = buildHandleOgModel({
    handle: 'masia', name: '山田太郎', color: '#2563eb',
    bio: 'Web3 クリエイター', tokenLabels: ['JPYC'], locale: 'ja',
  });
  type CardElement = ReactElement<{ style: CSSProperties; children: CardElement[]; src?: string }>;

  it('cover 無しは従来の背景・白パネル・ブランド行のツリーを保持する', () => {
    const element = ogCardElement(model) as CardElement;
    expect(ogCardElement(model, null, null)).toEqual(element);
    expect(element.props.style).toEqual({
      height: '100%', width: '100%', display: 'flex', flexDirection: 'column',
      padding: 52, gap: 28, fontFamily: 'NotoSansJP', backgroundColor: '#0b1220',
      backgroundImage: 'radial-gradient(circle at 88% -12%, rgba(37, 99, 235, 0.45) 0%, rgba(0,0,0,0) 52%), radial-gradient(circle at -8% 112%, rgba(37, 99, 235, 0.25) 0%, rgba(0,0,0,0) 46%)',
    });
    expect(element.props.children).toHaveLength(2);
    const [panel, footer] = element.props.children;
    expect(panel.type).toBe('div');
    expect(panel.props.style).toEqual({
      flex: 1, display: 'flex', alignItems: 'center', gap: 56,
      backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 40,
      padding: '48px 64px', boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
    });
    expect(footer.props.style).toEqual({
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    });
    expect(collectImgSrcs(element)).toHaveLength(1);
  });

  it('cover ありは背景 img・暗色 overlay を先頭に置きグローを消す', () => {
    const cover = 'data:image/png;base64,AQID';
    const baseline = ogCardElement(model) as CardElement;
    const element = ogCardElement(model, null, cover) as CardElement;
    expect(element.props.style).toEqual({
      ...baseline.props.style, position: 'relative', backgroundImage: undefined,
    });
    expect(element.props.children).toHaveLength(4);
    const [image, overlay, ...foreground] = element.props.children;
    const layer = { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' };
    expect(image.type).toBe('img');
    expect(image.props.src).toBe(cover);
    expect(image.props.style).toEqual({ ...layer, objectFit: 'cover' });
    expect(overlay.type).toBe('div');
    expect(overlay.props.style).toEqual({
      ...layer,
      backgroundImage: 'linear-gradient(180deg, rgba(11,18,32,0.55), rgba(11,18,32,0.75))',
    });
    foreground.forEach((child, index) => {
      expect(child.props.style).toEqual({ ...baseline.props.children[index].props.style, position: 'relative' });
      expect(child.props.children).toEqual(baseline.props.children[index].props.children);
    });
  });
});

it('omits private deliveryUrl from the public OG model and never fetches the gate', async () => {
  h.enableCreatorStore = true; h.enableCreatorStoreUi = true;
  const id = 'h_' + 'a'.repeat(32); const deliveryUrl = 'https://files.example/private-delivery-sentinel';
  hosted.listAvailableForOwner.mockResolvedValue([{ id, owner: RECORD.owner, payTo: RECORD.owner, title: 'Delivery', priceJpyc: '300', saleActive: true, contentAvailable: true, deliveryUrl }]);
  const out = await callGet(`h=masia&locale=ja&product=${id}`);
  expect(collectText(out.element).join(' ')).toContain('Delivery');
  expect(JSON.stringify(out)).not.toContain(deliveryUrl);
  expect(JSON.stringify(ssrf.fetchSafe.mock.calls)).not.toContain(deliveryUrl);
});
