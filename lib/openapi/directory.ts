// Japan Web3 Directory (無料 teaser と JPYC / USDC の有料一覧・検索・1 件) の operation。
// 基底文書 (lib/openapi/document.ts の OPENAPI_DOCUMENT) の paths そのもの。

import {
  DIRECTORY_DETAIL_PRICE_JPYC,
  DIRECTORY_LIST_RESOURCE,
  DIRECTORY_SEARCH_RESOURCE,
} from '@/lib/directory/paidResources';
import {
  USDC_DIRECTORY_LICENSED,
  USDC_DIRECTORY_LIST,
  USDC_DIRECTORY_SEARCH,
} from '@/lib/directory/usdcResource';
import { paymentInfo, usdcPaymentChains, usdcPaymentInfo } from '@/lib/openapi/payment';
import { ERROR_RESPONSES, PAID_RESPONSES } from '@/lib/openapi/schema';

const DIRECTORY_QUERY_PARAMETERS = [
  {
    name: 'keyword',
    in: 'query',
    schema: { type: 'string', maxLength: 100 },
  },
  {
    name: 'category',
    in: 'query',
    schema: {
      type: 'string',
      enum: [
        'api',
        'bridge',
        'developer-tool',
        'exchange',
        'network',
        'payment',
        'stablecoin',
        'wallet',
      ],
    },
  },
  { name: 'token', in: 'query', schema: { type: 'string', enum: ['jpyc', 'usdc'] } },
  {
    name: 'chain',
    in: 'query',
    schema: {
      type: 'string',
      enum: [
        'arbitrum',
        'avalanche',
        'base',
        'ethereum',
        'kaia',
        'optimism',
        'polygon',
      ],
    },
  },
  { name: 'language', in: 'query', schema: { type: 'string', enum: ['en', 'ja'] } },
  { name: 'supportsJpyc', in: 'query', schema: { type: 'boolean' } },
  { name: 'supportsUsdc', in: 'query', schema: { type: 'boolean' } },
  { name: 'supportsX402', in: 'query', schema: { type: 'boolean' } },
  { name: 'supportsMcp', in: 'query', schema: { type: 'boolean' } },
  {
    name: 'status',
    in: 'query',
    description: 'Only published entries can be returned, regardless of this filter.',
    schema: {
      type: 'string',
      enum: ['draft', 'review', 'published', 'rejected', 'archived'],
    },
  },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 1000 } },
] as const;

