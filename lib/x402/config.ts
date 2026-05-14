// x402 環境変数を 1 箇所に集約して厳密に検証。lib/env.ts と分離している理由:
//   - 既存の lib/env.ts は NEXT_PUBLIC_* 中心 (client bundle に展開される)。
//   - x402 secrets / 設定は server-only であるべきなので別 module に隔離する。
//
// 起動時 guard:
//   - NODE_ENV=production + X402_TEST_MODE=true → throw (本番で課金 bypass は禁止)
//   - network=base (mainnet) + X402_PAY_TO_ADDRESS 欠落 → throw (burn address 防止)
//   - production + facilitator URL が https でない → throw

import { getAddress, isAddress, type Address } from 'viem';
import type { X402Network } from './types';

const FALLBACK_TESTNET_PAY_TO: Address =
  '0x000000000000000000000000000000000000dEaD';

// 空文字 env (X402_NETWORK="") を未設定と等価に扱う。env 経由で値を消したい
// ユーザーが空文字に設定するケースに対応 (lib/env.ts の nonEmpty と同じ規約)。
function nonEmpty(raw: string | undefined): string | undefined {
  return raw && raw.length > 0 ? raw : undefined;
}

function parseNetwork(raw: string | undefined): X402Network {
  if (raw === 'base' || raw === 'base-sepolia') return raw;
  return 'base-sepolia';
}

function parsePayTo(
  raw: string | undefined,
  network: X402Network,
): Address {
  if (raw && isAddress(raw)) return getAddress(raw);
  if (network === 'base') {
    throw new Error(
      'X402_PAY_TO_ADDRESS is required for network=base (mainnet). ' +
        'Without it, paid API revenues would be sent to the burn address.',
    );
  }
  return FALLBACK_TESTNET_PAY_TO;
}

function parseFacilitatorUrl(
  raw: string | undefined,
  isProd: boolean,
): string {
  const url = nonEmpty(raw) ?? 'https://x402.org/facilitator';
  if (isProd && !url.startsWith('https://')) {
    throw new Error(
      `X402_FACILITATOR_URL must use https:// in production (got: ${url})`,
    );
  }
  return url;
}

const isProd = process.env.NODE_ENV === 'production';
const testMode = process.env.X402_TEST_MODE === 'true';

if (isProd && testMode) {
  throw new Error(
    'X402_TEST_MODE=true is forbidden when NODE_ENV=production. ' +
      'Test mode bypasses payment verification and must never run in prod.',
  );
}

const network = parseNetwork(nonEmpty(process.env.X402_NETWORK));
const payTo = parsePayTo(nonEmpty(process.env.X402_PAY_TO_ADDRESS), network);
const facilitatorUrl = parseFacilitatorUrl(
  process.env.X402_FACILITATOR_URL,
  isProd,
);

export const x402Config = {
  network,
  payTo,
  facilitatorUrl,
  defaultPrice: nonEmpty(process.env.X402_PRICE) ?? '$0.001',
  // X402_ASSET 未設定なら x402-next が network 既定 (USDC) を使う。
  asset: nonEmpty(process.env.X402_ASSET),
  testMode,
} as const;

export type X402Config = typeof x402Config;
