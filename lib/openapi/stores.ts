// JPYC 受入先カタログの USDC 版 (vanilla x402)。JPYC 版 /api/paid/stores は discovery.ts
// (x402 Catalog) に属し、paths 上の位置も facilitator 面の中なのでここへは移さない。

import { USDC_STORES, USDC_STORES_BAZAAR } from '@/lib/x402/usdcStores';
import { usdcPaymentChains, usdcPaymentInfo } from '@/lib/openapi/payment';
import { schemaFromExample } from '@/lib/openapi/schema';

// USDC 版 stores は directory flag に依存しない (JPYC 受入先の別カタログ)。
export const VANILLA_STORES_OPENAPI_PATHS = {
  [USDC_STORES.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)'],
      summary: 'Unlock the curated JPYC acceptance directory (USDC on Base)',
      description:
        'Same data as /api/paid/stores, sold via standard x402 (exact scheme) in USDC on Base mainnet through an external facilitator. No OpenPay fee is added; the listed price is the full charge.',
      'x-payment-info': usdcPaymentInfo(USDC_STORES.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Curated store list after settlement',
          content: {
            'application/json': {
              schema: schemaFromExample(USDC_STORES_BAZAAR.output.example),
              example: USDC_STORES_BAZAAR.output.example,
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
