import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type SdkModule = {
  evaluatePaymentGuards: (options: Record<string, unknown>) => {
    ok: boolean;
    reasons: string[];
  };
  parseClientOptions: (options?: Record<string, unknown>) => Record<string, unknown>;
  readMoneyConfig: (
    env?: Record<string, string | undefined>,
  ) => Record<string, unknown>;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const JPYC = 10n ** 18n;
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function accept() {
  const merchantValue = 5n * JPYC;
  const feeValue = 2n * JPYC;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: RESOURCE,
    description: 'demo',
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
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

describe('openpay-x402-sdk daily guards', () => {
  it('rejects spend above the daily limit', async () => {
    const sdk = await loadSdk();
    const config = sdk.parseClientOptions({
      maxDailyJpyc: '10',
      catalogTrust: false,
    });

    const result = sdk.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      dailySpentAtomic: 4n * JPYC,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('daily_limit_exceeded');
  });

  it('allows a payment that reaches the daily limit exactly', async () => {
    const sdk = await loadSdk();
    const config = sdk.parseClientOptions({
      maxDailyJpyc: '10',
      catalogTrust: false,
    });

    const result = sdk.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      dailySpentAtomic: 3n * JPYC,
    });

    expect(result).toMatchObject({ ok: true, reasons: [] });
  });

  it('keeps the existing guard result unchanged when the limit is unset', async () => {
    const sdk = await loadSdk();
    const config = sdk.parseClientOptions({ catalogTrust: false });

    const result = sdk.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
    });

    expect(config.maxDailyAtomic).toBeNull();
    expect(result).toMatchObject({ ok: true, reasons: [] });
  });

  it('fails closed when configured daily spend is unavailable', async () => {
    const sdk = await loadSdk();
    const config = sdk.parseClientOptions({
      maxDailyJpyc: '10',
      catalogTrust: false,
    });

    const result = sdk.evaluatePaymentGuards({
      url: RESOURCE,
      accept: accept(),
      config,
      dailySpentAtomic: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('daily_spend_unavailable');
  });

  it('parses the optional env and client values with matching validation', async () => {
    const sdk = await loadSdk();

    expect(sdk.readMoneyConfig({}).maxDailyAtomic).toBeNull();
    expect(sdk.readMoneyConfig({ MAX_DAILY_JPYC: '' }).maxDailyAtomic).toBeNull();
    expect(
      sdk.readMoneyConfig({ MAX_DAILY_JPYC: '12.5' }).maxDailyAtomic,
    ).toBe(125n * 10n ** 17n);
    expect(
      sdk.parseClientOptions({ maxDailyJpyc: '12.5' }).maxDailyAtomic,
    ).toBe(125n * 10n ** 17n);
    expect(
      sdk.parseClientOptions({ maxTimeoutSeconds: 900 }).maxTimeoutSeconds,
    ).toBe(900);
    expect(() => sdk.readMoneyConfig({ MAX_DAILY_JPYC: 'invalid' })).toThrow(
      'MAX_DAILY_JPYC must be a JPYC decimal with up to 18 decimals',
    );
    expect(() => sdk.parseClientOptions({ maxDailyJpyc: 'invalid' })).toThrow(
      'MAX_DAILY_JPYC must be a JPYC decimal with up to 18 decimals',
    );
    expect(() => sdk.parseClientOptions({ maxTimeoutSeconds: 1201 })).toThrow(
      'maxTimeoutSeconds must be an integer between 1 and 1200',
    );
  });
});
