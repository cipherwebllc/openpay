import type { FirstPartyResource } from '@/lib/x402/firstParty';

const ENVELOPE_OUTPUT = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    query: { type: 'object' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceCheckedAt: { type: ['string', 'null'], format: 'date-time' },
          sourceOk: {
            type: ['boolean', 'null'],
            description:
              'Source URL reachability only; it does not establish whether the information is true. true = reachable (2xx/3xx), false = confirmed gone (404/410), null = not yet checked or indeterminate.',
          },
        },
        required: ['sourceCheckedAt', 'sourceOk'],
      },
    },
    total: { type: 'integer' },
    generatedAt: { type: 'string' },
    dataFreshness: {
      type: 'object',
      properties: {
        oldestSourceCheckedAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    licenseNotice: {
      type: 'string',
      description:
        'sourceOk reports source URL reachability only, not whether the information is true.',
    },
    attribution: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'schemaVersion',
    'query',
    'items',
    'total',
    'generatedAt',
    'dataFreshness',
    'licenseNotice',
    'attribution',
  ],
};

export const DIRECTORY_LIST_RESOURCE = {
  path: '/api/paid/japan-web3-directory',
  priceJpyc: '2',
  category: 'data',
  description:
    "Curated structured records covering Japan's JPYC, USDC, Web3 and AI-agent ecosystem.",
  trigger:
    'When researching Japanese JPYC / Web3 / AI-agent services and you need sourced, dated records instead of unverifiable web-search results.',
  docsUrl: 'https://open-pay.jp/api/openapi.json',
  license: 'Attributed metadata; source rights remain with owners.',
  outputSchema: {
    input: { type: 'http', method: 'GET', discoverable: true },
    output: ENVELOPE_OUTPUT,
  },
} as const satisfies FirstPartyResource;

export const DIRECTORY_SEARCH_RESOURCE = {
  path: '/api/paid/japan-web3-directory/search',
  priceJpyc: '2',
  category: 'data',
  description:
    'Query published Japan Web3 service records by category, token, chain and capability.',
  trigger:
    'When you need to narrow Japanese Web3 services by category, token, chain or capability, and fetching the full list would waste context.',
  docsUrl: 'https://open-pay.jp/api/openapi.json',
  license: 'Attributed metadata; source rights remain with owners.',
  outputSchema: {
    input: { type: 'http', method: 'GET', discoverable: true },
    output: ENVELOPE_OUTPUT,
  },
} as const satisfies FirstPartyResource;

/** 詳細 1 件の価格。OpenAPI スペックも同じ値を参照する (literal の二重管理を避ける)。 */
export const DIRECTORY_DETAIL_PRICE_JPYC = '1';

export function directoryDetailResource(slug: string): FirstPartyResource {
  return {
    path: `/api/paid/japan-web3-directory/${slug}`,
    priceJpyc: DIRECTORY_DETAIL_PRICE_JPYC,
    category: 'data',
    description: `Japan Web3 Directory detail for ${slug} — 1 JPYC.`,
    trigger: `When you already identified ${slug} and need its full record (sources, capabilities, last verification) before citing it.`,
    docsUrl: 'https://open-pay.jp/api/openapi.json',
    license: 'Attributed metadata; source rights remain with owners.',
    outputSchema: {
      input: { type: 'http', method: 'GET', discoverable: true },
      output: ENVELOPE_OUTPUT,
    },
  };
}

