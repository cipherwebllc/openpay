// AI ストア (/discovery) に載せる USDC (Base mainnet・標準 x402) 商品の一覧。
// 各 endpoint の単一情報源 (liveResources / usdcResource / usdcStores) から導出するだけで、
// ここに価格や文言を持たない (ドリフト防止)。JPYC カタログ (/api/discovery・動的) とは別に、
// ページが server 側で静的に渡す。
//
// 発見面: これらは CDP facilitator で settle されているため x402 Bazaar と agentic.market に
// 掲載済み (2026-08-21〜)。カタログ上は「Bazaar で見つかる」印を付ける。

import {
  USDC_DIRECTORY_LIST,
  USDC_DIRECTORY_SEARCH,
  USDC_SERVICE_MONITOR,
} from '@/lib/directory/usdcResource';
import { USDC_JPYC_LIVE_RESOURCES } from '@/lib/jpyc/liveResources';
import { USDC_STORES } from '@/lib/x402/usdcStores';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';

export type UsdcCatalogItem = {
  /** 絶対 URL (カード表示・コピー用)。 */
  resource: string;
  /** 仕事を表す名前 (Bazaar の serviceName と同じ)。 */
  title: string;
  description: string;
  /** USD 文字列 (例 '0.002')。 */
  priceUsd: string;
  category: 'data';
};

/** agentic.market の OpenPay サービスページ (2026-08-24 実ブラウザで描画確認)。 */
export const AGENTIC_MARKET_URL = 'https://agentic.market/services/open-pay-jp';

export const USDC_CATALOG_ITEMS: readonly UsdcCatalogItem[] = [
  ...USDC_JPYC_LIVE_RESOURCES.map((r) => ({
    resource: `${OPENPAY_CANONICAL_ORIGIN}${r.path}`,
    title: r.serviceName,
    description: r.description,
    priceUsd: r.priceUsd,
    category: 'data' as const,
  })),
  {
    resource: `${OPENPAY_CANONICAL_ORIGIN}${USDC_DIRECTORY_LIST.path}`,
    title: 'Japan Web3 Directory',
    description: USDC_DIRECTORY_LIST.description,
    priceUsd: USDC_DIRECTORY_LIST.priceUsd,
    category: 'data',
  },
  {
    resource: `${OPENPAY_CANONICAL_ORIGIN}${USDC_DIRECTORY_SEARCH.path}`,
    title: 'Japan Web3 Directory Search',
    description: USDC_DIRECTORY_SEARCH.description,
    priceUsd: USDC_DIRECTORY_SEARCH.priceUsd,
    category: 'data',
  },
  {
    resource: `${OPENPAY_CANONICAL_ORIGIN}${USDC_SERVICE_MONITOR.path}`,
    title: 'JPYC Service Monitor',
    description: USDC_SERVICE_MONITOR.description,
    priceUsd: USDC_SERVICE_MONITOR.priceUsd,
    category: 'data',
  },
  {
    resource: `${OPENPAY_CANONICAL_ORIGIN}${USDC_STORES.path}`,
    title: 'JPYC Acceptance Directory',
    description: USDC_STORES.description,
    priceUsd: USDC_STORES.priceUsd,
    category: 'data',
  },
];
