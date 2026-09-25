// Japan Web3 Directory の Monitor 2 商品 (JPYC Service Monitor / Japan Stablecoin Payment Monitor)
// の USDC レール・JPYC レールと無料 teaser。6 本の説明 (x-agent-usage・teaser description) は
// provider / dedupe キー / 検証手順の文言がそれぞれ違うため、共通文に括り出さない。

import {
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import {
  USDC_PAYMENT_MONITOR,
  USDC_PAYMENT_MONITOR_BAZAAR,
  USDC_SERVICE_MONITOR,
  USDC_SERVICE_MONITOR_BAZAAR,
} from '@/lib/directory/usdcResource';
import { paymentInfo, usdcPaymentChains, usdcPaymentInfo } from '@/lib/openapi/payment';
import { JPYC_LIVE_402, schemaFromExample } from '@/lib/openapi/schema';

const MONITOR_400 = {
  description:
    'Invalid monitor query (invalid_query): unknown query key, invalid changedSince calendar date (YYYY-MM-DD), or invalid limit (integer from 1 to 200).',
};

// USDC は vanillaGate の settle 例外も 503。JPYC は設定・preflight・予算の拒否が 503、
// broadcast 後の pending は 202。保証は今回の要求だけに限定し、過去の課金状態を断定しない。
const USDC_MONITOR_503 = {
  description:
    'The payment facility is temporarily unavailable (payment_facility_unavailable). Settlement may already have been submitted; check payment status before retrying.',
};
const JPYC_MONITOR_503 = {
  description:
    'The payment facility is temporarily unavailable (payment_facility_unavailable or a facilitator configuration, preflight or budget error). No new settlement is submitted by this request; an earlier payment may already have settled.',
};

// JPYC Service Monitor (両通貨版共通)。実装 (lib/directory/serviceMonitor.ts の
// parseServiceMonitorQuery) と一致させる — ずれるとエージェントが 400 を踏む。
const SERVICE_MONITOR_PARAMS = [
  {
    name: 'changedSince',
    in: 'query',
    required: false,
    schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description:
      'Return only change events whose effective date max(date, collectedAt ?? date) is on/after this date (YYYY-MM-DD, inclusive). Echo the nextChangedSince value from your previous response. Omit for the full monitor snapshot (mode=snapshot).',
    example: '2026-08-20',
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 200 },
    description:
      'Maximum number of change events to return. In delta mode (changedSince set) the limit is rounded up to an effective-date boundary (max(date, collectedAt ?? date)): events with the same effective date are never split, even if the group exceeds limit. While hasMore is true, call again with changedSince set to nextChangedSince.',
  },
] as const;

