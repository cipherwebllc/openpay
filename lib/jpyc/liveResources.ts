// /api/paid/usdc/jpyc/* (JPYC オンチェーン事実の有料 API・USDC/Base・vanilla x402) の
// 単一情報源。route・/openapi.json・Bazaar 宣言はここから生成する。**public/llms.txt は手動同期**
// (静的ファイル) — path と宣言した引数名が llms.txt に載っていることを
// tests/lib/jpyc/liveResourcesBazaar.test.ts がフェンスする。
//
// 価格の根拠 (2026-08-21・agentic.market 30 日集計): 売れている RPC 系コモディティは
// $0.001〜0.008。supply/balance は eth_call 1 発なので $0.002、transfers は getLogs の
// 走査を伴うので $0.005。OpenPay 手数料は無く表示価格の 100% が payTo に届く。
//
// 文言の型 (2026-08-23 裁定): 4 層を別目的で最適化する。
//   - serviceName / tags: Bazaar 検索で「検索される言葉」に寄せる (ブランドでなく実行する仕事)
//   - description: 3 文 = ①何を返すか ②どんなタスクで使うか ③何には使えないか。
//     "live / real-time / accurate / verified / complete" 等の裏付けなし形容は書かず、
//     "read at request time" "observed block" のように確認可能な事実を書く
//   - trigger: 販促文でなく購入ルール = Call when / Repeat when / Prefer over / Do not call when
//   - operationId / summary: エージェントが自然文を読まずに呼べるよう、決済レールを混ぜない

import { JPYC_CHAINS } from '@/lib/chains';
import {
  JPYC_LIVE_NOTICE_CODE,
  JPYC_LIVE_TERMS_URL,
  TRANSFERS_DEFAULT_LIMIT,
  TRANSFERS_MAX_LIMIT,
  TRANSFER_CURSOR_PATTERN,
} from './live';
import {
  JPYC_BALANCE_RESPONSE_SCHEMA,
  JPYC_SUPPLY_RESPONSE_SCHEMA,
  JPYC_TRANSFERS_RESPONSE_SCHEMA,
} from './liveSchema';

const CHAIN_ENUM = [...JPYC_CHAINS];
const CHAIN_LIST_TEXT = 'polygon, kaia, avalanche, ethereum';

/** 掲載カードのアイコン (public/icon-512.png・本番到達確認済み)。 */
export const JPYC_LIVE_ICON_URL = 'https://open-pay.jp/icon-512.png';

/** 購入ルール (Call / Repeat / Prefer / Do not call)。OpenAPI x-agent-usage と llms.txt に投影する。 */
export type AgentUsage = {
  callWhen: readonly string[];
  repeatWhen: readonly string[];
  preferOver: readonly string[];
  avoidWhen: readonly string[];
  /** 応答のどのキーが「新しさ」を表すか (再購入判断のため)。 */
  freshnessKey: readonly string[];
  /** 再購入時の重複除去キー (あれば)。 */
  dedupeKey?: readonly string[];
};

/** limit の pattern: 1〜TRANSFERS_MAX_LIMIT の整数 (Bazaar では query は文字列で渡る)。 */
export const TRANSFERS_LIMIT_PATTERN = `^(?:[1-9]|[1-9][0-9]|${TRANSFERS_MAX_LIMIT})$`;

