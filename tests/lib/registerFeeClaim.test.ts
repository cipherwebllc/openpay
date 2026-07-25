import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const MERCHANT = '0x2222222222222222222222222222222222222222' as Address;
const FEE_RECEIVER = '0x3333333333333333333333333333333333333333' as Address;
const MERCHANT_TX = `0x${'a'.repeat(64)}` as Hex;
const FEE_TX = `0x${'b'.repeat(64)}` as Hex;
const SALE = 3000n * 10n ** 18n;
const FEE = 30n * 10n ** 18n;

const hold = vi.hoisted(() => ({
  enabled: true,
  feeConfigured: true,
  eval: { ok: true, value: 1 } as
    | { ok: true; value: number }
    | { ok: false; reason: string },
  existing: null as string | null,
  existingOk: true,
}));
const publicClient = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
}));
const evalSpy = vi.hoisted(() => vi.fn());
const getSpy = vi.hoisted(() => vi.fn());
const verifyPairSpy = vi.hoisted(() => vi.fn());

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => publicClient };
});
vi.mock('@/lib/env', () => ({
  env: {
    get enableRegisterFee() {
      return hold.enabled;
    },
    get feeReceiverConfigured() {
      return hold.feeConfigured;
    },
    feeReceiver: '0x3333333333333333333333333333333333333333',
  },
}));
vi.mock('@/lib/chains', () => ({
  chainObjectForId: () => ({ id: 137 }),
  transportForChain: () => vi.fn(),
}));
vi.mock('@/lib/tokens', () => ({
  resolveDeployment: () => ({
    address: '0x1111111111111111111111111111111111111111',
  }),
}));
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverPercentValue: () => 30n * 10n ** 18n,
}));
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycStandardFeePairOnChain: (...args: unknown[]) =>
    verifyPairSpy(...args),
}));
vi.mock('@/lib/kv', () => ({
  kvEval: (...args: unknown[]) => {
    evalSpy(...args);
    return Promise.resolve(hold.eval);
  },
  kvGet: (...args: unknown[]) => {
    getSpy(...args);
    return Promise.resolve(
      hold.existingOk
        ? { ok: true, value: hold.existing }
        : { ok: false, reason: 'unavailable' },
    );
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn() },
}));

import { claimRegisterFeePayment } from '@/lib/registerFeeClaim';

const input = {
  chainId: 137,
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  saleAmount: SALE,
  merchantTxHash: MERCHANT_TX,
  feeTxHash: FEE_TX,
};

beforeEach(() => {
  hold.enabled = true;
  hold.feeConfigured = true;
  hold.eval = { ok: true, value: 1 };
  hold.existing = null;
  hold.existingOk = true;
  evalSpy.mockClear();
  getSpy.mockClear();
  publicClient.getTransactionReceipt.mockReset();
  verifyPairSpy
    .mockReset()
    .mockResolvedValue({ ok: true, value: FEE, blockNumber: 11n });
});

describe('claimRegisterFeePayment', () => {
  it('server 再計算の split を on-chain 照合し、fee txHash を用途 register で claim する', async () => {
    await expect(claimRegisterFeePayment(input)).resolves.toBe('claimed');
    // 額は client 申告ではなく saleAmount からの再計算 (merchant = sale - fee)。
    expect(verifyPairSpy).toHaveBeenCalledWith({
      publicClient,
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_TX,
      expected: {
        token: TOKEN,
        merchant: MERCHANT,
        merchantValue: SALE - FEE,
        feeReceiver: FEE_RECEIVER,
        feeMinValue: FEE,
      },
    });
    expect(evalSpy).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXISTS',KEYS[2])"),
      [`payment:claimed:137:${FEE_TX}`, `billing:settled:137:${FEE_TX}`],
      ['r:register'],
    );
  });

  it('on-chain 照合が落ちたら claim を作らない', async () => {
    verifyPairSpy.mockResolvedValue({
      ok: false,
      reason: 'fee_amount_mismatch',
    });
    await expect(claimRegisterFeePayment(input)).resolves.toBe('verify_failed');
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('merchant leg と fee leg が同一 tx なら受理しない', async () => {
    await expect(
      claimRegisterFeePayment({ ...input, feeTxHash: MERCHANT_TX }),
    ).resolves.toBe('invalid');
    expect(verifyPairSpy).not.toHaveBeenCalled();
  });

  it('flag OFF / FEE_RECEIVER 未設定では RPC まで到達しない', async () => {
    hold.enabled = false;
    await expect(claimRegisterFeePayment(input)).resolves.toBe('invalid');
    hold.enabled = true;
    hold.feeConfigured = false;
    await expect(claimRegisterFeePayment(input)).resolves.toBe('invalid');
    expect(verifyPairSpy).not.toHaveBeenCalled();
  });

  it('同じ fee tx の再通知は replay、別用途が先取りしていれば conflict', async () => {
    hold.eval = { ok: true, value: 0 };
    hold.existing = 'r:register';
    await expect(claimRegisterFeePayment(input)).resolves.toBe('replay');
    hold.existing = 'r:order';
    await expect(claimRegisterFeePayment(input)).resolves.toBe('conflict');
  });

  it('legacy billing 既存 (-1) は conflict', async () => {
    hold.eval = { ok: true, value: -1 };
    await expect(claimRegisterFeePayment(input)).resolves.toBe('conflict');
  });

  it('KV 障害は kv_error (claim 済みと誤認しない)', async () => {
    hold.eval = { ok: false, reason: 'unavailable' };
    await expect(claimRegisterFeePayment(input)).resolves.toBe('kv_error');
    hold.eval = { ok: true, value: 0 };
    hold.existingOk = false;
    await expect(claimRegisterFeePayment(input)).resolves.toBe('kv_error');
  });
});
