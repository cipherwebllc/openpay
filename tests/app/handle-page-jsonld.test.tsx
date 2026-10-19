import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { HandleRecord } from '@/lib/handle';

const state = vi.hoisted(() => ({
  enableHandles: true,
  enableMobileOrder: false,
  enableShopLive: false,
  enableCreatorStore: false,
  enableCreatorStoreUi: false,
  hostedProducts: [] as unknown[] | null,
  renderedStorefrontProducts: [] as unknown[],
  renderedAutoOpenProductId: undefined as string | undefined,
  record: null as unknown,
}));
const listAvailableHostedForOwner = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return state.enableHandles;
      },
      get enableMobileOrder() {
        return state.enableMobileOrder;
      },
      get enableShopLive() {
        return state.enableShopLive;
      },
      get enableCreatorStore() {
        return state.enableCreatorStore;
      },
      get enableCreatorStoreUi() {
        return state.enableCreatorStoreUi;
      },
    },
  };
});

vi.mock('@/lib/handleStore', () => ({
  resolveHandle: vi.fn(async () => ({ ok: true, record: state.record })),
}));

vi.mock('@/lib/handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handle')>();
  return {
    ...actual,
    handleStorefrontConfig: (record: HandleRecord) =>
      record.storefront ?? null,
  };
});

vi.mock('@/lib/shopLiveStore', () => ({
  readShopLive: vi.fn(async () => undefined),
}));

vi.mock('@/lib/x402/hostedStore', () => ({
  selectProfileProducts: (products: ReadonlyArray<{ featured?: boolean }>) => {
    const featured = products.filter((p) => p.featured === true);
    return featured.length === 0
      ? { shown: [...products], hiddenCount: 0 }
      : { shown: featured, hiddenCount: products.length - featured.length };
  },
  listAvailableHostedForOwner,
}));

vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getLocale: vi.fn(async () => 'ja'),
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock('@/components/LocaleSwitcher', () => ({
  LocaleSwitcher: () => null,
}));

vi.mock('@/components/HandleProfile', () => ({
  HandleProfileView: () => null,
}));

vi.mock('@/components/ReceiveMethodPicker', () => ({
  ReceiveMethodPicker: () => null,
}));

vi.mock('@/components/HandleShareButton', () => ({
  HandleShareButton: () => null,
}));

vi.mock('@/components/MobileOrderView', () => ({
  MobileOrderView: () => null,
}));

vi.mock('@/components/CreatorStorefrontSection', () => ({
  CreatorStorefrontSection: ({
    products,
    autoOpenProductId,
  }: {
    products: Array<{ id: string }>;
    autoOpenProductId?: string;
  }) => {
    state.renderedStorefrontProducts = products;
    state.renderedAutoOpenProductId = autoOpenProductId;
    return (
      <div data-testid="creator-storefront">
        {products.map((product) => product.id).join(',')}
      </div>
    );
  },
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    prefetch: _prefetch,
    ...props
  }: {
    children: ReactNode;
    prefetch?: boolean;
    href: string;
    [key: string]: unknown;
  }) => <a {...props}>{children}</a>,
}));

vi.mock('next/image', () => ({
  default: () => null,
}));

import HandlePage from '@/app/[locale]/[handle]/page';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
let handleSequence = 0;

function record(overrides: Partial<HandleRecord> = {}): HandleRecord {
  return {
    owner: ADDR,
    config: {
      to: ADDR,
      name: '山田太郎',
      methods: [{ token: 'jpyc', chain: 'polygon' }],
    },
    profile: {
      bio: 'Web3 クリエイター',
      avatar: 'https://example.com/avatar.png',
      socials: [
        'https://x.com/openpay',
        'https://github.com/open-pay-jp',
      ],
      links: [
        {
          label: '一般リンク',
          url: 'https://example.com/must-not-be-same-as',
        },
      ],
    },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function renderHandlePage(
  nextRecord: HandleRecord,
  options: {
    mobileOrder?: boolean;
    handle?: string;
    product?: string;
  } = {},
): Promise<RenderResult> {
  state.record = nextRecord;
  state.enableMobileOrder = options.mobileOrder ?? false;
  state.renderedAutoOpenProductId = undefined;
  const handle = options.handle ?? `jsonld${handleSequence++}`;
  const ui = await HandlePage({
    params: Promise.resolve({ locale: 'ja', handle: `%40${handle}` }),
    searchParams: Promise.resolve(
      options.product ? { product: options.product } : {},
    ),
  });
  return render(ui);
}

function jsonLdScripts(container: HTMLElement): HTMLScriptElement[] {
  return Array.from(
    container.querySelectorAll<HTMLScriptElement>(
      'script[type="application/ld+json"]',
    ),
  );
}

function parseOnlyJsonLd(container: HTMLElement): Record<string, unknown> {
  const scripts = jsonLdScripts(container);
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].textContent ?? '') as Record<string, unknown>;
}