export const USDC_JPYC_SUPPLY = {
  path: '/api/paid/usdc/jpyc/supply',
  operationId: 'getJpycSupply',
  serviceName: 'JPYC Supply by Chain',
  summary: 'Get current JPYC total supply by chain',
  price: '$0.002',
  priceUsd: '0.002',
  tags: ['jpyc', 'japanese-yen', 'stablecoin', 'token-supply', 'onchain-data', 'multi-chain'],
  description:
    'Read the current contract-reported JPYC totalSupply on Polygon, Kaia, Avalanche or Ethereum, with the token contract address and the block number observed at request time. Use for periodic supply monitoring, cross-chain comparison, or verifying a current JPYC supply figure before citing it. Not for market price, reserve backing, circulating-supply analysis, or financial advice.',
  trigger: {
    callWhen: [
      'The task requires the current contract-reported JPYC supply on a specific chain',
      'A fresh cross-chain comparison of JPYC supply is needed',
    ],
    repeatWhen: [
      'New blocks have been produced since the previous blockNumber',
      'Running a scheduled supply monitor',
    ],
    preferOver: ['Cached web pages when the exact observed block and token contract matter'],
    avoidWhen: [
      'Looking for JPYC price, reserve backing, legal circulation figures, or market analysis',
    ],
    freshnessKey: ['items[].blockNumber'],
  } satisfies AgentUsage,
  bazaar: {
    queryParams: { chain: 'polygon' },
    queryParamsSchema: {
      properties: {
        chain: {
          type: 'string',
          enum: CHAIN_ENUM,
          description: `Chain to query. Omit to query all supported chains. Supported values: ${CHAIN_LIST_TEXT}.`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: JPYC_SUPPLY_RESPONSE_SCHEMA,
      example: {
        schemaVersion: '2.1',
        token: { symbol: 'JPYC', decimals: 18 },
        items: [
          {
            chain: 'polygon',
            chainId: 137,
            contract: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
            status: 'ok',
            blockNumber: '92387745',
            totalSupply: '1234567890000000000000000',
            totalSupplyFormatted: '1234567.89',
          },
        ],
        generatedAt: '2026-08-21T04:30:45.340Z',
        notice: JPYC_LIVE_NOTICE_CODE,
        termsUrl: JPYC_LIVE_TERMS_URL,
      },
    },
  },
} as const;

export const USDC_JPYC_BALANCE = {
  path: '/api/paid/usdc/jpyc/balance',
  operationId: 'getJpycBalance',
  serviceName: 'JPYC Wallet Balance',
  summary: 'Get the current JPYC balance of an address',
  price: '$0.002',
  priceUsd: '0.002',
  tags: ['jpyc', 'wallet-balance', 'payment-reconciliation', 'treasury', 'onchain-data', 'multi-chain'],
  description:
    'Read the current on-chain JPYC balance of any EVM address on one or all supported chains (Polygon, Kaia, Avalanche, Ethereum), with the token contract and the block number observed at request time. Use before or after a payment, for treasury checks, wallet monitoring, and payment reconciliation. The result does not prove wallet ownership and is not a transaction-finality certificate.',
  trigger: {
    callWhen: [
      'An agent must check whether a wallet currently holds JPYC',
      'A balance must be verified before or after a payment',
      'Treasury state must be reconciled',
    ],
    repeatWhen: ['An expected transfer has been sent', 'A newer block is available'],
    preferOver: ['Indexer data when request-time balanceOf results and block numbers are required'],
    avoidWhen: ['Proving wallet ownership', 'Proving that a particular payment is final'],
    freshnessKey: ['items[].blockNumber'],
  } satisfies AgentUsage,
  bazaar: {
    queryParams: { address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81', chain: 'polygon' },
    queryParamsSchema: {
      properties: {
        address: {
          type: 'string',
          pattern: '^0x[a-fA-F0-9]{40}$',
          description: 'EVM address to read the JPYC balance of.',
        },
        chain: {
          type: 'string',
          enum: CHAIN_ENUM,
          description: `Chain to query. Omit to query all supported chains. Supported values: ${CHAIN_LIST_TEXT}.`,
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
    output: {
      schema: JPYC_BALANCE_RESPONSE_SCHEMA,
      example: {
        schemaVersion: '2.1',
        token: { symbol: 'JPYC', decimals: 18 },
        address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
        items: [
          {
            chain: 'polygon',
            chainId: 137,
            contract: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
            status: 'ok',
            blockNumber: '92387745',
            balance: '1000000000000000000000',
            balanceFormatted: '1000',
          },
        ],
        generatedAt: '2026-08-21T04:30:45.340Z',
        notice: JPYC_LIVE_NOTICE_CODE,
        termsUrl: JPYC_LIVE_TERMS_URL,
      },
    },
  },
} as const;

export const USDC_JPYC_TRANSFERS = {
  path: '/api/paid/usdc/jpyc/transfers',
  operationId: 'listRecentJpycTransfers',
  serviceName: 'Recent JPYC Transfers',
  summary: 'List recent JPYC Transfer events on one chain',
  price: '$0.005',
  priceUsd: '0.005',
  tags: ['jpyc', 'token-transfers', 'wallet-activity', 'payment-reconciliation', 'transaction-monitoring', 'onchain-data'],
  description:
    'List recent JPYC Transfer events on one supported chain (Polygon, Kaia, Avalanche or Ethereum) within a fixed block window of roughly the last hour, optionally filtered to a single address as sender or recipient — tx hash, from, to, amount and block. Without a cursor the newest events come first; with a cursor the events after that position come oldest first, so repeated calls with nextCursor receive every new event exactly once. Use to confirm a recent JPYC payment, monitor incoming or outgoing wallet activity, or inspect recent on-chain flows. Not for historical indexing beyond the window, sanctions screening, wallet identity, or finality proof.',
  trigger: {
    callWhen: [
      'An agent must confirm a recent JPYC transfer',
      'Incoming or outgoing JPYC activity for an address must be monitored',
      'The latest JPYC flows on one chain must be inspected',
    ],
    repeatWhen: [
      'Pass the previous nextCursor as cursor to receive only transfers that appeared after the previous purchase (oldest first)',
      'hasMore is true — call again with nextCursor to continue without gaps',
      'The chain has advanced beyond the previous toBlock value',
      'Deduplicate results by txHash and logIndex',
    ],
    preferOver: ['Historical indexers for recent activity; use an indexer for complete transaction history'],
    avoidWhen: ['Complete history', 'Identity checks', 'Finality certificates'],
    freshnessKey: ['toBlock', 'items[].blockNumber'],
    dedupeKey: ['txHash', 'logIndex'],
  } satisfies AgentUsage,
  bazaar: {
    queryParams: { chain: 'polygon', limit: String(TRANSFERS_DEFAULT_LIMIT) },
    queryParamsSchema: {
      properties: {
        chain: {
          type: 'string',
          enum: CHAIN_ENUM,
          description: `Chain to scan. Supported values: ${CHAIN_LIST_TEXT}.`,
        },
        limit: {
          type: 'string',
          pattern: TRANSFERS_LIMIT_PATTERN,
          default: String(TRANSFERS_DEFAULT_LIMIT),
          description: `Maximum number of transfer events to return, newest first (1-${TRANSFERS_MAX_LIMIT}). This is not a page number.`,
        },
        address: {
          type: 'string',
          pattern: '^0x[a-fA-F0-9]{40}$',
          description: 'Only transfers where this address is the sender or the recipient.',
        },
        cursor: {
          type: 'string',
          pattern: TRANSFER_CURSOR_PATTERN,
          description:
            'The nextCursor value from a previous response ("<block>:<logIndex>"). Returns only transfers newer than that position, oldest first, so repeated calls pay only for new events and never skip one; continue with nextCursor while hasMore is true.',
        },
      },
      required: ['chain'],
      additionalProperties: false,
    },
    output: {
      schema: JPYC_TRANSFERS_RESPONSE_SCHEMA,
      example: {
        schemaVersion: '2.1',
        token: { symbol: 'JPYC', decimals: 18 },
        chain: 'polygon',
        chainId: 137,
        contract: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
        fromBlock: '92385945',
        toBlock: '92387745',
        nextCursor: '92387695:286',
        hasMore: false,
        truncated: false,
        items: [
          {
            blockNumber: '92387695',
            txHash: '0xcae3af66168483e5905709cfc8f7cc0162f5234b9c456905df8ab4917b6f8c39',
            logIndex: 286,
            from: '0x13FE0A65D0aA7641B44D1AF17ECE4b41cEbB1880',
            to: '0xB808AF91bDc577BFb3f9c91470f3286dd076e5C1',
            value: '600000000000000000000000',
            valueFormatted: '600000',
          },
        ],
        generatedAt: '2026-08-21T04:30:45.340Z',
        notice: JPYC_LIVE_NOTICE_CODE,
        termsUrl: JPYC_LIVE_TERMS_URL,
      },
    },
  },
} as const;

export const USDC_JPYC_LIVE_RESOURCES = [
  USDC_JPYC_SUPPLY,
  USDC_JPYC_BALANCE,
  USDC_JPYC_TRANSFERS,
] as const;

/** trigger を 1 段落の英文に圧縮する (description 末尾・llms.txt 用)。 */
export function agentUsageText(u: AgentUsage): string {
  return [
    `Call when: ${u.callWhen.join('; ')}.`,
    `Repeat when: ${u.repeatWhen.join('; ')}.`,
    `Prefer over: ${u.preferOver.join('; ')}.`,
    `Do not call when: ${u.avoidWhen.join('; ')}.`,
  ].join(' ');
}
