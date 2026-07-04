import { getAddress, isAddress, type Address } from 'viem';
import { LEGAL_ENTITY } from '@/lib/legal';

export const OPENPAY_CANONICAL_ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;

// x402scan (Merit-Systems) の v1 payable-index 用スキーマ。402 チャレンジの accepts に
// 添付する表示/発見メタで、facilitator の verify/settle には渡さない (money-path 不変)。
export type FirstPartyOutputSchema = {
  input: { type: 'http'; method: 'GET'; discoverable: true };
  output?: Record<string, unknown>;
};

export type FirstPartyResource = {
  path: '/api/paid/demo' | '/api/paid/stores';
  priceJpyc: string;
  category: 'api' | 'data';
  description: string;
  outputSchema: FirstPartyOutputSchema;
};

export const FIRST_PARTY_RESOURCES = [
  {
    path: '/api/paid/demo',
    priceJpyc: '1',
    category: 'api',
    description: 'OpenPay x402 demo — pay 1 JPYC and unlock a signed hello.',
    outputSchema: {
      input: { type: 'http', method: 'GET', discoverable: true },
      output: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Unlock greeting' },
          paidAt: { type: 'string', description: 'ISO timestamp of settlement' },
          payer: { type: 'string', description: 'Payer address (when available)' },
        },
        required: ['message', 'paidAt'],
      },
    },
  },
  {
    path: '/api/paid/stores',
    priceJpyc: '5',
    category: 'data',
    description:
      'Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON).',
    outputSchema: {
      input: { type: 'http', method: 'GET', discoverable: true },
      output: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string', description: 'exchange | dex | dapp | bridge | resource' },
                url: { type: 'string' },
                badges: { type: 'array', items: { type: 'string' } },
                assets: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'category', 'url'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
] as const satisfies readonly FirstPartyResource[];

export function firstPartyResourceUrl(resource: FirstPartyResource): string {
  return `${OPENPAY_CANONICAL_ORIGIN}${resource.path}`;
}

export function firstPartyAmount(resource: FirstPartyResource): bigint {
  return BigInt(resource.priceJpyc) * 10n ** 18n;
}

// First-party resources need a seller address distinct from feeReceiver; the
// forwarder verifier rejects merchant == feeReceiver before broadcast.
// 未設定/不正は null を返す — discovery は「支払えない項目を並べない」ため非掲載に、
// paid route は 503 に倒す (エージェントに壊れた accepts を見せる波及を断つ)。
export function firstPartyPayToOrNull(): Address | null {
  const raw = process.env.X402_PAY_TO_ADDRESS;
  if (!raw || !isAddress(raw)) return null;
  return getAddress(raw);
}

export function firstPartyPayTo(): Address {
  const payTo = firstPartyPayToOrNull();
  if (!payTo) {
    throw new Error('x402: X402_PAY_TO_ADDRESS is required for first-party resources');
  }
  return payTo;
}