// Monitor の **USDC レール**と無料 teaser 2 本は env.enableWeb3Directory だけに依存する
// (各 route の enableWeb3Directory チェックで 404 に倒れる。精算は外部 facilitator なので
// x402 facilitator flag とは無関係)。flag OFF でも掲載していると、実際には 404 する
// エンドポイントをインデクサに広告してしまう (E6)。
// JPYC レールの 2 本は guardPaidDirectoryApi が **両 flag** を要求するため別集合
// (JPYC_DIRECTORY_MONITOR_OPENAPI_PATHS) にする。
export const VANILLA_DIRECTORY_OPENAPI_PATHS = {
  [USDC_SERVICE_MONITOR.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'Japan Web3 Directory'],
      operationId: 'getJpycServiceMonitorUsdc',
      summary: 'JPYC Service Monitor — weekly change feed (USDC on Base)',
      description: `${USDC_SERVICE_MONITOR.description} Payment: standard x402 (exact scheme) in USDC on Base mainnet; no OpenPay fee is added.`,
      parameters: SERVICE_MONITOR_PARAMS,
      'x-agent-usage':
        'Run on a weekly schedule. Before paying, GET the free /api/jpyc/services/teaser and compare latestRecordedAt (max(date, collectedAt), with date used when collectedAt is absent) with your stored nextChangedSince: if it is before that date, skip the purchase (the paid delta would be empty). Otherwise echo nextChangedSince as changedSince to pay only for deltas; dedupe by slug+date+changeType. When changes is empty, report "no significant change" — do not re-fetch the snapshot. Verify with each event sourceUrl before acting on a change.',
      'x-payment-info': usdcPaymentInfo(USDC_SERVICE_MONITOR.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Monitor snapshot or change delta after settlement',
          content: {
            'application/json': {
              schema: schemaFromExample(USDC_SERVICE_MONITOR_BAZAAR.output.example),
              example: USDC_SERVICE_MONITOR_BAZAAR.output.example,
            },
          },
        },
        '400': MONITOR_400,
        '402': JPYC_LIVE_402,
        '503': {
          description:
            'Monitor storage is temporarily unavailable (storage_unavailable), or the payment facility is unavailable (payment_facility_unavailable). Storage failures skip settlement for this request. If payment settlement fails, settlement may already have been submitted; check payment status before retrying.',
        },
      },
    },
  },
  '/api/jpyc/services/teaser': {
    get: {
      tags: ['Japan Web3 Directory'],
      summary: 'Free teaser of the JPYC Service Monitor (latest 3 change events)',
      description:
        'Free, no payment: the 3 most recent change events from the JPYC Service Monitor, so an agent can inspect real output before buying — and skip the paid call when latestRecordedAt (max(date, collectedAt), with date used when collectedAt is absent) is before its stored nextChangedSince. The paid feed adds every event, the current monitor row per service, and changedSince deltas.',
      responses: {
        '200': { description: 'Latest 3 events plus pointers to the paid feed' },
        '404': { description: 'Feature disabled' },
      },
    },
  },
  '/api/stablecoin-payments/teaser': {
    get: {
      tags: ['Japan Web3 Directory'],
      summary: 'Free teaser of the Japan Stablecoin Payment Monitor (latest 3 events)',
      description:
        'Free, no payment: the 3 most recent payment-scope events, so an agent can inspect real output before buying — and skip the paid call when latestRecordedAt (max(date, collectedAt), with date used when collectedAt is absent) is before its stored nextChangedSince. The paid feed adds the full dated history and changedSince deltas.',
      responses: {
        '200': { description: 'Latest 3 events plus pointers to the paid feed' },
        '404': { description: 'Feature disabled' },
      },
    },
  },
  [USDC_PAYMENT_MONITOR.path]: {
    get: {
      tags: ['x402 Vanilla (USDC)', 'Japan Web3 Directory'],
      operationId: 'getStablecoinPaymentMonitorUsdc',
      summary: 'Japan Stablecoin Payment Monitor — weekly change feed (USDC on Base)',
      description: `${USDC_PAYMENT_MONITOR.description} Payment: standard x402 (exact scheme) in USDC on Base mainnet; no OpenPay fee is added.`,
      parameters: SERVICE_MONITOR_PARAMS,
      'x-agent-usage':
        'Run on a weekly schedule when monitoring Japanese stablecoin payment providers. Before paying, GET the free /api/stablecoin-payments/teaser and compare latestRecordedAt (max(date, collectedAt), with date used when collectedAt is absent) with your stored nextChangedSince: if it is before that date, skip the purchase (the paid delta would be empty). Otherwise echo nextChangedSince as changedSince; dedupe by provider+date+changeCategory. When changes is empty, report "no significant change". Verify with each event sourceUrl before acting on a change.',
      'x-payment-info': usdcPaymentInfo(USDC_PAYMENT_MONITOR.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
      responses: {
        '200': {
          description: 'Payment-scope change events after settlement',
          content: {
            'application/json': {
              schema: schemaFromExample(USDC_PAYMENT_MONITOR_BAZAAR.output.example),
              example: USDC_PAYMENT_MONITOR_BAZAAR.output.example,
            },
          },
        },
        '400': MONITOR_400,
        '402': JPYC_LIVE_402,
        '503': USDC_MONITOR_503,
      },
    },
  },
} as const;

