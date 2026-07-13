import { describe, expect, it } from 'vitest';
import type { ShopLiveState } from '@/lib/shopLive';
import { acceptingNow } from '@/lib/shops/accepting';
import type { ShopSummary } from '@/lib/shops/query';

const NOW = Date.UTC(2026, 6, 14, 1, 0); // Asia/Tokyo 10:00
const LIVE: ShopLiveState = { soldOut: [], paused: false, updatedAt: NOW };

function summary(input: Partial<ShopSummary> = {}): ShopSummary {
  return {
    handle: 'alice',
    name: 'Alice Cafe',
    mode: 'storefront',
    dineIn: false,
    acceptingOrders: true,
    menu: {
      itemCount: 2,
      minPrice: '100',
      maxPrice: '200',
      itemIds: ['a', 'b'],
    },
    chains: ['polygon'],
    updatedAt: NOW,
    ...input,
  };
}

function decide(
  input: Partial<Parameters<typeof acceptingNow>[0]> = {},
) {
  return acceptingNow({
    summary: summary(),
    live: LIVE,
    nowMs: NOW,
    enablePreorderTime: true,
    hasConfiguredForwarder: true,
    ...input,
  });
}

describe('acceptingNow three-state boundaries', () => {
  it('全条件を確認できれば true', () => {
    expect(decide()).toBe(true);
  });

  it('storefront.acceptingOrders=false は live 障害より優先して false', () => {
    expect(
      decide({ summary: summary({ acceptingOrders: false }), live: null }),
    ).toBe(false);
  });

  it('paused / forwarder 未構成 / menu 全品 soldOut は false', () => {
    expect(decide({ live: { ...LIVE, paused: true } })).toBe(false);
    expect(decide({ hasConfiguredForwarder: false })).toBe(false);
    expect(decide({ live: { ...LIVE, soldOut: ['b', 'a', 'stale'] } })).toBe(
      false,
    );
  });

  it('openFrom は直前 false・同時刻 true、lastOrder は同時刻から false', () => {
    expect(decide({ summary: summary({ openFrom: '10:01' }) })).toBe(false);
    expect(decide({ summary: summary({ openFrom: '10:00' }) })).toBe(true);
    expect(decide({ summary: summary({ lastOrder: '10:00' }) })).toBe(false);
    expect(decide({ summary: summary({ lastOrder: '10:01' }) })).toBe(true);
  });

  it('preorder は lead 後の pickup slot が空なら false', () => {
    expect(
      decide({
        summary: summary({
          mode: 'preorder',
          lastOrder: '10:05',
          minLeadMinutes: 15,
        }),
      }),
    ).toBe(false);
  });

  it('preorder time flag OFF は時間条件を適用しない', () => {
    expect(
      decide({
        summary: summary({
          mode: 'preorder',
          openFrom: '11:00',
          lastOrder: '09:00',
        }),
        enablePreorderTime: false,
      }),
    ).toBe(true);
  });

  it('live 読み失敗、旧 summary の静的状態欠落、全品照合不能は null', () => {
    expect(decide({ live: null })).toBeNull();
    expect(decide({ hasConfiguredForwarder: null })).toBeNull();
    expect(decide({ summary: summary({ acceptingOrders: undefined }) })).toBeNull();
    expect(
      decide({
        summary: summary({
          menu: { itemCount: 2, minPrice: '100', maxPrice: '200' },
        }),
        live: { ...LIVE, soldOut: ['a', 'b'] },
      }),
    ).toBeNull();
  });

  it('旧 summary でも soldOut 数が商品数未満なら全品売切ではないと確定', () => {
    expect(
      decide({
        summary: summary({
          menu: { itemCount: 2, minPrice: '100', maxPrice: '200' },
        }),
        live: { ...LIVE, soldOut: ['a'] },
      }),
    ).toBe(true);
  });
});
