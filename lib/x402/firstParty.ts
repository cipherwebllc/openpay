import { getAddress, isAddress, type Address } from 'viem';
import { LEGAL_ENTITY } from '@/lib/legal';

export const OPENPAY_CANONICAL_ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;

export type FirstPartyResource = {
  path: '/api/paid/demo' | '/api/paid/stores';
  priceJpyc: string;
  category: 'api' | 'data';
  description: string;
};

export const FIRST_PARTY_RESOURCES = [
  {
    path: '/api/paid/demo',
    priceJpyc: '1',
    category: 'api',
    description: 'OpenPay x402 demo — pay 1 JPYC and unlock a signed hello.',
  },
  {
    path: '/api/paid/stores',
    priceJpyc: '5',
    category: 'data',
    description:
      'Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON).',
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