// JPYC レールの Monitor 2 本は guardPaidDirectoryApi (app/api/paid/japan-web3-directory/
// _shared.ts) が **enableWeb3Directory かつ enableX402Facilitator** を要求する。directory
// flag だけで掲載すると、facilitator OFF の構成で 404 する有料エンドポイントを広告してしまう。
export const JPYC_DIRECTORY_MONITOR_OPENAPI_PATHS = {
  '/api/paid/jpyc/services': {
    get: {
      tags: ['x402 (JPYC)', 'Japan Web3 Directory'],
      operationId: 'getJpycServiceMonitor',
      summary: 'JPYC Service Monitor — weekly change feed (JPYC)',
      description:
        'Same data and contract as the USDC variant: dated change events (added / updated / removed / verified) for Japan-related JPYC/Web3 services, each tied to an official source URL. Pass changedSince=YYYY-MM-DD to fetch only what changed; an empty changes list explicitly means no change. Paid in JPYC via the OpenPay facilitator (buyer pays price + x402 facilitator fee).',
      parameters: SERVICE_MONITOR_PARAMS,
      'x-agent-usage':
        'Run on a weekly schedule. Before paying, GET the free /api/jpyc/services/teaser and compare latestRecordedAt (max(date, collectedAt), with date used when collectedAt is absent) with your stored nextChangedSince: if it is before that date, skip the purchase (the paid delta would be empty). Otherwise echo nextChangedSince as changedSince; dedupe by slug+date+changeType. When changes is empty, report "no significant change".',
      'x-payment-info': paymentInfo(JPYC_SERVICES_RESOURCE.priceJpyc),
      responses: {
        '200': {
          description: 'Monitor snapshot or change delta after settlement',
          content: {
            'application/json': {
              schema: schemaFromExample(USDC_SERVICE_MONITOR_BAZAAR.output.example),
              example: USDC_SERVICE_MONITOR_BAZAAR.output.example,
            },
          },
        },
        '400': MONITOR_400,
        '402': { $ref: '#/components/responses/PaymentRequired' },
        '503': {
          description:
            'Monitor storage is temporarily unavailable (storage_unavailable), or the payment facility is unavailable (payment_facility_unavailable or a facilitator configuration, preflight or budget error). No new settlement is submitted by this request; an earlier payment may already have settled.',
        },
      },
    },
  },
  '/api/paid/stablecoin-payments': {
    get: {
      tags: ['x402 (JPYC)', 'Japan Web3 Directory'],
      operationId: 'getStablecoinPaymentMonitor',
      summary: 'Japan Stablecoin Payment Monitor — weekly change feed (JPYC)',
      description:
        'Same data and contract as the USDC variant: dated, categorized events (launches, pilots, partnerships, fee changes, closures) for stablecoin payment services in Japan, each tied to an official source URL. Pass changedSince=YYYY-MM-DD to fetch only new events; an empty changes list explicitly means no change. Paid in JPYC via the OpenPay facilitator (buyer pays price + x402 facilitator fee).',
      parameters: SERVICE_MONITOR_PARAMS,
      'x-agent-usage':
        'Run on a weekly schedule when monitoring Japanese stablecoin payment providers. Before paying, GET the free /api/stablecoin-payments/teaser and compare latestRecordedAt (max(date, collectedAt), with date used when collectedAt is absent) with your stored nextChangedSince: if it is before that date, skip the purchase (the paid delta would be empty). Otherwise echo nextChangedSince as changedSince; report "no significant change" when changes is empty.',
      'x-payment-info': paymentInfo(JPYC_PAYMENTS_RESOURCE.priceJpyc),
      responses: {
        '200': {
          description: 'Payment-scope change events after settlement',
          content: {
            'application/json': {
              schema: schemaFromExample(USDC_PAYMENT_MONITOR_BAZAAR.output.example),
              example: USDC_PAYMENT_MONITOR_BAZAAR.output.example,
            },
          },
        },
        '400': MONITOR_400,
        '402': { $ref: '#/components/responses/PaymentRequired' },
        '503': JPYC_MONITOR_503,
      },
    },
  },
} as const;
