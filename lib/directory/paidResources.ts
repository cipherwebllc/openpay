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
