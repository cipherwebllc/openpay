export const DIRECTORY_CATEGORIES = [
  'api',
  'bridge',
  'developer-tool',
  'exchange',
  'network',
  'payment',
  'stablecoin',
  'wallet',
] as const;

export const DIRECTORY_TOKENS = ['jpyc', 'usdc'] as const;

export const DIRECTORY_CHAINS = [
  'arbitrum',
  'avalanche',
  'base',
  'ethereum',
  'kaia',
  'optimism',
  'polygon',
] as const;

export const DIRECTORY_LANGUAGES = ['en', 'ja'] as const;

export const DIRECTORY_STATUSES = [
  'draft',
  'review',
  'published',
  'rejected',
  'archived',
] as const;

export const DIRECTORY_SOURCE_TYPES = ['manual', 'official'] as const;

export type DirectoryCategory = (typeof DIRECTORY_CATEGORIES)[number];
export type DirectoryToken = (typeof DIRECTORY_TOKENS)[number];
export type DirectoryChain = (typeof DIRECTORY_CHAINS)[number];
export type DirectoryLanguage = (typeof DIRECTORY_LANGUAGES)[number];
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];
export type DirectorySourceType = (typeof DIRECTORY_SOURCE_TYPES)[number];

export type DirectoryFacts = {
  /** 一次ソースで確認できる範囲だけを独自の文で要約する。 */
  description: string;
  category: DirectoryCategory;
  tags: readonly string[];
  tokens: readonly DirectoryToken[];
  chains: readonly DirectoryChain[];
  languages: readonly DirectoryLanguage[];
  supportsJpyc: boolean;
  supportsUsdc: boolean;
  supportsX402: boolean;
  supportsMcp: boolean;
};

export type DirectoryEditorial = {
  /** OpenPay が独自作成した紹介文。一次ソース本文の転載・翻案は置かない。 */
  summaryJa: string;
  summaryEn: string;
};

export type DirectoryEntry = {
  slug: string;
  name: string;
  /** 固有の日本語名称が確認できない場合は空文字。 */
  nameJa: string;
  status: DirectoryStatus;
  sourceUrl: string;
  sourceType: DirectorySourceType;
  verifiedAt: string;
  updatedAt: string;
  attribution: string;
  facts: DirectoryFacts;
  editorial: DirectoryEditorial;
};

export type DirectoryQuery = {
  keyword?: string;
  category?: DirectoryCategory;
  token?: DirectoryToken;
  chain?: DirectoryChain;
  language?: DirectoryLanguage;
  supportsJpyc?: boolean;
  supportsUsdc?: boolean;
  supportsX402?: boolean;
  supportsMcp?: boolean;
  status?: DirectoryStatus;
  limit: number;
  offset: number;
};

export type DirectoryEnvelope<TQuery = DirectoryQuery> = {
  schemaVersion: '1.0';
  query: TQuery;
  items: readonly DirectoryEntry[];
  total: number;
  generatedAt: string;
  dataFreshness: {
    oldest: string | null;
    newestVerifiedAt: string | null;
  };
  licenseNotice: string;
  attribution: readonly string[];
};
