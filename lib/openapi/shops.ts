// JPYC Shops API (無料 teaser / find と有料 search) の operation と schema。
// 掲載は shopsApiEnabled() に連動する (lib/openapi/document.ts の buildOpenApiDocument)。

import { JPYC_SHOPS_SEARCH_RESOURCE } from '@/lib/shops/paidResources';
import { paymentInfo } from '@/lib/openapi/payment';

const SHOPS_QUERY_PARAMETERS = [
  {
    name: 'q',
    in: 'query',
    description: 'Case-insensitive partial match against name, tagline, or address.',
    schema: { type: 'string', maxLength: 100 },
  },
  {
    name: 'mode',
    in: 'query',
    schema: { type: 'string', enum: ['storefront', 'preorder'] },
  },
  { name: 'dineIn', in: 'query', schema: { type: 'boolean' } },
  {
    name: 'acceptingNow',
    in: 'query',
    description:
      'When true, only definitely accepting shops are returned; indeterminate null values are excluded.',
    schema: { type: 'boolean' },
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
  },
  {
    name: 'offset',
    in: 'query',
    schema: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
  },
] as const;

const SHOPS_FIND_QUERY_PARAMETERS = [
  {
    name: 'q',
    in: 'query',
    description: 'Case-insensitive partial match against the shop name only.',
    schema: { type: 'string', maxLength: 100 },
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 10, default: 10 },
  },
] as const;

export const SHOPS_OPENAPI_PATHS = {
  '/api/shops': {
    get: {
      tags: ['Shops Free'],
      summary: 'Get the opt-in shop count and three fixed samples',
      description:
        'The first three index entries are returned deterministically with name and mode only.',
      responses: {
        '200': {
          description: 'Shop teaser envelope',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ShopsTeaserEnvelope' },
            },
          },
        },
        '404': { $ref: '#/components/responses/NotFound' },
        '429': { $ref: '#/components/responses/RateLimited' },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
  '/api/shops/find': {
    get: {
      tags: ['Shops Free'],
      summary: 'Find opt-in shops by name without payment',
      description:
        'Returns handle, name, mode, and three-valued acceptingNow only. Address, hours, menu summary, dine-in filters, and live details remain in the paid search.',
      parameters: SHOPS_FIND_QUERY_PARAMETERS,
      responses: {
        '200': {
          description: 'Free shop discovery envelope',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ShopsFindEnvelope' },
            },
          },
        },
        '400': { $ref: '#/components/responses/InvalidQuery' },
        '404': { $ref: '#/components/responses/NotFound' },
        '429': { $ref: '#/components/responses/RateLimited' },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
  '/api/paid/jpyc-shops/search': {
    get: {
      tags: ['Shops Paid'],
      summary: 'Search opt-in shops and current JPYC ordering availability',
      description:
        'A paid request snapshots the shop index and summaries before x402 verification and settlement. acceptingNow is true when all required checks pass, false for a definite stop condition, and null when live state or required legacy summary data is unavailable. Phone numbers are never returned.',
      parameters: SHOPS_QUERY_PARAMETERS,
      'x-payment-info': paymentInfo(JPYC_SHOPS_SEARCH_RESOURCE.priceJpyc),
      'x-price-jpyc': Number(JPYC_SHOPS_SEARCH_RESOURCE.priceJpyc),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'JPYC',
      'x-payment-chains': ['Polygon', 'Polygon Amoy'],
      responses: {
        '200': {
          description: 'Filtered shop search envelope after settlement',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ShopsSearchEnvelope' },
            },
          },
        },
        '400': { $ref: '#/components/responses/InvalidQuery' },
        '402': { $ref: '#/components/responses/PaymentRequired' },
        '404': { $ref: '#/components/responses/NotFound' },
        '429': { $ref: '#/components/responses/RateLimited' },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
} as const;

export const SHOPS_OPENAPI_SCHEMAS = {
  ShopTeaser: {
    type: 'object',
    required: ['name', 'mode'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      mode: { type: 'string', enum: ['storefront', 'preorder'] },
    },
  },
  ShopFindItem: {
    type: 'object',
    required: ['handle', 'name', 'mode', 'acceptingNow'],
    additionalProperties: false,
    properties: {
      handle: { type: 'string' },
      name: { type: 'string' },
      mode: { type: 'string', enum: ['storefront', 'preorder'] },
      acceptingNow: {
        type: ['boolean', 'null'],
        description:
          'true: definitely accepting; false: a definite stop condition applies; null: live read failed or required legacy data is indeterminate.',
      },
    },
  },
  ShopSearchItem: {
    type: 'object',
    required: [
      'handle',
      'name',
      'mode',
      'dineIn',
      'acceptingNow',
      'menu',
      'chains',
      'pageUrl',
      'menuUrl',
      'live',
    ],
    properties: {
      handle: { type: 'string' },
      name: { type: 'string' },
      tagline: { type: 'string' },
      address: { type: 'string' },
      mode: { type: 'string', enum: ['storefront', 'preorder'] },
      dineIn: { type: 'boolean' },
      acceptingNow: {
        type: ['boolean', 'null'],
        description:
          'true: definitely accepting; false: a definite stop condition applies; null: live read failed or required legacy data is indeterminate.',
      },
      openFrom: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      lastOrder: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      minLeadMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
      menu: {
        type: 'object',
        required: ['itemCount', 'minPrice', 'maxPrice'],
        properties: {
          itemCount: { type: 'integer', minimum: 1, maximum: 60 },
          minPrice: { type: 'string', description: 'JPYC decimal amount' },
          maxPrice: { type: 'string', description: 'JPYC decimal amount' },
        },
      },
      chains: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['polygon', 'kaia', 'avalanche', 'ethereum'],
        },
      },
      pageUrl: { type: 'string', format: 'uri' },
      menuUrl: { type: 'string' },
      live: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['paused', 'soldOutCount', 'updatedAt'],
            properties: {
              paused: { type: 'boolean' },
              soldOutCount: { type: 'integer', minimum: 0 },
              updatedAt: { type: 'integer', minimum: 0 },
            },
          },
        ],
      },
    },
  },
  ShopsTeaserEnvelope: {
    allOf: [
      { $ref: '#/components/schemas/ShopsEnvelopeBase' },
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 3,
            items: { $ref: '#/components/schemas/ShopTeaser' },
          },
        },
      },
    ],
  },
  ShopsFindEnvelope: {
    allOf: [
      { $ref: '#/components/schemas/ShopsEnvelopeBase' },
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 10,
            items: { $ref: '#/components/schemas/ShopFindItem' },
          },
        },
      },
    ],
  },
  ShopsSearchEnvelope: {
    allOf: [
      { $ref: '#/components/schemas/ShopsEnvelopeBase' },
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 20,
            items: { $ref: '#/components/schemas/ShopSearchItem' },
          },
        },
      },
    ],
  },
  ShopsEnvelopeBase: {
    type: 'object',
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
    properties: {
      schemaVersion: { type: 'string', const: '1.0' },
      query: { type: 'object' },
      items: { type: 'array' },
      total: { type: 'integer', minimum: 0 },
      generatedAt: { type: 'string', format: 'date-time' },
      dataFreshness: {
        type: 'object',
        required: ['oldestUpdatedAt', 'newestUpdatedAt'],
        properties: {
          oldestUpdatedAt: { type: ['string', 'null'], format: 'date-time' },
          newestUpdatedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      licenseNotice: {
        type: 'object',
        required: ['ja', 'en'],
        properties: { ja: { type: 'string' }, en: { type: 'string' } },
      },
      attribution: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string' },
      },
    },
  },
} as const;
