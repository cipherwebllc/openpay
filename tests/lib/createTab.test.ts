// /create のタブ deep-link 解決 (lib/createTab.resolveCreateTab) を実コードで検証。
// 観点: 常設タブ無条件 / flag 付きタブは flag ON のときだけ / 未知・空・flag OFF は既定 'qr'。

import { describe, it, expect } from 'vitest';
import { resolveCreateTab, type CreateTabFlags } from '@/lib/createTab';

const ALL_ON: CreateTabFlags = { mobileOrder: true, ordersFeed: true, handles: true };
const ALL_OFF: CreateTabFlags = { mobileOrder: false, ordersFeed: false, handles: false };

describe('resolveCreateTab', () => {
  it('常設タブ (qr/register/tip) は flag に関係なくそのまま採用', () => {
    for (const tab of ['qr', 'register', 'tip'] as const) {
      expect(resolveCreateTab(tab, ALL_OFF)).toBe(tab);
      expect(resolveCreateTab(tab, ALL_ON)).toBe(tab);
    }
  });

  it('flag 付きタブは対応 flag ON のときだけ採用', () => {
    expect(resolveCreateTab('mobileOrder', ALL_ON)).toBe('mobileOrder');
    expect(resolveCreateTab('orders', ALL_ON)).toBe('orders');
    expect(resolveCreateTab('profile', ALL_ON)).toBe('profile');
  });

  it('flag 付きタブは対応 flag OFF なら既定 qr に落ちる', () => {
    expect(resolveCreateTab('mobileOrder', ALL_OFF)).toBe('qr');
    expect(resolveCreateTab('orders', ALL_OFF)).toBe('qr');
    expect(resolveCreateTab('profile', ALL_OFF)).toBe('qr');
  });

  it('mobileOrder は enableMobileOrder のみで判定 (他 flag に非依存)', () => {
    expect(
      resolveCreateTab('mobileOrder', { mobileOrder: true, ordersFeed: false, handles: false }),
    ).toBe('mobileOrder');
    expect(
      resolveCreateTab('mobileOrder', { mobileOrder: false, ordersFeed: true, handles: true }),
    ).toBe('qr');
  });

  it('orders は ordersFeed (enableOrderRelay || enableShopLive) で判定', () => {
    expect(
      resolveCreateTab('orders', { mobileOrder: false, ordersFeed: true, handles: false }),
    ).toBe('orders');
  });

  it('未知値・空・null・undefined は既定 qr', () => {
    expect(resolveCreateTab('nope', ALL_ON)).toBe('qr');
    expect(resolveCreateTab('', ALL_ON)).toBe('qr');
    expect(resolveCreateTab(null, ALL_ON)).toBe('qr');
    expect(resolveCreateTab(undefined, ALL_ON)).toBe('qr');
  });

  it('大文字・前後空白などの不一致は採用しない (厳密一致)', () => {
    expect(resolveCreateTab('MobileOrder', ALL_ON)).toBe('qr');
    expect(resolveCreateTab(' mobileOrder', ALL_ON)).toBe('qr');
    expect(resolveCreateTab('qr ', ALL_ON)).toBe('qr'); // 末尾空白付き未知値 → 既定 qr
  });
});
