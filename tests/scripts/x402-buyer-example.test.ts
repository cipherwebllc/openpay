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

type NormalizedAccept = {
  network: string;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: {
    openpay: {
      forwarder: Address;
      merchantValue: bigint;
      feeValue: bigint;
    };
  };
};

type BuyerScript = {
  DEFAULT_MAX_JPYC: string;
  parseJpycCap: (raw: string, label?: string) => bigint;
  assertWithinCap: (total: bigint, cap: bigint, capLabel: string) => void;
  assertSupportedAssetAndForwarder: (accept: NormalizedAccept) => NormalizedAccept;
  clampAuthorizationTimeout: (maxTimeoutSeconds: number) => number;
  normalizePaymentRequirements: (raw: Record<string, unknown>) => NormalizedAccept;
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

// 署名前の金銭ガード (Phase 0a)。402 の自己申告を鵜呑みにせず、上限・既知 asset/
// forwarder・有効期限の 3 点で止まることを検証する。
describe('scripts/x402-buyer-example.mjs: 署名前ガード', () => {
  // SDK guards.mjs の SUPPORTED_JPYC_FORWARDERS['eip155:80002'] と同値。
  const KNOWN_AMOY_FORWARDER = getAddress(
    '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
  );

  function guardedAccept(
    overrides: { asset?: Address; forwarder?: Address } = {},
  ): Record<string, unknown> {
    const forwarder = overrides.forwarder ?? KNOWN_AMOY_FORWARDER;
    const base = accept();
    const extra = base.extra as Record<string, unknown>;
    const openpay = extra.openpay as Record<string, unknown>;
    return {
      ...base,
      asset: overrides.asset ?? TOKEN,
      payTo: forwarder,
      extra: { ...extra, openpay: { ...openpay, forwarder } },
    };
  }

  it('総額が MAX_JPYC を超えたら署名前に中止する', async () => {
    const buyer = await loadBuyerScript();
    const normalized = buyer.assertSupportedAssetAndForwarder(
      buyer.normalizePaymentRequirements(guardedAccept()),
    );
    const total =
      normalized.extra.openpay.merchantValue + normalized.extra.openpay.feeValue;
    expect(total).toBe(7n * JPYC); // merchant 5 + fee 2

    expect(() =>
      buyer.assertWithinCap(total, buyer.parseJpycCap('5'), '5'),
    ).toThrow(/MAX_JPYC=5/);
    // 既定 5 JPYC は現行カタログを想定した保守値。上限内なら通る。
    expect(buyer.DEFAULT_MAX_JPYC).toBe('5');
    expect(() =>
      buyer.assertWithinCap(total, buyer.parseJpycCap('10'), '10'),
    ).not.toThrow();
    // 小数の上限も atomic に落として比較する
    expect(buyer.parseJpycCap('0.5')).toBe(5n * 10n ** 17n);
  });

  it('validBefore の元になる timeout は facilitator 上限 (1200s) で頭打ちにする', async () => {
    const buyer = await loadBuyerScript();
    expect(buyer.clampAuthorizationTimeout(3600)).toBe(1200);
    expect(buyer.clampAuthorizationTimeout(600)).toBe(600);
  });

  it('未知の asset は署名前に中止する (別 token の署名を引き出させない)', async () => {
    const buyer = await loadBuyerScript();
    const rogueToken = getAddress('0x5555555555555555555555555555555555555555');
    expect(() =>
      buyer.assertSupportedAssetAndForwarder(
        buyer.normalizePaymentRequirements(guardedAccept({ asset: rogueToken })),
      ),
    ).toThrow(/既知 JPYC/);
  });

  it('未知の forwarder/payTo は署名前に中止する (総額の付け替えを止める)', async () => {
    const buyer = await loadBuyerScript();
    expect(() =>
      buyer.assertSupportedAssetAndForwarder(
        buyer.normalizePaymentRequirements(guardedAccept({ forwarder: FORWARDER })),
      ),
    ).toThrow(/既知の OpenPay forwarder/);
  });
});
