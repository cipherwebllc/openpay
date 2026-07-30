// @handle ページ (app/[locale]/[handle]/page) の generateMetadata を実行して検証する。
// storefront 公開時はモバイルオーダー meta、非公開/flag OFF はプロフ (link-in-bio) meta に
// 分岐する。分岐条件はページ本体の MobileOrderView ゲートと同一式なので、ここがズレると
// カードと本体が食い違う (それを防ぐ回帰)。env / resolveHandle をモックする。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enableHandles: true,
  enableMobileOrder: false,
  enableCreatorStore: false,
  enableCreatorStoreUi: false,
  hostedProducts: [] as unknown[] | null,
  record: null as unknown,
  ok: true,
}));
const listAvailableHostedForOwner = vi.hoisted(() => vi.fn());

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
  resolveHandle: vi.fn(async () => (h.ok ? { ok: true, record: h.record } : { ok: false })),
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  listAvailableHostedForOwner,
}));
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: vi.fn(
    async ({
      locale,
      namespace,
    }: {
      locale: string;
      namespace: string;
    }) =>
      (key: string) => {
        if (
          namespace === 'CreatorStorefront' &&
          key === 'productMetaFallback'
        ) {
          return locale === 'en'
            ? 'Buy this digital product on OpenPay.'
            : 'このデジタル商品を OpenPay で購入できます。';
        }
        return key;
      },
  ),
}));

import { generateMetadata } from '@/app/[locale]/[handle]/page';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const PRODUCT_ID = `h_${'a'.repeat(32)}`;
const PROFILE_RECORD = {
  owner: ADDR,
  config: { to: ADDR, name: '山田太郎', methods: [{ token: 'jpyc', chain: 'polygon' }] },
  profile: { bio: 'Web3 クリエイター' },
  createdAt: 1,
  updatedAt: 2,
};
const PRODUCT = {
  id: PRODUCT_ID,
  owner: ADDR,
  payTo: ADDR,
  title: 'AI プロンプト集',
  desc: '仕事で使えるテンプレート',
  emoji: '🧠',
  priceJpyc: '1200',
  contentKind: 'text',
  label: 'prompt',
  contentRevision: 1,
  saleActive: true,
  contentAvailable: true,
  createdAt: 1,
};
const STORE_RECORD = {
  owner: ADDR,
  config: { to: ADDR, name: '山田太郎', methods: [{ token: 'jpyc', chain: 'polygon' }] },
  profile: {},
  storefront: {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    shopName: '山田カフェ',
    tagline: 'こだわり珈琲',
    menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
  },
  createdAt: 1,
  updatedAt: 2,
};

// Next は dynamic param を %40 で渡す (page が decodeHandleSegment する)。
const call = (rawHandle: string, locale = 'ja', product?: string) =>
  generateMetadata({
    params: Promise.resolve({ locale, handle: rawHandle }),
    searchParams: Promise.resolve(product ? { product } : {}),
  });

beforeEach(() => {
  h.enableHandles = true;
  h.enableMobileOrder = false;
  h.enableCreatorStore = false;
  h.enableCreatorStoreUi = false;
  h.hostedProducts = [];
  h.ok = true;
  h.record = PROFILE_RECORD;
  listAvailableHostedForOwner.mockReset();
  listAvailableHostedForOwner.mockImplementation(
    async () => h.hostedProducts,
  );
});

describe('@handle generateMetadata', () => {
  it('storefront 公開 (enableMobileOrder ON) はモバイルオーダー meta', async () => {
    h.enableMobileOrder = true;
    h.record = STORE_RECORD;
    const m = await call('%40yamada');
    expect(m.title).toBe('山田カフェ のモバイルオーダー — OpenPay');
    expect(String(m.description)).toContain('JPYC');
    // OG/Twitter 画像が付く (/api/og/handle)。
    expect(JSON.stringify(m.twitter)).toContain('summary_large_image');
    expect(JSON.stringify(m.openGraph?.images)).toContain('/api/og/handle');
  });

  it('storefront あっても enableMobileOrder OFF はプロフ meta (本体ゲートと一致)', async () => {
    h.enableMobileOrder = false;
    h.record = STORE_RECORD;
    const m = await call('%40yamada');
    expect(String(m.title)).toContain('山田太郎');
    expect(String(m.title)).not.toContain('モバイルオーダー');
  });

  it('プロフのみ (storefront 無し) はプロフ meta + bio description', async () => {
    h.record = PROFILE_RECORD;
    const m = await call('%40masia');
    expect(m.title).toBe('山田太郎 (@masia) — OpenPay');
    expect(String(m.description)).toContain('Web3 クリエイター');
  });

  it('販売可能な owner 商品の product 指定は商品 meta と商品 OG URL を返す', async () => {
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    h.hostedProducts = [PRODUCT];

    const m = await call('%40masia', 'ja', PRODUCT_ID);

    expect(m.title).toBe('AI プロンプト集 — 山田太郎');
    expect(m.description).toBe(
      '仕事で使えるテンプレート 1200 JPYC (Polygon)',
    );
    expect(JSON.stringify(m.openGraph?.images)).toContain(
      `product=${PRODUCT_ID}`,
    );
    expect(JSON.stringify(m.twitter)).toContain('summary_large_image');
    expect(listAvailableHostedForOwner).toHaveBeenCalledWith(ADDR);
  });

  it('商品説明がない場合は locale 別の定型文と価格を description にする', async () => {
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    h.hostedProducts = [{ ...PRODUCT, desc: undefined }];

    const m = await call('%40masia', 'en', PRODUCT_ID);

    expect(m.description).toBe(
      'Buy this digital product on OpenPay. 1200 JPYC (Polygon)',
    );
  });

  it('product 不一致は既存プロフ meta に完全 fallback する', async () => {
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    h.hostedProducts = [PRODUCT];

    const m = await call('%40masia', 'ja', `h_${'b'.repeat(32)}`);

    expect(m.title).toBe('山田太郎 (@masia) — OpenPay');
    expect(m.description).toBe('Web3 クリエイター');
    expect(JSON.stringify(m.openGraph?.images)).not.toContain('product=');
  });

  it('storefront 公開時は product 指定を無視して既存店舗 meta を維持する', async () => {
    h.enableMobileOrder = true;
    h.enableCreatorStore = true;
    h.enableCreatorStoreUi = true;
    h.record = STORE_RECORD;
    h.hostedProducts = [PRODUCT];

    const m = await call('%40yamada', 'ja', PRODUCT_ID);

    expect(m.title).toBe('山田カフェ のモバイルオーダー — OpenPay');
    expect(JSON.stringify(m.openGraph?.images)).not.toContain('product=');
    expect(listAvailableHostedForOwner).not.toHaveBeenCalled();
  });

  it('flag OFF は素の OpenPay meta (KV を読まない)', async () => {
    h.enableHandles = false;
    const m = await call('%40masia');
    expect(m.title).toBe('OpenPay');
  });
});
