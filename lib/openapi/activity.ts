// JPYC ネットワーク活動 (24h 集計)・送金証明 (attest)・無料 preview の operation。

import {
  ACTIVITY_CHAINS,
  USDC_JPYC_ACTIVITY,
  USDC_JPYC_ATTEST,
  agentUsageText,
} from '@/lib/jpyc/liveResources';
import { JPYC_ACTIVITY_PREVIEW_SCHEMA } from '@/lib/jpyc/liveSchema';
import { usdcPaymentChains, usdcPaymentInfo } from '@/lib/openapi/payment';
import { JPYC_LIVE_402 } from '@/lib/openapi/schema';

const JPYC_ACTIVITY_400 = {
  description: 'Unknown or duplicate query key, unsupported chain, empty/invalid window, or missing chain with payment. No settlement.',
};
export const ACTIVITY_OPENAPI_PATHS = {
  [USDC_JPYC_ACTIVITY.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'JPYC Live Data'],
      operationId: USDC_JPYC_ACTIVITY.operationId,
      summary: USDC_JPYC_ACTIVITY.summary,
      description: USDC_JPYC_ACTIVITY.description + ' ' + agentUsageText(USDC_JPYC_ACTIVITY.trigger) + ' Payment: standard x402 in USDC on Base mainnet; no OpenPay fee is added.',
      parameters: [
        { name: 'chain', in: 'query', required: true, schema: { type: 'string', enum: ACTIVITY_CHAINS } },
        { name: 'window', in: 'query', required: false, schema: { type: 'string', enum: ['24h'], default: '24h' } },
      ],
      'x-agent-usage': USDC_JPYC_ACTIVITY.trigger,
      'x-payment-info': usdcPaymentInfo(USDC_JPYC_ACTIVITY.priceUsd),
      'x-payment-protocol': 'x402', 'x-payment-asset': 'USDC', 'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Complete aggregate from immutable finalized buckets after settlement; observedAt is the newest bucket timestamp and expiresAt is four hours later.',
          content: { 'application/json': {
            schema: USDC_JPYC_ACTIVITY.bazaar.output.schema, example: USDC_JPYC_ACTIVITY.bazaar.output.example,
          } },
        },
        '400': JPYC_ACTIVITY_400,
        '402': JPYC_LIVE_402,
        '503': {
          description: 'data_incomplete: a required bucket is missing. data_unavailable: KV is unavailable, malformed or overflowed, or the data timestamp is over 60 seconds in the future. data_stale: the newest bucket timestamp is more than four hours old. No settlement in every case.',
        },
      },
    },
  },
  [USDC_JPYC_ATTEST.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'JPYC Live Data'],
      operationId: USDC_JPYC_ATTEST.operationId,
      summary: USDC_JPYC_ATTEST.summary,
      description: USDC_JPYC_ATTEST.description + ' ' + agentUsageText(USDC_JPYC_ATTEST.trigger) + ' Payment: standard x402 in USDC on Base mainnet; no OpenPay fee is added.',
      parameters: [
        { name: 'chain', in: 'query', required: true, schema: USDC_JPYC_ATTEST.bazaar.queryParamsSchema.properties.chain },
        { name: 'tx', in: 'query', required: true, schema: USDC_JPYC_ATTEST.bazaar.queryParamsSchema.properties.tx },
      ],
      'x-agent-usage': USDC_JPYC_ATTEST.trigger,
      'x-payment-info': usdcPaymentInfo(USDC_JPYC_ATTEST.priceUsd),
      'x-payment-protocol': 'x402', 'x-payment-asset': 'USDC', 'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'JPYC transfers with an optional EIP-712 signature. The signature is not a legal certification.',
          content: { 'application/json': {
            schema: USDC_JPYC_ATTEST.bazaar.output.schema, example: USDC_JPYC_ATTEST.bazaar.output.example,
          } },
        },
        '400': { description: 'Invalid or duplicate query parameters; missing required parameters with payment. No settlement.' },
        '404': { description: 'tx_not_found: receipt not mined or absent. no_jpyc_transfer: reverted or no JPYC Transfer logs. No settlement.' },
        '402': JPYC_LIVE_402,
        '503': {
          description: 'RPC unavailable. No settlement.',
        },
      },
    },
  },
  '/api/jpyc/activity/preview': {
    get: {
      tags: ['JPYC Live Data'], operationId: 'getJpycNetworkActivityPreview',
      summary: 'Preview JPYC network activity availability and transfer count',
      description: 'Free preview using the same finalized buckets and validity checks as the paid feed. Skip a purchase when observedAt is unchanged or expiresAt has passed. Unavailable data has a reason and no sample. No feature flag is required.',
      parameters: [{ name: 'chain', in: 'query', required: false, schema: { type: 'string', enum: ACTIVITY_CHAINS, default: 'polygon' } }],
      responses: {
        '200': {
          description: 'Stable available/unavailable envelope. Available cache freshness plus stale-while-revalidate is capped by expiresAt; unavailable responses cache for 60 seconds.',
          content: { 'application/json': { schema: JPYC_ACTIVITY_PREVIEW_SCHEMA } },
        },
        '400': { description: 'Unknown or duplicate query key, or unsupported/empty chain.' },
      },
    },
  },
} as const;
