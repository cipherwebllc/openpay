import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress, type Address, type Hex } from 'viem';
import {
  FORWARDER_COMMIT_VERSION,
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

type BuyerScript = {
  buildForwarderNonce: (
    params: ForwarderSettleParams,
    chainId: number,
    forwarder: Address,
    commitVersion: Hex,
  ) => Hex;
  buildTypedDataFromPaymentRequirements: (
    accept: Record<string, unknown>,
    authorization: {
      from: Address;
      validAfter: string;
      validBefore: string;
      intentSalt: Hex;
    },
  ) => {
    params: ForwarderSettleParams;
    typedData: ReturnType<typeof buildReceiveWithAuthorizationTypedData>;
  };
};

const JPYC = 10n ** 18n;
const CHAIN = 80002;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const FROM = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const SALT =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hex;

async function loadBuyerScript(): Promise<BuyerScript> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/x402-buyer-example.mjs')).href
  )) as BuyerScript;
}

function params(): ForwarderSettleParams {
  return {
    from: FROM,
    merchant: MERCHANT,
    merchantValue: 5n * JPYC,
    feeReceiver: FEE_RECEIVER,
    feeValue: 2n * JPYC,
    validAfter: 0n,
    validBefore: 1_000_000_600n,
    intentSalt: SALT,
  };
}

function accept(): Record<string, unknown> {
  const p = params();
  return {
    scheme: 'exact',
    network: `eip155:${CHAIN}`,
    maxAmountRequired: (p.merchantValue + p.feeValue).toString(),
    resource: 'https://open-pay.jp/api/paid/stores',
    description: 'Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON).',
    mimeType: 'application/json',
    payTo: FORWARDER,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: p.merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: p.feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

describe('scripts/x402-buyer-example.mjs', () => {
  it('forwarder nonce construction mirrors lib/relay/forwarderIntent exactly', async () => {
    const buyer = await loadBuyerScript();
    const p = params();
    expect(buyer.buildForwarderNonce(p, CHAIN, FORWARDER, FORWARDER_COMMIT_VERSION)).toBe(
      buildForwarderNonce(p, CHAIN, FORWARDER),
    );
  });

  it('typed data from accepts.extra.openpay matches forwarderIntent output', async () => {
    const buyer = await loadBuyerScript();
    const p = params();
    const out = buyer.buildTypedDataFromPaymentRequirements(accept(), {
      from: p.from,
      validAfter: p.validAfter.toString(),
      validBefore: p.validBefore.toString(),
      intentSalt: p.intentSalt,
    });
    const expected = buildReceiveWithAuthorizationTypedData(
      p,
      CHAIN,
      TOKEN,
      FORWARDER,
    );
    expect(out.params).toEqual(p);
    expect(out.typedData).toEqual(expected);
  });
});
