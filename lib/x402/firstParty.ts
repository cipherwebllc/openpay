import { getAddress, isAddress, type Address } from 'viem';
import {
  DIRECTORY_LIST_RESOURCE,
  DIRECTORY_SEARCH_RESOURCE,
} from '@/lib/directory/paidResources';
import { env } from '@/lib/env';
import { LEGAL_ENTITY } from '@/lib/legal';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';

export const OPENPAY_CANONICAL_ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;

// x402scan (Merit-Systems) の v1 payable-index 用スキーマ。402 チャレンジの accepts に
// 添付する表示/発見メタで、facilitator の verify/settle には渡さない (money-path 不変)。
export type FirstPartyOutputSchema = {
  input: { type: 'http'; method: 'GET'; discoverable: true };
  output?: Record<string, unknown>;
};

export type FirstPartyResource = {
  path:
    | '/api/paid/demo'
    | '/api/paid/stores'
    | '/api/paid/japan-web3-directory'
    | '/api/paid/japan-web3-directory/search'
    | `/api/paid/japan-web3-directory/${string}`;
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
  // 詳細 API は slug ごとに resource URL が変わる。代表 slug を固定掲載すると accepts が
  // 他 slug の支払い条件を表せないため、AI ストアには固定 URL の一覧/検索だけを掲載する。
  ...(env.enableWeb3Directory
    ? [DIRECTORY_LIST_RESOURCE, DIRECTORY_SEARCH_RESOURCE]
    : []),
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
  const payTo = getAddress(raw);
  // forwarder の settle 検証は merchant == feeReceiver を拒否する。この誤設定のまま
  // 掲載すると「必ず失敗する支払い」を広告してしまうため、null (非掲載/503) に倒して
  // 設定ミスをデプロイ時に顕在化させる。
  if (payTo.toLowerCase() === x402FacilitatorConfig.feeReceiver.toLowerCase()) {
    return null;
  }
  return payTo;
}

export function firstPartyPayTo(): Address {
  const payTo = firstPartyPayToOrNull();
  if (!payTo) {
    throw new Error('x402: X402_PAY_TO_ADDRESS is required for first-party resources');
  }
  return payTo;
}
