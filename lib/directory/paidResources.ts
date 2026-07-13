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
              'Source URL reachability only; it does not establish whether the information is true. null means not yet checked.',
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
  docsUrl: 'https://open-pay.jp/api/openapi.json',
  license: 'Attributed metadata; source rights remain with owners.',
  outputSchema: {
    input: { type: 'http', method: 'GET', discoverable: true },
    output: ENVELOPE_OUTPUT,
  },
} as const satisfies FirstPartyResource;

export function directoryDetailResource(slug: string): FirstPartyResource {
  return {
    path: `/api/paid/japan-web3-directory/${slug}`,
    priceJpyc: '1',
    category: 'data',
    description: `Japan Web3 Directory detail for ${slug} — 1 JPYC.`,
    docsUrl: 'https://open-pay.jp/api/openapi.json',
    license: 'Attributed metadata; source rights remain with owners.',
    outputSchema: {
      input: { type: 'http', method: 'GET', discoverable: true },
      output: ENVELOPE_OUTPUT,
    },
  };
}