// JPYC Service Monitor (更新型商品・2026-08-27 裁定)。ディレクトリ本体 (全件データ) を
// 売るのではなく「JPYC 対応サービスの追加・変更・終了・再確認」の差分を週次購入で追わせる。
// changedSince で delta を返す契約は lib/directory/serviceMonitor.ts が単一情報源。
const SERVICE_MONITOR_OUTPUT = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['snapshot', 'delta'],
      description:
        'snapshot = full monitor view (no changedSince). delta = only what changed on/after changedSince; changes:[] explicitly means no change.',
    },
    query: { type: 'object' },
    services: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          status: { type: 'string' },
          supportsJpyc: { type: 'boolean' },
          verifiedAt: { type: 'string' },
          sourceCheckedAt: { type: ['string', 'null'], format: 'date-time' },
          sourceOk: { type: ['boolean', 'null'] },
        },
        required: ['slug', 'status', 'supportsJpyc', 'verifiedAt'],
      },
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          slug: { type: 'string', description: 'Present when the event is tied to a directory entry.' },
          provider: {
            type: 'string',
            description: 'Present instead of slug for industry events not tied to a directory entry.',
          },
          changeType: {
            type: 'string',
            enum: ['added', 'updated', 'removed', 'verified'],
          },
          summary: { type: 'string' },
          summaryJa: { type: 'string' },
          diffs: {
            type: 'array',
            description:
              'Value-level diffs, present only when the official source states the before/after values (never inferred).',
            items: {
              type: 'object',
              properties: {
                field: {
                  type: 'string',
                  enum: ['assets', 'chains', 'fee', 'limit', 'status', 'feature'],
                },
                previousValue: {
                  description: 'string, string[] or null (null = no prior value)',
                },
                currentValue: { description: 'string or string[]' },
                effectiveAt: { type: 'string', description: 'YYYY-MM-DD, only when it differs from date' },
              },
              required: ['field', 'previousValue', 'currentValue'],
            },
          },
        },
        required: ['date', 'changeType', 'summary'],
      },
    },
    totalServices: { type: 'integer' },
    generatedAt: { type: 'string' },
    hasMore: {
      type: 'boolean',
      description:
        'True when this response was truncated by limit; more events exist beyond nextChangedSince.',
    },
    nextChangedSince: {
      type: 'string',
      description:
        'Echo this value as changedSince on your next call to fetch only new events (inclusive; duplicates are removed by the documented dedupe key). When hasMore is true, this is the date of the last event in this response (not the response generation time), so the truncated remainder is included on the next call.',
    },
    notice: { type: 'object' },
    licenseNotice: { type: 'string' },
    attribution: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'schemaVersion',
    'mode',
    'query',
    'services',
    'changes',
    'totalServices',
    'generatedAt',
    'hasMore',
    'nextChangedSince',
    'notice',
    'licenseNotice',
    'attribution',
  ],
};

export const JPYC_SERVICES_RESOURCE = {
  path: '/api/paid/jpyc/services',
  priceJpyc: '2',
  category: 'data',
  description:
    'JPYC Service Monitor: weekly change feed for Japan-related JPYC/Web3 services — additions, updates, removals and re-verifications, each dated and tied to an official source URL. Pass changedSince=YYYY-MM-DD to fetch only what changed; an empty changes list explicitly means no change.',
  trigger:
    'On a weekly schedule: pass changedSince set to your last run date to fetch only new changes; report "no significant change" when changes is empty.',
  docsUrl: 'https://open-pay.jp/api/openapi.json',
  license: 'Attributed metadata; source rights remain with owners.',
  outputSchema: {
    input: { type: 'http', method: 'GET', discoverable: true },
    output: SERVICE_MONITOR_OUTPUT,
  },
} as const satisfies FirstPartyResource;

