// USDC (Base mainnet) で販売する Japan Web3 Directory リソースの単一情報源。
// route (app/api/paid/usdc/japan-web3-directory) と /openapi.json が共用する。
//
// JPYC 版 (/api/paid/japan-web3-directory・forwarder-split・自前 facilitator) とは**別 money-path**:
// こちらは vanilla x402 (x402-next + 外部 facilitator) の直接販売で、OpenPay 手数料は存在せず
// 表示価格の 100% が payTo に届く。x402scan (Base/USDC のみ index・Polygon 拒否を 2026-07-28 実測)
// への掲載面として新設した。
//
// 価格 $0.02 の根拠: JPYC 版の買い手総額 (2 JPYC + facilitator 手数料 1 JPYC = 3 JPYC ≈ ¥3) と
// 概ね等価。同じデータを通貨面で安売り/高売りしない。

export const USDC_DIRECTORY_LIST = {
  path: '/api/paid/usdc/japan-web3-directory',
  /** x402-next の Money 形式 (USD 表記・base network では USDC 6 桁 atomic へ変換される)。 */
  price: '$0.02',
  /** openapi の x-payment-info (機械可読) 用の数値文字列。price と一致させること。 */
  priceUsd: '0.02',
  // 掲載面 (CDP Bazaar / agentic.market) のカード文言 = この description (2026-08-20 実測)。
  // 差別化は「出典 URL + 最終検証日つき」= web 検索で代替できない点なので必ず残す。
  description:
    "Japan Web3 Directory, full export: sourced records on Japan's JPYC/USDC, exchange, wallet and AI-agent services — every row carries an official source URL and last-verified date.",
} as const;

// 検索版。価格は一覧と同じ (JPYC 版も一覧/検索とも 2 JPYC で同額)。
export const USDC_DIRECTORY_SEARCH = {
  path: '/api/paid/usdc/japan-web3-directory/search',
  price: '$0.02',
  priceUsd: '0.02',
  description:
    "Filter the Japan Web3 Directory by category, token, chain or capability — the same sourced, date-stamped records as the full export, without pulling rows your agent doesn't need.",
} as const;

/** 応答 1 行の例 (実データ jpyc-ex を短縮)。一覧と検索で共用。 */
const DIRECTORY_ROW_EXAMPLE = {
  slug: 'jpyc-ex',
  name: 'JPYC EX',
  nameJa: 'JPYC EX',
  status: 'published',
  sourceUrl: 'https://jpyc.co.jp/',
  sourceType: 'official',
  verifiedAt: '2026-07-13',
  facts: {
    category: 'exchange',
    tags: ['Japan', 'issuance', 'redemption'],
    tokens: ['jpyc'],
    chains: ['avalanche', 'ethereum', 'polygon'],
    supportsJpyc: true,
    supportsUsdc: false,
    supportsX402: false,
    supportsMcp: false,
  },
  editorial: {
    summaryEn: 'The official starting point for JPYC issuance and redemption.',
  },
  sourceCheckedAt: '2026-08-20T01:27:11.803Z',
  sourceOk: true,
} as const;

const DIRECTORY_ENVELOPE_EXAMPLE = {
  schemaVersion: '1.0',
  query: { limit: 20, offset: 0 },
  items: [DIRECTORY_ROW_EXAMPLE],
  total: 19,
  generatedAt: '2026-08-21T00:32:38.608Z',
} as const;

/**
 * CDP Bazaar / agentic.market 向け宣言。**引数は lib/directory/query.ts の QUERY_KEYS と
 * 許容値 (types.ts の enum) に一致させる** — ここが実装とずれるとエージェントが 400 を踏む。
 * 売れている検索系は全て schema に引数がある (2026-08-21 カタログ集計)。
 */
