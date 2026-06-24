import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';
import type { X402Receipt } from '@/lib/x402/receipt';

// receipt は import 時に process.env.X402_RECEIPT_SIGNING_KEY を読む → resetModules + stubEnv で都度評価。

const SIGNER_PK = `0x${'c3'.repeat(32)}` as Hex;
const signerAddr = getAddress(privateKeyToAccount(SIGNER_PK).address);

const baseReceipt: X402Receipt = {
  txHash: `0x${'ab'.repeat(32)}` as Hex,
  payer: getAddress('0x1111111111111111111111111111111111111111'),
  payTo: getAddress('0x2222222222222222222222222222222222222222'),
  amount: (1000n * 10n ** 18n).toString(),
  fee: (10n * 10n ** 18n).toString(),
  asset: getAddress('0x00000000000000000000000000000000000Ca11a'),
  chainId: 80002,
  timestamp: 1_750_000_000,
  nonce: `0x${'22'.repeat(32)}` as Hex,
};

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lib/x402/receipt', () => {
  it('鍵あり: sign → verify round-trip (valid + signer)', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', SIGNER_PK);
    const { signReceipt, verifyReceipt, receiptSignerAddress } = await import(
      '@/lib/x402/receipt'
    );
    expect(receiptSignerAddress()).toBe(signerAddr);
    const sig = await signReceipt(baseReceipt);
    expect(sig).toBeTruthy();
    const v = await verifyReceipt(baseReceipt, sig as Hex);
    expect(v).toEqual({ valid: true, signer: signerAddr });
  });

  it('改竄 receipt (amount 変更) → valid:false (復元 signer が期待値と不一致)', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', SIGNER_PK);
    const { signReceipt, verifyReceipt } = await import('@/lib/x402/receipt');
    const sig = await signReceipt(baseReceipt);
    const tampered: X402Receipt = {
      ...baseReceipt,
      amount: (999n * 10n ** 18n).toString(),
    };
    const v = await verifyReceipt(tampered, sig as Hex);
    expect(v.valid).toBe(false);
  });

  it('鍵なし: signReceipt=null / receiptSignerAddress=null / verify=false', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', '');
    const { signReceipt, verifyReceipt, receiptSignerAddress } = await import(
      '@/lib/x402/receipt'
    );
    expect(receiptSignerAddress()).toBeNull();
    expect(await signReceipt(baseReceipt)).toBeNull();
    const v = await verifyReceipt(baseReceipt, `0x${'00'.repeat(65)}` as Hex);
    expect(v).toEqual({ valid: false, signer: null });
  });

  it('不正鍵: null に倒れ receipt 非発行 (settle は壊さない)', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', '0xnothex');
    const { receiptSignerAddress } = await import('@/lib/x402/receipt');
    expect(receiptSignerAddress()).toBeNull();
  });

  it('parseReceipt: 妥当を通し不正を弾く', async () => {
    const { parseReceipt } = await import('@/lib/x402/receipt');
    expect(parseReceipt(baseReceipt)).not.toBeNull();
    expect(parseReceipt({ ...baseReceipt, amount: 'x' })).toBeNull();
    expect(parseReceipt({ ...baseReceipt, chainId: '80002' })).toBeNull(); // number 必須
    expect(parseReceipt({ ...baseReceipt, txHash: '0x123' })).toBeNull();
    expect(parseReceipt(null)).toBeNull();
  });
});