// Japan Stablecoin Payment Monitor (2 商品目・2026-08-27 裁定)。共通 changelog の
// 決済スコープを provider 中心の行で返す。契約は lib/directory/paymentMonitor.ts。
const PAYMENT_MONITOR_OUTPUT = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['snapshot', 'delta'],
      description:
        'snapshot = full dated history (no changedSince). delta = only events on/after changedSince; changes:[] explicitly means no change.',
    },
    query: { type: 'object' },
    providers: {
      type: 'array',
      description:
        'Current state of each monitored provider on a fixed set of fields, re-checked weekly. null = checked but not published by the source (never inferred). snapshot: all providers; delta: only providers that appear in changes.',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          slug: { type: 'string' },
          stage: { type: 'string', enum: ['partnership', 'pilot', 'commercial', 'closed'] },
          assets: { type: 'array', items: { type: 'string' } },
          chains: { type: 'array', items: { type: 'string' } },
          settlementCurrency: { type: ['string', 'null'] },
          merchantFee: { type: ['string', 'null'] },
          integrations: {
            type: 'array',
            items: { type: 'string', enum: ['api', 'in-store', 'ec', 'wallet'] },
          },
          posIntegration: { type: ['boolean', 'null'] },
          region: { type: ['string', 'null'] },
          announcedAt: { type: 'string', description: 'YYYY-MM-DD' },
          startedAt: { type: ['string', 'null'] },
          plannedPeriod: { type: ['string', 'null'], description: 'e.g. 2027-01..2027-03' },
          sourceUrl: { type: 'string' },
          verifiedAt: { type: 'string', description: 'YYYY-MM-DD, last re-check of the source' },
          lastEventDate: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: [
          'provider', 'stage', 'assets', 'chains', 'settlementCurrency', 'merchantFee',
          'integrations', 'posIntegration', 'region', 'announcedAt', 'startedAt',
          'plannedPeriod', 'sourceUrl', 'verifiedAt', 'lastEventDate',
        ],
      },
    },
    totalProviders: { type: 'integer' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (announcement date)' },
          provider: { type: 'string' },
          changeType: {
            type: 'string',
            enum: ['added', 'updated', 'removed', 'verified'],
          },
          changeCategory: {
            type: 'string',
            enum: [
              'service_launch',
              'pilot',
              'partnership',
              'fee_change',
              'assets_change',
              'chains_change',
              'closure',
              'update',
            ],
          },
          assets: { type: 'array', items: { type: 'string' } },
          chains: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          summaryJa: { type: 'string' },
          sourceUrl: { type: 'string' },
          diffs: {
            type: 'array',
            description:
              'Value-level diffs, present only when the official source states the before/after values (never inferred).',
            items: {
              type: 'object',
              properties: {
                field: {
                  type: 'string',
                  enum: ['assets', 'chains', 'fee', 'limit', 'status', 'feature'],
                },
                previousValue: {
                  description: 'string, string[] or null (null = no prior value)',
                },
                currentValue: { description: 'string or string[]' },
                effectiveAt: { type: 'string', description: 'YYYY-MM-DD, only when it differs from date' },
              },
              required: ['field', 'previousValue', 'currentValue'],
            },
          },
        },
        required: ['date', 'provider', 'changeType', 'assets', 'chains', 'summary', 'sourceUrl'],
      },
    },
    totalEvents: { type: 'integer' },
    generatedAt: { type: 'string' },
    hasMore: {
      type: 'boolean',
      description:
        'True when this response was truncated by limit; more events exist beyond nextChangedSince.',
    },
    nextChangedSince: {
      type: 'string',
      description:
        'Echo this value as changedSince on your next call to fetch only new events (inclusive; duplicates are removed by the documented dedupe key). When hasMore is true, this is the date of the last event in this response (not the response generation time), so the truncated remainder is included on the next call.',
    },
    notice: { type: 'object' },
    licenseNotice: { type: 'string' },
  },
  required: [
    'schemaVersion',
    'mode',
    'query',
    'changes',
    'totalEvents',
    'generatedAt',
    'hasMore',
    'nextChangedSince',
    'notice',
    'licenseNotice',
  ],
};

export const JPYC_PAYMENTS_RESOURCE = {
  path: '/api/paid/stablecoin-payments',
  priceJpyc: '2',
  category: 'data',
  description:
    'Japan Stablecoin Payment Monitor: weekly change feed for stablecoin payment services in Japan — new launches, pilots, partnerships, fee changes, supported assets/chains and closures, each dated and tied to an official source URL. Pass changedSince=YYYY-MM-DD to fetch only new events; an empty changes list explicitly means no change.',
  trigger:
    'On a weekly schedule when monitoring Japanese stablecoin payment providers: pass changedSince set to your last run date; report "no significant change" when changes is empty.',
  docsUrl: 'https://open-pay.jp/api/openapi.json',
  license: 'Attributed metadata; source rights remain with owners.',
  outputSchema: {
    input: { type: 'http', method: 'GET', discoverable: true },
    output: PAYMENT_MONITOR_OUTPUT,
  },
} as const satisfies FirstPartyResource;