export const USDC_DIRECTORY_SEARCH_BAZAAR = {
  queryParams: { category: 'exchange', token: 'jpyc', chain: 'polygon', limit: '20' },
  queryParamsSchema: {
    properties: {
      keyword: { type: 'string', maxLength: 100, description: 'Free-text match on name/summary' },
      category: {
        type: 'string',
        enum: ['api', 'bridge', 'developer-tool', 'exchange', 'network', 'payment', 'stablecoin', 'wallet'],
      },
      token: { type: 'string', enum: ['jpyc', 'usdc'] },
      chain: {
        type: 'string',
        enum: ['arbitrum', 'avalanche', 'base', 'ethereum', 'kaia', 'optimism', 'polygon'],
      },
      language: { type: 'string', enum: ['en', 'ja'] },
      supportsJpyc: { type: 'string', enum: ['true', 'false'] },
      supportsUsdc: { type: 'string', enum: ['true', 'false'] },
      supportsX402: { type: 'string', enum: ['true', 'false'] },
      supportsMcp: { type: 'string', enum: ['true', 'false'] },
      limit: { type: 'string', description: '1-50 (default 20)' },
      offset: { type: 'string', description: '0-1000 (default 0)' },
    },
    additionalProperties: false,
  },
  output: { example: DIRECTORY_ENVELOPE_EXAMPLE },
} as const;

export const USDC_DIRECTORY_LIST_BAZAAR = {
  output: { example: DIRECTORY_ENVELOPE_EXAMPLE },
} as const;

// ── JPYC Service Monitor (更新型・USDC 面) ─────────────────────────────────
// 静的一覧でなく「変更の差分」を売る週次購読型 (2026-08-27 裁定)。JPYC 版
// /api/paid/jpyc/services と同一データ・同一契約 (lib/directory/serviceMonitor.ts)。
// 価格 $0.01: 週 1 の反復購入前提で directory 全件 ($0.02) より安く、hello 級の
// マイクロ価格。説明は 480 字以内 (CDP 上限・#396 フェンスと同じ制約を目視で守る)。
export const USDC_SERVICE_MONITOR = {
  path: '/api/paid/usdc/jpyc/services',
  price: '$0.01',
  priceUsd: '0.01',
  description:
    'JPYC Service Monitor: weekly change feed for Japan-related JPYC and Web3 services. Each event is dated, typed (added / updated / removed / verified) and tied to an official source URL. Call with changedSince=YYYY-MM-DD set to your last run date to fetch only what changed; an empty changes list explicitly means no change, so a scheduled agent can report that without guessing. Without changedSince you get the full monitor snapshot.',
} as const;

const SERVICE_MONITOR_DELTA_EXAMPLE = {
  schemaVersion: '1.0',
  mode: 'delta',
  query: { changedSince: '2026-08-20', limit: 200 },
  services: [
    {
      slug: 'jpyc-ex',
      name: 'JPYC EX',
      nameJa: 'JPYC EX',
      status: 'published',
      category: 'exchange',
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      chains: ['avalanche', 'ethereum', 'kaia', 'polygon'],
      sourceUrl: 'https://jpyc.co.jp/',
      verifiedAt: '2026-08-27',
      sourceCheckedAt: '2026-08-27T01:00:00.000Z',
      sourceOk: true,
    },
  ],
  changes: [
    {
      date: '2026-08-27',
      slug: 'jpyc-ex',
      changeType: 'updated',
      summary:
        'JPYC EX added Kaia support and changed the issuance cap from 1M JPY per day to 1M JPY per transaction.',
      summaryJa: 'JPYC EX が Kaia に対応。発行上限を「1日100万円」から「1回100万円」へ変更。',
      sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000315.000054018.html',
      diffs: [
        {
          field: 'chains',
          previousValue: ['avalanche', 'ethereum', 'polygon'],
          currentValue: ['avalanche', 'ethereum', 'polygon', 'kaia'],
        },
        {
          field: 'limit',
          previousValue: '1,000,000 JPY per day (issuance)',
          currentValue: '1,000,000 JPY per transaction (issuance)',
        },
      ],
    },
  ],
  totalServices: 20,
  generatedAt: '2026-08-27T01:23:45.000Z',
  nextChangedSince: '2026-08-27',
  notice: {
    code: 'sourced-facts-only',
    detail:
      'Change events and rows summarize what official sources state; they are not availability guarantees or endorsements.',
    termsUrl: 'https://open-pay.jp/en/terms',
  },
  licenseNotice: 'Facts summarized from official sources; source rights remain with their owners.',
  attribution: ['JPYC株式会社'],
} as const;

