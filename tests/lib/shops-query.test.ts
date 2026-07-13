import { describe, expect, it } from 'vitest';
import {
  SHOPS_LICENSE_NOTICE,
  createShopsEnvelope,
  parseShopSummary,
  queryShops,
  validateShopQuery,
  type ShopSearchItem,
} from '@/lib/shops/query';

function rawSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    handle: 'sakura_cafe',
    name: 'さくらカフェ',
    tagline: '焼きたてパン',
    address: '東京都千代田区1-2-3',
    mode: 'storefront',
    dineIn: true,
    acceptingOrders: true,
    openFrom: '09:00',
    lastOrder: '18:00',
    minLeadMinutes: 15,
    menu: {
      itemCount: 2,
      minPrice: '300',
      maxPrice: '800.5',
      itemIds: ['bread', 'coffee'],
    },
    chain: 'polygon',
    chains: ['polygon'],
    updatedAt: 1_700_000_000_000,
    phone: '03-0000-0000',
    ...overrides,
  });
}

function item(
  handle: string,
  input: Partial<ShopSearchItem> = {},
): ShopSearchItem {
  return {
    handle,
    name: handle,
    mode: 'storefront',
    dineIn: false,
    acceptingNow: true,
    menu: { itemCount: 1, minPrice: '100', maxPrice: '100' },
    chains: ['polygon'],
    pageUrl: `https://open-pay.jp/@${handle}`,
    menuUrl: `/api/agent-order/menu?h=${handle}`,
    live: { paused: false, soldOutCount: 0, updatedAt: 0 },
    sourceUpdatedAt: 1_700_000_000_000,
    ...input,
  };
}

describe('Shops summary parse / validate', () => {
  it('allowlist だけを再構築し、phone を公開 shape に持ち込まない', () => {
    const parsed = parseShopSummary(rawSummary());
    expect(parsed).toMatchObject({
      handle: 'sakura_cafe',
      name: 'さくらカフェ',
      acceptingOrders: true,
      menu: { itemIds: ['bread', 'coffee'] },
    });
    expect(parsed).not.toHaveProperty('phone');
  });

  it.each([
    '{bad',
    rawSummary({ handle: '../bad' }),
    rawSummary({ mode: 'delivery' }),
    rawSummary({ menu: { itemCount: 1, minPrice: '-1', maxPrice: '3' } }),
    rawSummary({ menu: { itemCount: 1, minPrice: '4', maxPrice: '3' } }),
    rawSummary({ mode: 'preorder', dineIn: true }),
    rawSummary({ chains: ['polygon', 'polygon'] }),
    rawSummary({ chain: 'kaia', chains: ['polygon'] }),
  ])('壊れた summary を拒否: %s', (raw) => {
    expect(parseShopSummary(raw)).toBeNull();
  });

  it('PR-1 既存 summary の acceptingOrders/itemIds 欠落は parse し判定層へ渡す', () => {
    const legacy = JSON.parse(rawSummary()) as Record<string, unknown>;
    delete legacy.acceptingOrders;
    const menu = legacy.menu as Record<string, unknown>;
    delete menu.itemIds;
    expect(parseShopSummary(JSON.stringify(legacy))).toMatchObject({
      handle: 'sakura_cafe',
      menu: { itemCount: 2 },
    });
  });
});

describe('Shops query', () => {
  const items = [
    item('alpha', {
      name: 'Sakura Cafe',
      tagline: '焼きたてパン',
      address: '東京都渋谷区',
      dineIn: true,
    }),
    item('bravo', {
      name: '海辺食堂',
      tagline: 'Fresh fish',
      address: '神奈川県鎌倉市',
      mode: 'preorder',
      acceptingNow: null,
    }),
    item('charlie', {
      name: '夜カフェ',
      address: '東京都新宿区',
      acceptingNow: false,
    }),
  ];

  it('q は name/tagline/address の case-insensitive 部分一致', () => {
    const byName = queryShops(items, {
      q: 'sAkUrA',
      limit: 20,
      offset: 0,
    });
    expect(byName.items.map((entry) => entry.handle)).toEqual(['alpha']);
    expect(
      queryShops(items, { q: 'Fresh', limit: 20, offset: 0 }).items.map(
        (entry) => entry.handle,
      ),
    ).toEqual(['bravo']);
    expect(
      queryShops(items, { q: '新宿', limit: 20, offset: 0 }).items.map(
        (entry) => entry.handle,
      ),
    ).toEqual(['charlie']);
  });

  it('mode/dineIn/offset と acceptingNow=true（null 除外）を組み合わせる', () => {
    expect(
      queryShops(items, {
        mode: 'storefront',
        dineIn: true,
        acceptingNow: true,
        limit: 1,
        offset: 0,
      }),
    ).toMatchObject({ total: 1, items: [{ handle: 'alpha' }] });
    expect(
      queryShops(items, {
        acceptingNow: true,
        limit: 20,
        offset: 1,
      }).items,
    ).toEqual([]);
  });

  it('validator は limit を20に capし、unknown/不正値を拒否', () => {
    expect(
      validateShopQuery(
        new URLSearchParams('mode=preorder&dineIn=0&limit=999&offset=2'),
      ),
    ).toEqual({
      ok: true,
      value: { mode: 'preorder', dineIn: false, limit: 20, offset: 2 },
    });
    for (const query of [
      'unknown=1',
      'mode=delivery',
      'dineIn=yes',
      'acceptingNow=yes',
      'limit=0',
      'offset=-1',
    ]) {
      expect(validateShopQuery(new URLSearchParams(query))).toEqual({
        ok: false,
        error: 'invalid_query',
      });
    }
  });
});

describe('Shops envelope', () => {
  it('directory 同型の metadata と ja/en licenseNotice、source freshness を返す', () => {
    const envelope = createShopsEnvelope(
      { limit: 20, offset: 0 },
      { items: [{ name: 'A', mode: 'storefront' }], total: 2 },
      '2026-07-14T00:00:00.000Z',
      [
        { updatedAt: 1_700_000_000_000, pageUrl: 'https://open-pay.jp/@a' },
        { updatedAt: 1_700_000_001_000, pageUrl: 'https://open-pay.jp/@b' },
      ],
    );
    expect(envelope).toMatchObject({
      schemaVersion: '1.0',
      total: 2,
      licenseNotice: SHOPS_LICENSE_NOTICE,
      attribution: ['https://open-pay.jp/@a', 'https://open-pay.jp/@b'],
      dataFreshness: {
        oldestUpdatedAt: '2023-11-14T22:13:20.000Z',
        newestUpdatedAt: '2023-11-14T22:13:21.000Z',
      },
    });
  });
});
