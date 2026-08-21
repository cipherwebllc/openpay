// /api/paid/usdc/jpyc/* (JPYC オンチェーン事実の有料 API・USDC/Base・vanilla x402) の
// 単一情報源。route・/openapi.json・Bazaar 宣言が共用する。
//
// 価格の根拠 (2026-08-21・agentic.market 30 日集計): 売れている RPC 系コモディティは
// $0.001〜0.008。supply/balance は eth_call 1 発なので $0.002、transfers は getLogs の
// 走査を伴うので $0.005。OpenPay 手数料は無く表示価格の 100% が payTo に届く。

import { JPYC_CHAINS } from '@/lib/chains';
import { TRANSFERS_DEFAULT_LIMIT, TRANSFERS_MAX_LIMIT } from './live';

const CHAIN_ENUM = [...JPYC_CHAINS];

const NOTICE_EXAMPLE =
  'On-chain facts read directly from public RPC endpoints at request time. Informational only — not financial advice, not an offer, quote or solicitation. Verify independently before acting.';

export const USDC_JPYC_SUPPLY = {
  path: '/api/paid/usdc/jpyc/supply',
  price: '$0.002',
  priceUsd: '0.002',
  description:
    "Live JPYC (Japan's yen-pegged stablecoin) total supply per chain — Polygon, Kaia, Avalanche and Ethereum — read from the token contracts at request time, with block number and contract address.",
  bazaar: {
    queryParams: { chain: 'polygon' },
    queryParamsSchema: {
      properties: {
        chain: { type: 'string', enum: CHAIN_ENUM, description: 'Omit for all chains' },
      },
      additionalProperties: false,
    },
    output: {
      example: {
        schemaVersion: '1.0',
        token: { symbol: 'JPYC', decimals: 18 },
        items: [
          {
            chain: 'polygon',
            chainId: 137,
            contract: '0xE7C3D5B8B5F5C9A1E2C6A9F8B7D6E5C4B3A2F1E0',
            status: 'ok',
            blockNumber: '78123456',
            totalSupply: '1234567890000000000000000',
            totalSupplyFormatted: '1234567.89',
          },
        ],
        generatedAt: '2026-08-21T00:00:00.000Z',
        notice: NOTICE_EXAMPLE,
      },
    },
  },
} as const;

export const USDC_JPYC_BALANCE = {
  path: '/api/paid/usdc/jpyc/balance',
  price: '$0.002',
  priceUsd: '0.002',
  description:
    'JPYC balance of any address across Polygon, Kaia, Avalanche and Ethereum in one call — live balanceOf reads with block numbers, no indexer lag.',
  bazaar: {
    queryParams: { address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81', chain: 'polygon' },
    queryParamsSchema: {
      properties: {
        address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        chain: { type: 'string', enum: CHAIN_ENUM, description: 'Omit for all chains' },
      },
      required: ['address'],
      additionalProperties: false,
    },
    output: {
      example: {
        schemaVersion: '1.0',
        token: { symbol: 'JPYC', decimals: 18 },
        address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
        items: [
          {
            chain: 'polygon',
            chainId: 137,
            contract: '0xE7C3D5B8B5F5C9A1E2C6A9F8B7D6E5C4B3A2F1E0',
            status: 'ok',
            blockNumber: '78123456',
            balance: '1000000000000000000000',
            balanceFormatted: '1000',
          },
        ],
        generatedAt: '2026-08-21T00:00:00.000Z',
        notice: NOTICE_EXAMPLE,
      },
    },
  },
} as const;

export const USDC_JPYC_TRANSFERS = {
  path: '/api/paid/usdc/jpyc/transfers',
  price: '$0.005',
  priceUsd: '0.005',
  description:
    'Latest JPYC Transfer events on one chain (roughly the last hour of blocks), newest first, optionally filtered to a single address as sender or recipient — tx hash, from, to, amount, block.',
  bazaar: {
    queryParams: { chain: 'polygon', limit: String(TRANSFERS_DEFAULT_LIMIT) },
    queryParamsSchema: {
      properties: {
        chain: { type: 'string', enum: CHAIN_ENUM },
        limit: { type: 'string', description: `1-${TRANSFERS_MAX_LIMIT} (default ${TRANSFERS_DEFAULT_LIMIT})` },
        address: {
          type: 'string',
          pattern: '^0x[a-fA-F0-9]{40}$',
          description: 'Only transfers where this address is sender or recipient',
        },
      },
      required: ['chain'],
      additionalProperties: false,
    },
    output: {
      example: {
        schemaVersion: '1.0',
        token: { symbol: 'JPYC', decimals: 18 },
        chain: 'polygon',
        chainId: 137,
        contract: '0xE7C3D5B8B5F5C9A1E2C6A9F8B7D6E5C4B3A2F1E0',
        fromBlock: '78121656',
        toBlock: '78123456',
        items: [
          {
            blockNumber: '78123450',
            txHash: '0x9594200b599c9335b834855c3cb4a186f7943a28d4fc62cee379f694207b0f69',
            logIndex: 12,
            from: '0x9A76ea8Fc0b9f34D34b91d453F2940932C9a7FE0',
            to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
            value: '1000000000000000000000',
            valueFormatted: '1000',
          },
        ],
        generatedAt: '2026-08-21T00:00:00.000Z',
        notice: NOTICE_EXAMPLE,
      },
    },
  },
} as const;

export const USDC_JPYC_LIVE_RESOURCES = [
  USDC_JPYC_SUPPLY,
  USDC_JPYC_BALANCE,
  USDC_JPYC_TRANSFERS,
] as const;
