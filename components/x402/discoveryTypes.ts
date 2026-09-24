// X402DiscoveryView の型 (公開カタログ = DiscoveryItem / CatalogEntry、出品者 = RegisteredResource /
// OwnedResource)。型だけの module なので、どの panel から import しても runtime の依存は増えない。

import type { UsdcCatalogItem } from '@/lib/x402/usdcCatalog';

export type DiscoveryItem = {
  title?: string;
  resource: string;
  description: string;
  /** 「いつ・何のために買うか」(英語・任意)。未設定なら表示しない。 */
  trigger?: string;
  category: string;
  priceJpyc: string;
  docsUrl?: string;
  license?: string;
  updatedAt?: string;
  verifiedAt?: string | null;
  official?: boolean;
  /** dual-rail の USDC/Base 面 (表示用・リレー点灯中のみ server が返す)。 */
  usdc?: { priceUsd: string; serviceName?: string };
  accepts: Array<{ payTo?: string; extra?: { openpay?: { feeValue?: string } } }>;
};

/** カタログの通貨フィルタ。JPYC = /api/discovery (Polygon・facilitator) / USDC = Base・標準 x402。 */
export type CatalogCurrency = 'all' | 'jpyc' | 'usdc';

/** JPYC と USDC を同じ一覧に並べるための共通形。 */
export type CatalogEntry =
  | { kind: 'jpyc'; key: string; category: string; searchText: string; item: DiscoveryItem }
  | { kind: 'usdc'; key: string; category: string; searchText: string; item: UsdcCatalogItem };

export type RegisteredResource = {
  title?: string;
  trigger?: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  docsUrl?: string;
  license?: string;
};

// owner 一覧 (GET /api/facilitator/resources) の要素。編集に id + payTo が要る。
export type OwnedResource = {
  title?: string;
  trigger?: string;
  id: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  payTo: string;
  docsUrl?: string;
  license?: string;
  paywallSnippet?: string;
  hidden?: boolean;
  /** 定期再検証の状態。authFailures は 401/403/別ドメイン転送の連続回数 (欠落 = 0)。 */
  verification?: { authFailures?: number };
  /** dual-rail の USDC/Base 面 (任意)。 */
  usdc?: { payTo: string; priceUsd: string; serviceName?: string };
};
