// OpenPay の OpenAPI 3.1 スペック (単一情報源)。/openapi.json と /api/openapi.json の
// 両ルートがこれを配信する。root 配信が必要なのは x402 のインデクサ (x402scan /
// @agentcash/discovery) が **origin 直下の /openapi.json しか読まない**ため
// (`.well-known/x402` は legacy 扱いで既にパースされない)。
//
// 有料 operation には `x-payment-info` を付ける。インデクサはこの有無で authMode='paid' を
// 判定し、無いと「有料エンドポイント」として登録されない。金額は 402 チャレンジと同じ
// x402FeeBreakdown から導出する (literal を書くと掟 14 のドリフト源になるため)。

import { env } from '@/lib/env';
import { shopsApiEnabled } from '@/lib/shops/flags';
import {
  DIRECTORY_DETAIL_PRICE_JPYC,
  DIRECTORY_LIST_RESOURCE,
  DIRECTORY_SEARCH_RESOURCE,
} from '@/lib/directory/paidResources';
import { JPYC_SHOPS_SEARCH_RESOURCE } from '@/lib/shops/paidResources';
import {
  USDC_DIRECTORY_LIST,
  USDC_DIRECTORY_SEARCH,
} from '@/lib/directory/usdcResource';
import { USDC_STORES } from '@/lib/x402/usdcStores';
import {
  USDC_JPYC_BALANCE,
  USDC_JPYC_SUPPLY,
  USDC_JPYC_TRANSFERS,
  agentUsageText,
} from '@/lib/jpyc/liveResources';
import { x402Config } from '@/lib/x402/config';
import { usdPriceToAtomic } from '@/lib/x402/vanillaGate';
import { FIRST_PARTY_RESOURCES } from '@/lib/x402/firstParty';
import { x402FeeBreakdown } from '@/lib/x402/fee';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { caip2ForChainId } from '@/lib/x402/network';

const JPYC_WEI = 10n ** 18n;