export const USDC_SERVICE_MONITOR_BAZAAR = {
  queryParams: { changedSince: '2026-08-20' },
  queryParamsSchema: {
    properties: {
      changedSince: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description:
          'Return only changes on/after this date (YYYY-MM-DD). Set to your last run date. Omit for the full snapshot.',
      },
      limit: { type: 'string', description: '1-200 (default 200)' },
    },
    additionalProperties: false,
  },
  output: { example: SERVICE_MONITOR_DELTA_EXAMPLE },
} as const;

// ── Japan Stablecoin Payment Monitor (2 商品目・USDC 面) ─────────────────────
// 共通 changelog の 'stablecoin-payments' スコープ (lib/directory/paymentMonitor.ts)。
// 「日本の決済事業者・手数料・対応レールを監視する」という Service Monitor とは別の仕事。
export const USDC_PAYMENT_MONITOR = {
  path: '/api/paid/usdc/stablecoin-payments',
  price: '$0.01',
  priceUsd: '0.01',
  description:
    'Japan Stablecoin Payment Monitor: weekly change feed for stablecoin payment services in Japan — new launches, pilots, partnerships, fee changes, supported assets and chains, and closures. Each event is dated, categorized and tied to an official source URL. Pass changedSince=YYYY-MM-DD (your last run date) to fetch only new events; an empty changes list explicitly means no change. Without changedSince you get the full dated history back to late 2025.',
} as const;

const PAYMENT_MONITOR_DELTA_EXAMPLE = {
  schemaVersion: '1.0',
  mode: 'delta',
  query: { changedSince: '2026-08-01', limit: 200 },
  providers: [
    {
      provider: 'DG Stablecoin Payment Service',
      slug: 'dg-sps',
      stage: 'commercial',
      assets: ['USDC'],
      chains: ['base'],
      settlementCurrency: null,
      merchantFee: null,
      integrations: ['api'],
      posIntegration: null,
      region: 'Japan',
      announcedAt: '2026-08-10',
      startedAt: '2026-08-10',
      plannedPeriod: null,
      sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
      verifiedAt: '2026-08-27',
      lastEventDate: '2026-08-10',
    },
  ],
  totalProviders: 7,
  changes: [
    {
      date: '2026-08-10',
      provider: 'DG Stablecoin Payment Service',
      changeType: 'added',
      changeCategory: 'service_launch',
      assets: ['USDC'],
      chains: ['base'],
      summary:
        'Digital Garage started commercial rollout of DG Stablecoin Payment Service (API-based merchant integration; initially USDC on Base, first offered to JCB and DGFT).',
      summaryJa:
        'デジタルガレージが DG Stablecoin Payment Service の商用展開を開始 (API 接続の加盟店向け・当初は Base 上の USDC・JCB/DGFT へ先行提供)。',
      sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
      diffs: [{ field: 'status', previousValue: null, currentValue: 'commercial' }],
    },
  ],
  totalEvents: 7,
  generatedAt: '2026-08-27T02:00:00.000Z',
  nextChangedSince: '2026-08-27',
  notice: {
    code: 'sourced-facts-only',
    detail:
      'Events summarize official announcements about stablecoin payment services in Japan; verify with each sourceUrl before relying on a change.',
    termsUrl: 'https://open-pay.jp/en/terms',
  },
  licenseNotice:
    'Events summarize what official sources state; they are not availability guarantees or endorsements. Source rights remain with their owners.',
} as const;

export const USDC_PAYMENT_MONITOR_BAZAAR = {
  queryParams: { changedSince: '2026-08-01' },
  queryParamsSchema: {
    properties: {
      changedSince: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description:
          'Return only events on/after this date (YYYY-MM-DD). Set to your last run date. Omit for the full history.',
      },
      limit: { type: 'string', description: '1-200 (default 200)' },
    },
    additionalProperties: false,
  },
  output: { example: PAYMENT_MONITOR_DELTA_EXAMPLE },
} as const;