export const DIRECTORY_OPENAPI_PATHS = {
  '/api/directory': {
    get: {
      tags: ['Directory Free'],
      summary: 'Get a free directory teaser',
      description:
        'Returns full entry fields but forces limit to at most 5 and offset to 0 (any provided offset is ignored).',
      parameters: DIRECTORY_QUERY_PARAMETERS,
      responses: {
        '200': {
          description: 'Published directory entries',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryEnvelope' },
              example: {
                schemaVersion: '1.0',
                query: { limit: 5, offset: 0 },
                items: [
                  {
                    slug: 'jpyc',
                    name: 'JPYC',
                    nameJa: 'JPYC',
                    status: 'published',
                    sourceUrl:
                      'https://corporate.jpyc.co.jp/news/posts/jpyc-ex-launch',
                    sourceType: 'official',
                    verifiedAt: '2026-07-13',
                    sourceCheckedAt: '2026-07-14T00:00:00.000Z',
                    sourceOk: true,
                    updatedAt: '2026-07-13',
                    attribution: 'JPYC株式会社',
                    facts: {
                      description: 'A source-verified factual summary.',
                      category: 'stablecoin',
                      tags: ['Japan', 'JPY', 'stablecoin'],
                      tokens: ['jpyc'],
                      chains: ['avalanche', 'ethereum', 'polygon'],
                      languages: ['ja'],
                      supportsJpyc: true,
                      supportsUsdc: false,
                      supportsX402: false,
                      supportsMcp: false,
                    },
                    editorial: {
                      summaryJa: 'OpenPayが独自作成した紹介文です。',
                      summaryEn: 'An original editorial summary written by OpenPay.',
                    },
                  },
                ],
                total: 19,
                generatedAt: '2026-07-13T00:00:00.000Z',
                dataFreshness: {
                  oldest: '2026-07-13',
                  newestVerifiedAt: '2026-07-13',
                  oldestSourceCheckedAt: '2026-07-14T00:00:00.000Z',
                },
                licenseNotice:
                  'Directory metadata is informational; sourceOk is reachability only, not whether the information is true.',
                attribution: ['JPYC株式会社'],
              },
            },
          },
        },
        ...ERROR_RESPONSES,
      },
    },
  },
  '/api/directory/categories': {
    get: {
      tags: ['Directory Free'],
      summary: 'List published category counts',
      responses: {
        '200': {
          description: 'Category counts',
          content: {
            'application/json': {
              example: {
                schemaVersion: '1.0',
                items: [{ category: 'wallet', count: 3 }],
                total: 1,
                generatedAt: '2026-07-13T00:00:00.000Z',
              },
            },
          },
        },
        '404': ERROR_RESPONSES['404'],
        '429': ERROR_RESPONSES['429'],
      },
    },
  },
  '/api/directory/tags': {
    get: {
      tags: ['Directory Free'],
      summary: 'List published tag counts',
      responses: {
        '200': {
          description: 'Tag counts',
          content: {
            'application/json': {
              example: {
                schemaVersion: '1.0',
                items: [{ tag: 'x402', count: 6 }],
                total: 1,
                generatedAt: '2026-07-13T00:00:00.000Z',
              },
            },
          },
        },
        '404': ERROR_RESPONSES['404'],
        '429': ERROR_RESPONSES['429'],
      },
    },
  },
  '/api/paid/japan-web3-directory': {
    get: {
      tags: ['Directory Paid'],
      summary: 'Unlock the full published directory',
      'x-payment-info': paymentInfo(DIRECTORY_LIST_RESOURCE.priceJpyc),
      'x-price-jpyc': Number(DIRECTORY_LIST_RESOURCE.priceJpyc),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'JPYC',
      'x-payment-chains': ['Polygon', 'Polygon Amoy'],
      responses: {
        '200': {
          description: 'Full published directory after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryEnvelope' },
            },
          },
        },
        ...PAID_RESPONSES,
      },
    },
  },
  '/api/paid/japan-web3-directory/search': {
    get: {
      tags: ['Directory Paid'],
      summary: 'Search and unlock published directory results',
      parameters: DIRECTORY_QUERY_PARAMETERS,
      'x-payment-info': paymentInfo(DIRECTORY_SEARCH_RESOURCE.priceJpyc),
      'x-price-jpyc': Number(DIRECTORY_SEARCH_RESOURCE.priceJpyc),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'JPYC',
      'x-payment-chains': ['Polygon', 'Polygon Amoy'],
      responses: {
        '200': {
          description: 'Filtered directory envelope after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryEnvelope' },
            },
          },
        },
        '400': ERROR_RESPONSES['400'],
        ...PAID_RESPONSES,
      },
    },
  },
  [USDC_DIRECTORY_LIST.path]: {
    get: {
      tags: ['Directory Paid'],
      summary: 'Unlock the full published directory (USDC on Base)',
      description:
        'Same data as /api/paid/japan-web3-directory, sold via standard x402 (exact scheme) in USDC on Base mainnet through an external facilitator. No OpenPay fee is added; the listed price is the full charge.',
      'x-payment-info': usdcPaymentInfo(USDC_DIRECTORY_LIST.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Full published directory after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryEnvelope' },
            },
          },
        },
        '402': {
          description:
            'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
        },
        '404': { $ref: '#/components/responses/NotFound' },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
  [USDC_DIRECTORY_LICENSED.path]: {
    get: {
      tags: ['Directory Paid'],
      summary: USDC_DIRECTORY_LICENSED.serviceName,
      description: USDC_DIRECTORY_LICENSED.description,
      'x-payment-info': usdcPaymentInfo(USDC_DIRECTORY_LICENSED.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Full published directory after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryLicensedEnvelope' },
            },
          },
        },
        '402': {
          description:
            'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
        },
        '404': { $ref: '#/components/responses/NotFound' },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
  [USDC_DIRECTORY_SEARCH.path]: {
    get: {
      tags: ['Directory Paid'],
      summary: 'Search the published directory (USDC on Base)',
      description:
        'Same filters as /api/paid/japan-web3-directory/search, sold via standard x402 (exact scheme) in USDC on Base mainnet through an external facilitator. No OpenPay fee is added; the listed price is the full charge.',
      parameters: DIRECTORY_QUERY_PARAMETERS,
      'x-payment-info': usdcPaymentInfo(USDC_DIRECTORY_SEARCH.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Filtered directory envelope after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryEnvelope' },
            },
          },
        },
        '400': { $ref: '#/components/responses/InvalidQuery' },
        '402': {
          description:
            'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
        },
        '404': { $ref: '#/components/responses/NotFound' },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
  '/api/paid/japan-web3-directory/{slug}': {
    get: {
      tags: ['Directory Paid'],
      summary: 'Unlock one published directory entry',
      description:
        'Unknown or non-published slugs return 404 before any payment challenge or settlement.',
      parameters: [
        {
          name: 'slug',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      // x-payment-info を意図的に付けない: この path は slug テンプレートなので、外部
      // インデクサが登録すると `{slug}` を実 URL として probe し必ず 404 になる。有料
      // カタログに載せるのは固定 URL の一覧/検索だけ (FIRST_PARTY_RESOURCES と同じ判断)。
      'x-price-jpyc': Number(DIRECTORY_DETAIL_PRICE_JPYC),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'JPYC',
      'x-payment-chains': ['Polygon', 'Polygon Amoy'],
      responses: {
        '200': {
          description: 'One-entry directory envelope after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DirectoryEnvelope' },
            },
          },
        },
        ...PAID_RESPONSES,
      },
    },
  },
} as const;
