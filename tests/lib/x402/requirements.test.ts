import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAddress } from 'viem';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

// requirements は import 時 (経由 facilitatorConfig / env / forwarderConfig) に process.env を
// 読むため、各 test で vi.resetModules() + env を都度 set し直す (config.test.ts と同型)。
// 既定 test env (vitest.config): NETWORK_ENV=testnet → facilitator chain = Amoy(80002)、
// FEE_RECEIVER=0xdead…1234 (configured)、JPYC_TESTNET_ADDRESS=0x…abc。
// forwarder は既定未設定なので各 test が必要時に NEXT_PUBLIC_JPYC_FORWARDER_AMOY を set する。

const FORWARDER_RAW = '0x1234567890123456789012345678901234567890';
const SELLER_RAW = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const BURN = '0x000000000000000000000000000000000000dEaD';
const JPYC = (n: bigint): bigint => n * 10n ** 18n;

const KEYS = [
  'NEXT_PUBLIC_JPYC_FORWARDER_AMOY',
  'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS',
  'X402_FEE_BPS',
  'X402_FEE_FLOOR_JPYC',
] as const;
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of KEYS) ORIG[k] = process.env[k];
  // forwarder は既定で未設定にしておく (必要な test が明示的に set する)。
  // FEE_RECEIVER は vitest 既定 (configured) のまま残す。
  delete process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY;
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

describe('lib/x402/requirements', () => {
  it('正常系: fee 込み accepts[] を生成 (forwarder 分割 + extra.openpay)', async () => {
    process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = FORWARDER_RAW;
    const { createJpycPaymentRequirements } = await import(
      '@/lib/x402/requirements'
    );
    const out = createJpycPaymentRequirements({
      amount: JPYC(1000n),
      payTo: SELLER_RAW,
      resource: 'https://api.example.jp/paid/translate',
      description: 'JP→EN 翻訳 API 1 回',
    });

    expect(out).toHaveLength(1);
    const pr = out[0];
    expect(pr.scheme).toBe('exact');
    expect(pr.network).toBe('eip155:80002'); // Amoy (CAIP-2)
    expect(pr.payTo).toBe(getAddress(FORWARDER_RAW)); // wire payTo = forwarder
    expect(pr.asset).toBe(getAddress('0x0000000000000000000000000000000000000abc'));
    expect(pr.resource).toBe('https://api.example.jp/paid/translate');
    expect(pr.description).toBe('JP→EN 翻訳 API 1 回');
    expect(pr.mimeType).toBe('');
    expect(pr.maxTimeoutSeconds).toBe(600);
    // 買い手の総署名額 = merchantValue(1000) + fee(10 = 1%) = 1010 JPYC
    expect(pr.maxAmountRequired).toBe(JPYC(1010n).toString());

    expect(pr.extra.name).toBe('JPY Coin');
    expect(pr.extra.version).toBe('1');
    expect(pr.extra.decimals).toBe(18);
    expect(pr.extra.assetTransferMethod).toBe('eip3009');

    const o = pr.extra.openpay;
    expect(o.mode).toBe('forwarder-split');
    expect(o.forwarder).toBe(getAddress(FORWARDER_RAW));
    expect(o.merchant).toBe(getAddress(SELLER_RAW)); // 実 seller は extra.merchant
    expect(o.merchantValue).toBe(JPYC(1000n).toString());
    // vitest 既定の NEXT_PUBLIC_FEE_RECEIVER_ADDRESS (placeholder ではない = configured)。
    expect(o.feeReceiver).toBe(
      getAddress('0xdead000000000000000000000000000000001234'),
    );
    expect(o.feeValue).toBe(JPYC(10n).toString());
    expect(o.commitVersion).toBe(FORWARDER_COMMIT_VERSION);
  });

  it('小口は floor (1 JPYC) が手数料になる', async () => {
    process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = FORWARDER_RAW;
    const { createJpycPaymentRequirements } = await import(
      '@/lib/x402/requirements'
    );
    const pr = createJpycPaymentRequirements({
      amount: JPYC(1n),
      payTo: SELLER_RAW,
      resource: 'https://api.example.jp/paid/hello',
      description: 'hello',
    })[0];
    expect(pr.extra.openpay.merchantValue).toBe(JPYC(1n).toString());
    expect(pr.extra.openpay.feeValue).toBe(JPYC(1n).toString()); // floor
    expect(pr.maxAmountRequired).toBe(JPYC(2n).toString()); // 1 + 1
  });

  it('amount <= 0 は throw', async () => {
    process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = FORWARDER_RAW;
    const { createJpycPaymentRequirements } = await import(
      '@/lib/x402/requirements'
    );
    expect(() =>
      createJpycPaymentRequirements({
        amount: 0n,
        payTo: SELLER_RAW,
        resource: 'r',
        description: 'd',
      }),
    ).toThrow(/amount must be > 0/);
  });

  it('forwarder 未設定は throw (壊れた requirements を返さない)', async () => {
    // NEXT_PUBLIC_JPYC_FORWARDER_AMOY は beforeEach で未設定
    const { createJpycPaymentRequirements } = await import(
      '@/lib/x402/requirements'
    );
    expect(() =>
      createJpycPaymentRequirements({
        amount: JPYC(100n),
        payTo: SELLER_RAW,
        resource: 'r',
        description: 'd',
      }),
    ).toThrow(/forwarder unconfigured/);
  });

  it('feeReceiver=burn (未設定) は throw', async () => {
    process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = FORWARDER_RAW;
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = BURN; // placeholder → unconfigured
    const { createJpycPaymentRequirements } = await import(
      '@/lib/x402/requirements'
    );
    expect(() =>
      createJpycPaymentRequirements({
        amount: JPYC(100n),
        payTo: SELLER_RAW,
        resource: 'r',
        description: 'd',
      }),
    ).toThrow(/fee receiver unconfigured/);
  });
});
