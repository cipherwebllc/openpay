// AI ストアに載せる USDC 商品一覧 (lib/x402/usdcCatalog) のフェンス。
// 価格・文言はここに持たず各 endpoint の単一情報源から導出する — その前提を固定する。

import { describe, it, expect } from 'vitest';
import { AGENTIC_MARKET_URL, USDC_CATALOG_ITEMS } from '@/lib/x402/usdcCatalog';
import { USDC_JPYC_LIVE_RESOURCES } from '@/lib/jpyc/liveResources';
import { USDC_DIRECTORY_LIST, USDC_DIRECTORY_SEARCH, USDC_PAYMENT_MONITOR, USDC_SERVICE_MONITOR } from '@/lib/directory/usdcResource';
import { USDC_STORES } from '@/lib/x402/usdcStores';

describe('USDC_CATALOG_ITEMS', () => {
  it('resource は一意で canonical origin の絶対 URL', () => {
    const urls = USDC_CATALOG_ITEMS.map((i) => i.resource);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) expect(u).toMatch(/^https:\/\/open-pay\.jp\/api\/paid\/usdc\//);
  });

  it('価格・文言は各 endpoint の単一情報源と一致する (ドリフト防止)', () => {
    const byPath = new Map(USDC_CATALOG_ITEMS.map((i) => [new URL(i.resource).pathname, i]));
    for (const r of USDC_JPYC_LIVE_RESOURCES) {
      const item = byPath.get(r.path)!;
      expect(item, r.path).toBeDefined();
      expect(item.priceUsd).toBe(r.priceUsd);
      expect(item.title).toBe(r.serviceName);
      expect(item.description).toBe(r.description);
    }
    for (const r of [USDC_DIRECTORY_LIST, USDC_DIRECTORY_SEARCH, USDC_SERVICE_MONITOR, USDC_PAYMENT_MONITOR, USDC_STORES]) {
      const item = byPath.get(r.path)!;
      expect(item, r.path).toBeDefined();
      expect(item.priceUsd).toBe(r.priceUsd);
      expect(item.description).toBe(r.description);
    }
    expect(USDC_CATALOG_ITEMS).toHaveLength(USDC_JPYC_LIVE_RESOURCES.length + 5);
  });

  it('agentic.market のリンクは OpenPay のサービスページ (検索 API ではなく Web ページ)', () => {
    expect(AGENTIC_MARKET_URL).toBe('https://agentic.market/services/open-pay-jp');
  });
});
