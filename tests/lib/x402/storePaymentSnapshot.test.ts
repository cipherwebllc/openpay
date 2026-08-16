import { describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

vi.mock('server-only', () => ({}));

import { parseStorePurchaseOwnership } from '@/lib/x402/storePaymentSnapshot';
import {
  PURCHASE_INTENT_VERSION,
  PURCHASE_REVISION_POLICY,
} from '@/lib/x402/purchaseIntent';

const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const SELLER = getAddress('0x2222222222222222222222222222222222222222');
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const RESOURCE = `h_${'a'.repeat(32)}`;
const SALT = `0x${'33'.repeat(32)}`;
const TX = `0x${'44'.repeat(32)}`;
const NONCE = `0x${'55'.repeat(32)}`;
const NOW = 1_900_000_000_000;

function grant() {
  return {
    intentSalt: SALT,
    contentRevision: 1,
    contentRef: `x402:hosted:${RESOURCE}:content:1`,
    metadata: {
      owner: SELLER,
      payTo: SELLER,
      title: 'Snapshot product',
      priceJpyc: '300',
      contentKind: 'text',
      label: 'prompt',
    },
    chainId: 8453,
    txHash: TX,
    nonce: NONCE,
    purchasedAt: NOW,
  };
}

function payment() {
  return {
    version: 1,
    rail: 'usdc',
    asset: USDC,
    assetSymbol: 'USDC',
    chainId: 8453,
    paidAtomic: '2000000',
    priceJpyc: '300',
    quote: {
      rateScaled: '150000000',
      rateFetchedAt: NOW - 180_000,
      fxQuoteExpiresAt: NOW - 1,
      rounding: 'ceil',
    },
  };
}

function ownership(currentGrant: Record<string, unknown>) {
  return {
    version: PURCHASE_INTENT_VERSION,
    policy: PURCHASE_REVISION_POLICY,
    payer: PAYER,
    resourceId: RESOURCE,
    firstPurchasedAt: NOW,
    updatedAt: NOW,
    grants: [currentGrant],
    latestGrant: currentGrant,
  };
}

describe('Store payment snapshot parser', () => {
  it('旧 JPYC grant に rail の既定値を注入しない', () => {
    const parsed = parseStorePurchaseOwnership(
      JSON.stringify(ownership(grant())),
    );
    expect(parsed?.grants[0]).not.toHaveProperty('payment');
    expect(parsed?.latestGrant).not.toHaveProperty('payment');
  });

  it('versioned USDC snapshot を grant/latest に再付与する', () => {
    const withPayment = { ...grant(), payment: payment() };
    const parsed = parseStorePurchaseOwnership(
      JSON.stringify(ownership(withPayment)),
    );
    expect(parsed?.grants[0]?.payment).toEqual(payment());
    expect(parsed?.latestGrant.payment).toEqual(payment());
  });

  it('latestGrant だけ snapshot が欠落・改竄した fixture は拒否する', () => {
    const withPayment = { ...grant(), payment: payment() };
    const missing = ownership(withPayment);
    missing.latestGrant = grant();
    expect(parseStorePurchaseOwnership(JSON.stringify(missing))).toBeNull();

    const tampered = ownership(withPayment);
    tampered.latestGrant = {
      ...withPayment,
      payment: { ...payment(), paidAtomic: '1999999' },
    };
    expect(parseStorePurchaseOwnership(JSON.stringify(tampered))).toBeNull();
  });

  it('別 token asset と 180 秒を超える quote snapshot は拒否する', () => {
    for (const badPayment of [
      {
        ...payment(),
        asset: '0x3333333333333333333333333333333333333333',
      },
      {
        ...payment(),
        quote: {
          ...payment().quote,
          fxQuoteExpiresAt: payment().quote.rateFetchedAt + 180_001,
        },
      },
    ]) {
      const withPayment = { ...grant(), payment: badPayment };
      expect(
        parseStorePurchaseOwnership(JSON.stringify(ownership(withPayment))),
      ).toBeNull();
    }
  });
});