beforeEach(() => {
  state.enableHandles = true;
  state.enableMobileOrder = false;
  state.enableShopLive = false;
  state.enableCreatorStore = false;
  state.enableCreatorStoreUi = false;
  state.hostedProducts = [];
  state.renderedStorefrontProducts = [];
  state.renderedAutoOpenProductId = undefined;
  state.record = null;
  listAvailableHostedForOwner.mockImplementation(
    async () => state.hostedProducts,
  );
});

describe('@handle ProfilePage JSON-LD', () => {
  it('D3: footer link is named by its visible poweredBy text', async () => {
    const view = await renderHandlePage(record());
    expect(view.getByText('poweredBy').closest('a')).toHaveAccessibleName('poweredBy');
  });

  it('ProfilePage.mainEntity=Person と公開プロフィール項目を一致させ、sameAs に一般リンクを混ぜない', async () => {
    const pageRecord = record();
    const { container } = await renderHandlePage(pageRecord, {
      handle: 'Alice_Profile',
    });

    const jsonLd = parseOnlyJsonLd(container);
    expect(jsonLd).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      mainEntity: {
        '@type': 'Person',
        name: '山田太郎',
        alternateName: '@alice_profile',
        description: 'Web3 クリエイター',
        image: 'https://example.com/avatar.png',
        url: 'https://open-pay.jp/@alice_profile',
        sameAs: [
          'https://x.com/openpay',
          'https://github.com/open-pay-jp',
        ],
      },
    });
    expect(JSON.stringify(jsonLd)).not.toContain(
      'must-not-be-same-as',
    );
  });

  it('</script><script> 注入を script 1 個に閉じ、textContent を安全化しつつ JSON.parse で元値へ復元する', async () => {
    const injection = '</script><script data-injected="true">';
    const pageRecord = record({
      config: {
        to: ADDR,
        name: `表示名${injection}`,
        methods: [{ token: 'jpyc', chain: 'polygon' }],
      },
      profile: {
        bio: `自己紹介${injection}`,
        socials: [`https://example.com/${injection}`],
      },
    });
    const { container } = await renderHandlePage(pageRecord);

    const scripts = jsonLdScripts(container);
    expect(scripts).toHaveLength(1);
    expect(container.querySelectorAll('script')).toHaveLength(1);
    expect(scripts[0].textContent).not.toContain('</script');

    const parsed = JSON.parse(scripts[0].textContent ?? '') as {
      mainEntity: {
        name: string;
        description: string;
        sameAs: string[];
      };
    };
    expect(parsed.mainEntity.name).toBe(`表示名${injection}`);
    expect(parsed.mainEntity.description).toBe(`自己紹介${injection}`);
    expect(parsed.mainEntity.sameAs).toEqual([
      `https://example.com/${injection}`,
    ]);
  });

  it('storefront または profile 内容なしでは出さず、!storefront && hasProfile のときだけ出す', async () => {
    const storefrontRecord = record({
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'coffee', name: 'コーヒー', price: '500' }],
      },
    });
    const storefront = await renderHandlePage(storefrontRecord, {
      mobileOrder: true,
    });
    expect(jsonLdScripts(storefront.container)).toHaveLength(0);

    const emptyProfile = await renderHandlePage(
      record({ profile: {} }),
    );
    expect(jsonLdScripts(emptyProfile.container)).toHaveLength(0);

    const profile = await renderHandlePage(record());
    expect(jsonLdScripts(profile.container)).toHaveLength(1);
  });

  it.each([
    ['avatar なし', undefined],
    ['非 https avatar', 'http://example.com/avatar.png'],
  ])('%s では Person.image を省略する', async (_label, avatar) => {
    const pageRecord = record({
      config: {
        to: ADDR,
        methods: [{ token: 'jpyc', chain: 'polygon' }],
      },
      profile: {
        links: [{ label: 'プロフィール', url: 'https://example.com' }],
        ...(avatar ? { avatar } : {}),
      },
    });
    const { container } = await renderHandlePage(pageRecord);

    const jsonLd = parseOnlyJsonLd(container);
    expect(jsonLd.mainEntity).toEqual({
      '@type': 'Person',
      alternateName: expect.stringMatching(/^@jsonld\d+$/),
      url: expect.stringMatching(/^https:\/\/open-pay\.jp\/@jsonld\d+$/),
    });
    expect(jsonLd.mainEntity).not.toHaveProperty('image');
    expect(jsonLd.mainEntity).not.toHaveProperty('name');
    expect(jsonLd.mainEntity).not.toHaveProperty('description');
    expect(jsonLd.mainEntity).not.toHaveProperty('sameAs');
  });

  it.each([undefined, 'https://files.example/gate'])('両 creator-store flag ON の商品表示は配布先 %s を boolean に限定する', async (deliveryUrl) => {
    state.enableCreatorStore = true;
    state.enableCreatorStoreUi = true;
    state.hostedProducts = [
      {
        id: `h_${'a'.repeat(32)}`,
        owner: ADDR,
        payTo: ADDR,
        title: 'Prompt',
        deliveryUrl,
        details: '内容物\n使い方',
        specs: [{ label: '形式', value: 'GLB' }],
        demoUrl: 'https://example.com/demo',
        usage: { commercial: 'allowed', note: 'クレジット表記をお願いします' },
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/product-side.png',
          'https://cdn.example.com/product-back.png',
        ],
        priceJpyc: '300',
        usdcEnabled: true,
        contentKind: 'text',
        label: 'prompt',
        contentRevision: 1,
        saleActive: true,
        contentAvailable: true,
        createdAt: 1,
        content: { kind: 'text', value: '絶対に公開しない本文' },
      },
    ];

    const { container } = await renderHandlePage(record());

    expect(listAvailableHostedForOwner).toHaveBeenCalledWith(ADDR);
    expect(
      container.querySelector('[data-testid="creator-storefront"]'),
    ).toHaveTextContent(`h_${'a'.repeat(32)}`);
    expect(state.renderedStorefrontProducts).toEqual([
      {
        id: `h_${'a'.repeat(32)}`,
        title: 'Prompt',
        protectedDelivery: !!deliveryUrl,
        details: '内容物\n使い方',
        specs: [{ label: '形式', value: 'GLB' }],
        demoUrl: 'https://example.com/demo',
        usage: { commercial: 'allowed', note: 'クレジット表記をお願いします' },
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/product-side.png',
          'https://cdn.example.com/product-back.png',
        ],
        priceJpyc: '300',
        usdcEnabled: true,
        payTo: ADDR,
        contentKind: 'text',
        label: 'prompt',
      },
    ]);
    expect(JSON.stringify(state.renderedStorefrontProducts)).not.toContain('deliveryUrl');
    expect(container.innerHTML).not.toContain('https://files.example/gate');
  });

  it('商品 storage 障害は既存ページへ波及させず節だけ省略する', async () => {
    state.enableCreatorStore = true;
    state.enableCreatorStoreUi = true;
    state.hostedProducts = null;

    const { container } = await renderHandlePage(record());

    expect(jsonLdScripts(container)).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="creator-storefront"]'),
    ).toBeNull();
  });

  it('product deep link は販売可能リストに一致する商品だけ auto open 対象にする', async () => {
    state.enableCreatorStore = true;
    state.enableCreatorStoreUi = true;
    const productId = `h_${'c'.repeat(32)}`;
    state.hostedProducts = [
      {
        id: productId,
        owner: ADDR,
        payTo: ADDR,
        title: 'Deep link product',
        priceJpyc: '500',
        contentKind: 'url',
        label: 'download',
        contentRevision: 1,
        saleActive: true,
        contentAvailable: true,
        createdAt: 1,
      },
    ];

    await renderHandlePage(record(), { product: productId });
    expect(state.renderedAutoOpenProductId).toBe(productId);

    await renderHandlePage(record(), {
      product: `h_${'d'.repeat(32)}`,
    });
    expect(state.renderedAutoOpenProductId).toBeUndefined();
  });
});

