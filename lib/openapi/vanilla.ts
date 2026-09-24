// vanilla x402 (USDC/Base・外部 facilitator・OpenPay 手数料なし) の JPYC ライブデータ面と hello デモ。

import { JPYC_CHAINS } from '@/lib/chains';
import {
  USDC_JPYC_BALANCE,
  USDC_JPYC_SUPPLY,
  USDC_JPYC_TRANSFERS,
  agentUsageText,
} from '@/lib/jpyc/liveResources';
import { x402Config } from '@/lib/x402/config';
import { usdPriceToAtomic } from '@/lib/x402/vanillaGate';
import { usdcPaymentChains, usdcPaymentInfo } from '@/lib/openapi/payment';
import { JPYC_LIVE_400, JPYC_LIVE_402, JPYC_LIVE_503 } from '@/lib/openapi/schema';

// enum は SoT (lib/chains.ts の JPYC_CHAINS) から導出する。literal で固定すると env flag
// (enableJpycAvalanche/enableJpycEthereum) 未点灯時に「宣言はあるが 400 になるチェーン」を
// 広告してしまう (E7: parseRequiredChainParam は JPYC_CHAINS にない値を拒否する)。
const JPYC_CHAIN_LIST = [...JPYC_CHAINS];
const JPYC_CHAIN_PARAM = {
  name: 'chain',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: JPYC_CHAIN_LIST },
  description: `Chain to query. Omit to query all supported chains. Supported values: ${JPYC_CHAIN_LIST.join(', ')}.`,
  example: 'polygon',
};

// vanilla x402 (USDC/Base・外部 facilitator・OpenPay 手数料なし) の直接販売面。
// JPYC facilitator の flag に依存しないため、doc が配信される限り常に載せる。
export const VANILLA_OPENAPI_PATHS = {
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
      'x-payment-chains': usdcPaymentChains(),
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
      'x-payment-chains': usdcPaymentChains(),
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
          description: `Chain to scan. Supported values: ${JPYC_CHAIN_LIST.join(', ')}.`,
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          description:
            'Maximum number of transfer events to return: snapshot newest first, cursor delta oldest first (1-100, default 20). This is not a page number.',
          example: 20,
        },
        {
          name: 'address',
          in: 'query',
          required: false,
          schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
          description: 'Only transfers where this address is the sender or the recipient.',
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          schema: { type: 'string', pattern: '^[0-9]+:(?:-1|[0-9]+)$' },
          description:
            'Both snapshot and delta scan through max(0, raw head - depth), where depth is 64 blocks on Polygon/Ethereum; 2 blocks on Kaia/Avalanche. Deeper reorgs can invalidate cursors. The nextCursor value from a previous response ("<block>:<logIndex>"). Returns only transfers newer than that position, oldest first (mode=delta), returning each observed event once within the scanned window, assuming stable chain history; continue with nextCursor while hasMore is true. If the cursor is older than the scanned window, the response sets truncated=true. A cursor more than 64 blocks beyond the raw head is rejected with 400 cursor_ahead_of_head before settlement (tolerance is measured from the raw head, independently of confirmation depth). Otherwise, a cursor newer than the scan boundary returns no items and is echoed unchanged until the boundary catches up. Without a cursor (mode=snapshot) hasMore only means older events in the window were omitted; start monitoring from nextCursor.',
          example: '92387695:286',
        },
      ],
      'x-agent-usage': USDC_JPYC_TRANSFERS.trigger,
      'x-payment-info': usdcPaymentInfo(USDC_JPYC_TRANSFERS.priceUsd),
      'x-payment-protocol': 'x402',
      'x-payment-asset': 'USDC',
      'x-payment-chains': usdcPaymentChains(),
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
} as const;

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

// hello は価格が env (X402_PRICE) 由来のため、有効な USD 価格のときだけ載せる。
export function vanillaHelloPath(): Record<string, unknown> {
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
        'x-payment-chains': usdcPaymentChains(),
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
