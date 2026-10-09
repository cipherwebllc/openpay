// 購入数カウンタ (表示専用ヒント) のフェンス。
// - 記録は no-throw (KV 障害/例外が購入本体へ波及しない = 掟 13 の隔離)
// - key 形式の drift 防止

import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = vi.hoisted(() => ({
  kvIncr: vi.fn(),
}));
vi.mock('@/lib/kv', () => kv);
vi.mock('server-only', () => ({}));

import {
  hostedPurchaseCountKey,
  recordHostedPurchase,
} from '@/lib/x402/purchaseStats';

const ID_A = `h_${'a'.repeat(32)}`;

beforeEach(() => {
  kv.kvIncr.mockReset();
});

describe('purchaseStats', () => {
  it('key 形式は store:purchases:<resourceId>', () => {
    expect(hostedPurchaseCountKey(ID_A)).toBe(`store:purchases:${ID_A}`);
  });

  it('recordHostedPurchase は INCR を 1 回呼ぶ', async () => {
    kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
    await recordHostedPurchase(ID_A);
    expect(kv.kvIncr).toHaveBeenCalledTimes(1);
    expect(kv.kvIncr).toHaveBeenCalledWith(`store:purchases:${ID_A}`);
  });

  it('KV 障害 (ok:false / throw) でも throw しない', async () => {
    kv.kvIncr.mockResolvedValue({ ok: false });
    await expect(recordHostedPurchase(ID_A)).resolves.toBeUndefined();
    kv.kvIncr.mockRejectedValue(new Error('kv down'));
    await expect(recordHostedPurchase(ID_A)).resolves.toBeUndefined();
  });
});