it('keeps owner deliveryUrl out of public HTML/JSON-LD and the RSC-to-client product props', async () => {
  state.enableCreatorStore = true; state.enableCreatorStoreUi = true;
  const deliveryUrl = 'https://files.example/private-delivery-sentinel';
  state.hostedProducts = [{ id: `h_${'a'.repeat(32)}`, owner: ADDR, payTo: ADDR, title: 'Delivery', priceJpyc: '300', contentKind: 'text', label: 'prompt', contentRevision: 1, saleActive: true, contentAvailable: true, createdAt: 1, deliveryUrl }];
  const { container } = await renderHandlePage(record());
  expect(state.renderedStorefrontProducts).toHaveLength(1);
  expect(state.renderedStorefrontProducts[0]).not.toHaveProperty('deliveryUrl');
  expect(JSON.stringify(state.renderedStorefrontProducts)).not.toContain(deliveryUrl);
  expect(container.innerHTML).not.toContain(deliveryUrl);
});

// 商品ページ (?product=) の schema.org Product/Offer (plans/store-product-jsonld.md)。ProfilePage とは別 gate・
// プロフ本体には出さない・私的な項目はページの詰め替え経路でも出ない (Fable の計画レビュー必須 1)。
describe('@handle 商品ページの Product JSON-LD', () => {
  const PRODUCT_ID = `h_${'e'.repeat(32)}`;
  const DELIVERY = 'https://files.example/private-delivery-sentinel';
  function product(over: Record<string, unknown> = {}) {
    return {
      id: PRODUCT_ID, owner: ADDR, payTo: ADDR, title: 'Kit', priceJpyc: '500', contentKind: 'url', label: 'download',
      contentRevision: 1, saleActive: true, contentAvailable: true, createdAt: 1, deliveryUrl: DELIVERY,
      registration: { status: 'registered', txHash: '0xREGISTRATION_SENTINEL' },
      usage: { commercial: 'allowed' }, ...over,
    };
  }
  function scriptsOf(container: HTMLElement) {
    return jsonLdScripts(container).map((script) => JSON.parse(script.textContent ?? '') as Record<string, unknown>);
  }
  beforeEach(() => {
    state.enableCreatorStore = true;
    state.enableCreatorStoreUi = true;
  });

  it('載っている商品の ?product= だけ ProfilePage に加えて Product を出し、私的な項目は JSON-LD に出ない', async () => {
    state.hostedProducts = [product()];
    const { container } = await renderHandlePage(record(), { product: PRODUCT_ID });
    const scripts = scriptsOf(container);
    expect(scripts.map((value) => value['@type'])).toEqual(['ProfilePage', 'Product']);
    expect(scripts[1]).toMatchObject({
      name: 'Kit',
      url: expect.stringMatching(new RegExp(`^https://open-pay\\.jp/ja/@jsonld\\d+\\?product=${PRODUCT_ID}$`)),
      offers: { price: '505', priceCurrency: 'JPYC', availability: 'https://schema.org/InStock', seller: { '@type': 'Person', name: '山田太郎' } },
    });
    const ld = jsonLdScripts(container).map((script) => script.textContent).join('');
    for (const leaked of [DELIVERY, ADDR, ADDR.toLowerCase(), 'REGISTRATION_SENTINEL']) expect(ld).not.toContain(leaked);
    expect(container.innerHTML).not.toContain(DELIVERY);
  });

  it('ProfilePage が出ないプロフ (内容なし) でも、商品ページなら Product だけ出す (gate は独立)', async () => {
    state.hostedProducts = [product()];
    const { container } = await renderHandlePage(record({ profile: {} }), { product: PRODUCT_ID });
    expect(scriptsOf(container).map((value) => value['@type'])).toEqual(['Product']);
  });

  it('?product= なし・ページに無い id・商品の storage 障害では Product を出さない', async () => {
    state.hostedProducts = [product()];
    expect(scriptsOf((await renderHandlePage(record())).container).map((value) => value['@type'])).toEqual(['ProfilePage']);
    expect(scriptsOf((await renderHandlePage(record(), { product: `h_${'f'.repeat(32)}` })).container).map((value) => value['@type'])).toEqual(['ProfilePage']);
    state.hostedProducts = null;
    expect(scriptsOf((await renderHandlePage(record(), { product: PRODUCT_ID })).container).map((value) => value['@type'])).toEqual(['ProfilePage']);
  });

  it('商品名の </script> 注入は script の外に出ず、JSON.parse で元の値へ戻る', async () => {
    const title = '</script><script>alert(1)</script>';
    state.hostedProducts = [product({ title })];
    const { container } = await renderHandlePage(record(), { product: PRODUCT_ID });
    expect(container.querySelectorAll('script')).toHaveLength(2);
    expect(scriptsOf(container)[1].name).toBe(title);
  });
});
