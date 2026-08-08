// 購入数カウンタ (表示専用ヒント) のフェンス。
// - 記録は no-throw (KV 障害/例外が購入本体へ波及しない = 掟 13 の隔離)
// - 読み取りは欠落/障害を 0 に倒す (一覧表示を止めない)
// - key 形式の drift 防止

import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = vi.hoisted(() => ({
  kvIncr: vi.fn(),
  kvMget: vi.fn(),
}));
vi.mock('@/lib/kv', () => kv);
vi.mock('server-only', () => ({}));

import {
  hostedPurchaseCountKey,
  readHostedPurchaseCounts,
  recordHostedPurchase,
} from '@/lib/x402/purchaseStats';

const ID_A = `h_${'a'.repeat(32)}`;
const ID_B = `h_${'b'.repeat(32)}`;

beforeEach(() => {
  kv.kvIncr.mockReset();
  kv.kvMget.mockReset();
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

  it('readHostedPurchaseCounts は値を数値化し、欠落/不正は 0', async () => {
    kv.kvMget.mockResolvedValue({ ok: true, value: ['27', null] });
    await expect(readHostedPurchaseCounts([ID_A, ID_B])).resolves.toEqual({
      [ID_A]: 27,
      [ID_B]: 0,
    });
    kv.kvMget.mockResolvedValue({ ok: true, value: ['-3', 'abc'] });
    await expect(readHostedPurchaseCounts([ID_A, ID_B])).resolves.toEqual({
      [ID_A]: 0,
      [ID_B]: 0,
    });
  });

  it('KV 障害時は全件 0 (一覧を止めない)・空入力は KV を読まない', async () => {
    kv.kvMget.mockRejectedValue(new Error('kv down'));
    await expect(readHostedPurchaseCounts([ID_A])).resolves.toEqual({
      [ID_A]: 0,
    });
    kv.kvMget.mockReset();
    await expect(readHostedPurchaseCounts([])).resolves.toEqual({});
    expect(kv.kvMget).not.toHaveBeenCalled();
  });
});