/** atomic JPYC → 小数文字列 (末尾 0 を落とす)。表示ではなく機械可読面の金額に使う。 */
function formatJpyc(wei: bigint): string {
  const int = wei / JPYC_WEI;
  const frac = wei % JPYC_WEI;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(18, '0').replace(/0+$/, '')}`;
}

/** 価格はカタログ (FIRST_PARTY_RESOURCES) が権威。スペック側に literal を持たない。 */
function firstPartyPrice(path: string): string {
  const resource = FIRST_PARTY_RESOURCES.find((r) => r.path === path);
  if (!resource) {
    throw new Error(`openapi: unknown first-party resource ${path}`);
  }
  return resource.priceJpyc;
}

// JPYC は 1 JPYC = 1 円のペッグなので ISO 4217 の JPY で表現できる。amount は買い手が実際に
// 署名する総額 (資源価格 + 買い手上乗せの facilitator 手数料) = 402 の maxAmountRequired と一致。
function paymentInfo(priceJpyc: string) {
  const { total } = x402FeeBreakdown(BigInt(priceJpyc) * JPYC_WEI);
  return {
    price: { currency: 'JPY', mode: 'fixed', amount: formatJpyc(total) },
    protocols: [
      {
        x402: {
          scheme: 'exact',
          network: caip2ForChainId(x402FacilitatorConfig.chainId),
          asset: 'JPYC',
        },
      },
    ],
  } as const;
}

// vanilla x402 (USDC/Base) 直接販売用。JPYC 版と違い OpenPay 手数料が乗らないため、
// amount は表示価格そのもの。network は本番 (servers = open-pay.jp) の Base mainnet 固定。
function usdcPaymentInfo(amountUsd: string) {
  return {
    price: { currency: 'USD', mode: 'fixed', amount: amountUsd },
    protocols: [
      { x402: { scheme: 'exact', network: 'eip155:8453', asset: 'USDC' } },
    ],
  } as const;
}

// hello (vanilla demo) の価格は X402_PRICE env が権威。Money 文字列でない (polygon 配線) か
// 変換不能なら openapi に載せない (route 側も 503 に縮退するため整合する)。
function helloUsdAmountOrNull(): string | null {
  const price = x402Config.defaultPrice;
  if (typeof price !== 'string') return null;
  try {
    usdPriceToAtomic(price);
  } catch {
    return null;
  }
  return price.replace(/^\$/, '');
}

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

const ERROR_RESPONSES = {
  '400': { $ref: '#/components/responses/InvalidQuery' },
  '404': { $ref: '#/components/responses/NotFound' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '503': { $ref: '#/components/responses/StorageUnavailable' },
} as const;

const PAID_RESPONSES = {
  '402': { $ref: '#/components/responses/PaymentRequired' },
  '404': { $ref: '#/components/responses/NotFound' },
  '503': { $ref: '#/components/responses/StorageUnavailable' },
} as const;

const DISCOVERY_OPENAPI_PATHS = {
  '/api/discovery': {
    get: {
      tags: ['x402 Catalog'],
      summary: 'List payable x402 resources for agent comparison',
      responses: {
        '200': {
          description: 'First-party and registered resources with payable requirements',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DiscoveryEnvelope' },
            },
          },
        },
        '404': { description: 'The x402 facilitator is disabled.' },
        '503': { description: 'The resource catalog is temporarily unavailable.' },
      },
    },
  },
  '/api/paid/demo': {
    get: {
      tags: ['x402 Catalog'],
      summary: 'Unlock a signed hello (x402 end-to-end demo)',
      description:
        'Smallest payable resource. Use it to confirm the 402 challenge, JPYC payment and unlock work end to end before wiring a real paid API.',
      'x-payment-info': paymentInfo(firstPartyPrice('/api/paid/demo')),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'JPYC',
      responses: {
        '200': {
          description: 'Unlock greeting after settlement',
          content: {
            'application/json': {
              example: { message: 'hello', paidAt: '2026-07-28T00:00:00.000Z' },
            },
          },
        },
        ...PAID_RESPONSES,
      },
    },
  },
  '/api/paid/stores': {
    get: {
      tags: ['x402 Catalog'],
      summary: 'Unlock the curated JPYC acceptance directory',
      description:
        'Curated JSON of exchanges, dApps and bridges that accept JPYC, with attribution.',
      'x-payment-info': paymentInfo(firstPartyPrice('/api/paid/stores')),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'JPYC',
      responses: {
        '200': {
          description: 'Curated store list after settlement',
          content: {
            'application/json': {
              example: {
                items: [
                  { name: 'JPYC EX', category: 'exchange', url: 'https://jpyc.jp/' },
                ],
              },
            },
          },
        },
        ...PAID_RESPONSES,
      },
    },
  },
} as const;

const DISCOVERY_OPENAPI_SCHEMAS = {
  DiscoveryItem: {
    type: 'object',
    required: [
      'resource',
      'description',
      'category',
      'priceJpyc',
      'network',
      'accepts',
      'verifiedAt',
    ],
    properties: {
      resource: { type: 'string', format: 'uri' },
      description: { type: 'string' },
      category: { type: 'string' },
      priceJpyc: { type: 'string', pattern: '^[1-9][0-9]*$' },
      docsUrl: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 512 },
      license: { type: 'string', maxLength: 60 },
      updatedAt: { type: 'string', format: 'date-time' },
      official: {
        type: 'boolean',
        const: true,
        description: 'Present only for first-party resources generated by OpenPay.',
      },
      network: { type: 'string', description: 'CAIP-2 network identifier' },
      accepts: {
        type: 'array',
        description: 'Payable x402 requirements including the OpenPay fee extension.',
        items: { type: 'object' },
      },
      verifiedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'Last successful OpenPay gate verification, or null when not yet verified.',
      },
    },
  },
  DiscoveryEnvelope: {
    type: 'object',
    required: ['x402Version', 'items'],
    properties: {
      x402Version: { type: 'integer', const: 1 },
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/DiscoveryItem' },
      },
    },
  },
} as const;

// vanilla x402 (USDC/Base・外部 facilitator・OpenPay 手数料なし) の直接販売面。
// JPYC facilitator の flag に依存しないため、doc が配信される限り常に載せる。
// JPYC オンチェーン・ライブデータ (lib/jpyc/liveResources.ts が SoT・応答例も共用)。
const JPYC_LIVE_402 = {
  description:
    'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
};
const JPYC_LIVE_503 = {
  description:
    'All configured RPC endpoints failed for the requested chains. Nothing is settled; the buyer is not charged.',
};
const JPYC_LIVE_400 = { description: 'Unknown query key, unsupported chain, or malformed address/limit.' };
const JPYC_CHAIN_PARAM = {
  name: 'chain',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: ['polygon', 'kaia', 'avalanche', 'ethereum'] },
  description:
    'Chain to query. Omit to query all supported chains. Supported values: polygon, kaia, avalanche, ethereum.',
  example: 'polygon',
};

const VANILLA_OPENAPI_PATHS = {
  [USDC_JPYC_SUPPLY.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'JPYC Live Data'],
      operationId: USDC_JPYC_SUPPLY.operationId,
      summary: USDC_JPYC_SUPPLY.summary,
      description: `${USDC_JPYC_SUPPLY.description} ${agentUsageText(USDC_JPYC_SUPPLY.trigger)} Payment: standard x402 (exact scheme) in USDC on Base mainnet; no OpenPay fee is added.`,
      parameters: [JPYC_CHAIN_PARAM],
      'x-agent-usage': USDC_JPYC_SUPPLY.trigger,
      'x-payment-info': usdcPaymentInfo(USDC_JPYC_SUPPLY.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': ['Base'],
      responses: {
        '200': {
          description: 'Per-chain totalSupply after settlement (rows with status "error" are RPC failures on that chain only)',
          content: {
            'application/json': {
              schema: USDC_JPYC_SUPPLY.bazaar.output.schema,
              example: USDC_JPYC_SUPPLY.bazaar.output.example,
            },
          },
        },
        '400': JPYC_LIVE_400,
        '402': JPYC_LIVE_402,
        '503': JPYC_LIVE_503,
      },
    },
  },
  [USDC_JPYC_BALANCE.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'JPYC Live Data'],
      operationId: USDC_JPYC_BALANCE.operationId,
      summary: USDC_JPYC_BALANCE.summary,
      description: `${USDC_JPYC_BALANCE.description} ${agentUsageText(USDC_JPYC_BALANCE.trigger)} Payment: standard x402 (exact scheme) in USDC on Base mainnet; no OpenPay fee is added.`,
      parameters: [
        {
          name: 'address',
          in: 'query',
          required: true,
          schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
          description: 'EVM address to read the JPYC balance of.',
          example: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
        },
        JPYC_CHAIN_PARAM,
      ],
      'x-agent-usage': USDC_JPYC_BALANCE.trigger,
      'x-payment-info': usdcPaymentInfo(USDC_JPYC_BALANCE.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': ['Base'],
      responses: {
        '200': {
          description: 'Per-chain balance after settlement',
          content: {
            'application/json': {
              schema: USDC_JPYC_BALANCE.bazaar.output.schema,
              example: USDC_JPYC_BALANCE.bazaar.output.example,
            },
          },
        },
        '400': JPYC_LIVE_400,
        '402': JPYC_LIVE_402,
        '503': JPYC_LIVE_503,
      },
    },
  },
  [USDC_JPYC_TRANSFERS.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'JPYC Live Data'],
      operationId: USDC_JPYC_TRANSFERS.operationId,
      summary: USDC_JPYC_TRANSFERS.summary,
      description: `${USDC_JPYC_TRANSFERS.description} The block window is fixed per chain (about one hour) to bound RPC cost. ${agentUsageText(USDC_JPYC_TRANSFERS.trigger)} Payment: standard x402 (exact scheme) in USDC on Base mainnet; no OpenPay fee is added.`,
      parameters: [
        {
          ...JPYC_CHAIN_PARAM,
          required: true,
          description: 'Chain to scan. Supported values: polygon, kaia, avalanche, ethereum.',
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          description:
            'Maximum number of transfer events to return, newest first (1-100, default 20). This is not a page number.',
          example: 20,
        },
        {
          name: 'address',
          in: 'query',
          required: false,
          schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
          description: 'Only transfers where this address is the sender or the recipient.',
        },
      ],
      'x-agent-usage': USDC_JPYC_TRANSFERS.trigger,
      'x-payment-info': usdcPaymentInfo(USDC_JPYC_TRANSFERS.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': ['Base'],
      responses: {
        '200': {
          description: 'Newest-first Transfer events within the block window after settlement',
          content: {
            'application/json': {
              schema: USDC_JPYC_TRANSFERS.bazaar.output.schema,
              example: USDC_JPYC_TRANSFERS.bazaar.output.example,
            },
          },
        },
        '400': JPYC_LIVE_400,
        '402': JPYC_LIVE_402,
        '503': JPYC_LIVE_503,
      },
    },
  },
  [USDC_STORES.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)'],
      summary: 'Unlock the curated JPYC acceptance directory (USDC on Base)',
      description:
        'Same data as /api/paid/stores, sold via standard x402 (exact scheme) in USDC on Base mainnet through an external facilitator. No OpenPay fee is added; the listed price is the full charge.',
      'x-payment-info': usdcPaymentInfo(USDC_STORES.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': ['Base'],
      responses: {
        '200': {
          description: 'Curated store list after settlement',
          content: {
            'application/json': {
              example: {
                items: [
                  { name: 'JPYC EX', category: 'exchange', url: 'https://jpyc.jp/' },
                ],
              },
            },
          },
        },
        '402': {
          description:
            'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
        },
        '503': { $ref: '#/components/responses/StorageUnavailable' },
      },
    },
  },
} as const;

// hello は価格が env (X402_PRICE) 由来のため、有効な USD 価格のときだけ載せる。
function vanillaHelloPath(): Record<string, unknown> {
  const amount = helloUsdAmountOrNull();
  if (amount === null) return {};
  return {
    '/api/paid/hello': {
      get: {
        tags: ['x402 Vanilla (USDC)'],
        summary: 'Paid hello demo (USDC on Base)',
        description:
          'Smallest standard-x402 payable resource: pay and unlock a hello + timestamp. Use it to confirm the 402 → pay → unlock flow end to end before wiring a real paid API.',
        'x-payment-info': usdcPaymentInfo(amount),
        'x-payment-protocol': 'x402',
        'x-payment-asset': 'USDC',
        'x-payment-chains': ['Base'],
        responses: {
          '200': {
            description: 'Hello + timestamp after settlement',
            content: {
              'application/json': {
                example: {
                  message: 'Hello, paid AI agent.',
                  timestamp: '2026-07-28T00:00:00.000Z',
                },
              },
            },
          },
          '402': {
            description:
              'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
          },
          '503': { $ref: '#/components/responses/StorageUnavailable' },
        },
      },
    },
  };
}

const SHOPS_OPENAPI_PATHS = {
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
      'x-price-jpyc': 2,
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

const SHOPS_OPENAPI_SCHEMAS = {
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

const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'OpenPay Japan Web3 Directory API',
    version: '1.0.0',
    description:
      'Published-only directory metadata with first-party attribution and source freshness. Paid routes use x402 with JPYC.',
  },
  servers: [{ url: 'https://open-pay.jp' }],
  tags: [
    { name: 'Directory Free' },
    { name: 'Directory Paid' },
  ],
  paths: {
    '/api/directory': {
      get: {
        tags: ['Directory Free'],
        summary: 'Get a free directory teaser',
        description: 'Returns full entry fields but forces limit to at most 5.',
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
        'x-price-jpyc': 2,
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
        'x-price-jpyc': 2,
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
        'x-payment-chains': ['Base'],
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
        'x-payment-chains': ['Base'],
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
  },
  components: {
    schemas: {
      DirectoryEntry: {
        type: 'object',
        required: [
          'slug',
          'name',
          'nameJa',
          'status',
          'sourceUrl',
          'sourceType',
          'verifiedAt',
          'updatedAt',
          'attribution',
          'facts',
          'editorial',
          'sourceCheckedAt',
          'sourceOk',
        ],
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          nameJa: { type: 'string' },
          status: { type: 'string', const: 'published' },
          sourceUrl: { type: 'string', format: 'uri' },
          sourceType: { type: 'string', enum: ['official', 'manual'] },
          verifiedAt: { type: 'string', format: 'date' },
          updatedAt: { type: 'string', format: 'date' },
          sourceCheckedAt: { type: ['string', 'null'], format: 'date-time' },
          sourceOk: {
            type: ['boolean', 'null'],
            description:
              'Source URL reachability only; it does not establish whether the directory information is true. true = reachable (2xx/3xx), false = confirmed gone (404/410), null = indeterminate (no current result, bot protection, or transient failure).',
          },
          attribution: { type: 'string' },
          facts: {
            type: 'object',
            required: [
              'description',
              'category',
              'tags',
              'tokens',
              'chains',
              'languages',
              'supportsJpyc',
              'supportsUsdc',
              'supportsX402',
              'supportsMcp',
            ],
            properties: {
              description: { type: 'string' },
              category: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              tokens: { type: 'array', items: { type: 'string' } },
              chains: { type: 'array', items: { type: 'string' } },
              languages: { type: 'array', items: { type: 'string' } },
              supportsJpyc: { type: 'boolean' },
              supportsUsdc: { type: 'boolean' },
              supportsX402: { type: 'boolean' },
              supportsMcp: { type: 'boolean' },
            },
          },
          editorial: {
            type: 'object',
            required: ['summaryJa', 'summaryEn'],
            properties: {
              summaryJa: { type: 'string' },
              summaryEn: { type: 'string' },
            },
          },
        },
      },
      DirectoryEnvelope: {
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
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/DirectoryEntry' },
          },
          total: { type: 'integer', minimum: 0 },
          generatedAt: { type: 'string', format: 'date-time' },
          dataFreshness: {
            type: 'object',
            required: ['oldest', 'newestVerifiedAt', 'oldestSourceCheckedAt'],
            properties: {
              oldest: { type: ['string', 'null'], format: 'date' },
              newestVerifiedAt: { type: ['string', 'null'], format: 'date' },
              oldestSourceCheckedAt: {
                type: ['string', 'null'],
                format: 'date-time',
              },
            },
          },
          licenseNotice: {
            type: 'string',
            description:
              'sourceOk reports source URL reachability only, not whether the information is true.',
          },
          attribution: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string' },
          },
        },
      },
      Error: {
        type: 'object',
        required: ['ok', 'error'],
        properties: {
          ok: { type: 'boolean', const: false },
          error: {
            type: 'string',
            enum: [
              'invalid_query',
              'not_found',
              'rate_limited',
              'storage_unavailable',
            ],
          },
        },
      },
    },
    responses: {
      InvalidQuery: {
        description: 'A query value is outside the documented allowlist.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: { ok: false, error: 'invalid_query' },
          },
        },
      },
      NotFound: {
        description: 'Feature disabled, slug absent, or entry not published.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: { ok: false, error: 'not_found' },
          },
        },
      },
      RateLimited: {
        description: 'Best-effort per-IP request limit exceeded.',
        headers: {
          'Retry-After': { schema: { type: 'integer' }, description: 'Seconds' },
        },
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: { ok: false, error: 'rate_limited' },
          },
        },
      },
      PaymentRequired: {
        description:
          'x402 payment challenge. Amount is denominated in JPYC on Polygon or Polygon Amoy; the existing buyer-added facilitator fee is included in maxAmountRequired.',
        headers: {
          'PAYMENT-REQUIRED': {
            schema: { type: 'string' },
            description: 'Base64-encoded x402 v2 payment requirements.',
          },
        },
        content: {
          'application/json': {
            example: {
              x402Version: 1,
              accepts: [
                {
                  scheme: 'exact',
                  network: 'eip155:137',
                  resource:
                    'https://open-pay.jp/api/paid/japan-web3-directory',
                  maxAmountRequired: '3000000000000000000',
                  asset: 'JPYC',
                },
              ],
              error: 'payment_required',
            },
          },
        },
      },
    },
  },
} as const;

/**
 * 現在の flag 構成に対応する OpenAPI 文書。全機能 OFF なら null (= route は 404)。
 * ルート (/openapi.json) と /api/openapi.json が同一文書を配信する単一情報源。
 */
export function buildOpenApiDocument(): Record<string, unknown> | null {
  const shopsEnabled = shopsApiEnabled();
  const facilitatorEnabled = env.enableX402Facilitator;
  if (!env.enableWeb3Directory && !shopsEnabled && !facilitatorEnabled) {
    return null;
  }
  const document = {
    ...OPENAPI_DOCUMENT,
    info: {
      ...OPENAPI_DOCUMENT.info,
      title: 'OpenPay Discovery, Directory and Shops APIs',
      description:
        'Payable x402 resources, structured Japan Web3 directory data, and opt-in JPYC shop discovery.',
    },
    tags: [
      ...(env.enableWeb3Directory ? OPENAPI_DOCUMENT.tags : []),
      ...(shopsEnabled
        ? [{ name: 'Shops Free' }, { name: 'Shops Paid' }]
        : []),
      ...(facilitatorEnabled ? [{ name: 'x402 Catalog' }] : []),
      { name: 'x402 Vanilla (USDC)' },
    ],
    paths: {
      ...(env.enableWeb3Directory ? OPENAPI_DOCUMENT.paths : {}),
      ...(shopsEnabled ? SHOPS_OPENAPI_PATHS : {}),
      ...(facilitatorEnabled ? DISCOVERY_OPENAPI_PATHS : {}),
      ...VANILLA_OPENAPI_PATHS,
      ...vanillaHelloPath(),
    },
    components: {
      ...OPENAPI_DOCUMENT.components,
      schemas: {
        ...OPENAPI_DOCUMENT.components.schemas,
        ...SHOPS_OPENAPI_SCHEMAS,
        ...(facilitatorEnabled ? DISCOVERY_OPENAPI_SCHEMAS : {}),
      },
      responses: {
        ...OPENAPI_DOCUMENT.components.responses,
        StorageUnavailable: {
          description:
            'The shop snapshot could not be completed before payment verification.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: { ok: false, error: 'storage_unavailable' },
            },
          },
        },
      },
    },
  } as const;
  return document;
}
