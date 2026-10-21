// AI ストアの表示専用: 同じ first-party 商品の JPYC 面と USDC 面 (path が違う双子) を 1 枚のカードにまとめる対応表。
// server (app/[locale]/discovery/page.tsx) が USDC 商品に jpycTwinPath を付けて渡し、client は文字列加工をしない。
// /api/discovery・402・Bazaar・WebMCP の中身は変えない (WebMCP には付ける前の商品を渡す)。

import {
  DIRECTORY_LIST_RESOURCE,
  DIRECTORY_SEARCH_RESOURCE,
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import {
  USDC_DIRECTORY_LIST,
  USDC_DIRECTORY_SEARCH,
  USDC_PAYMENT_MONITOR,
  USDC_SERVICE_MONITOR,
} from '@/lib/directory/usdcResource';
import type { UsdcCatalogItem } from '@/lib/x402/usdcCatalog';
import { USDC_STORES } from '@/lib/x402/usdcStores';

/** USDC 面の path → JPYC 面の path。JPYC 面が登録表 (FIRST_PARTY_RESOURCES) にあることはテストで固定。 */
export const JPYC_TWIN_BY_USDC_PATH: Readonly<Record<string, string>> = {
  [USDC_STORES.path]: '/api/paid/stores',
  [USDC_DIRECTORY_LIST.path]: DIRECTORY_LIST_RESOURCE.path,
  [USDC_DIRECTORY_SEARCH.path]: DIRECTORY_SEARCH_RESOURCE.path,
  [USDC_SERVICE_MONITOR.path]: JPYC_SERVICES_RESOURCE.path,
  [USDC_PAYMENT_MONITOR.path]: JPYC_PAYMENTS_RESOURCE.path,
};

export function withJpycTwins(items: readonly UsdcCatalogItem[]): UsdcCatalogItem[] {
  return items.map((item) => {
    const jpycTwinPath = JPYC_TWIN_BY_USDC_PATH[new URL(item.resource).pathname];
    return jpycTwinPath ? { ...item, jpycTwinPath } : item;
  });
}
