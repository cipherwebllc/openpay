import { describe, it, expect, beforeEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  STORE_GAS_WALLET_STORAGE_KEY,
  createStoreGasWallet,
  estimateRemainingSends,
  loadStoreGasWallet,
  removeStoreGasWallet,
  withdrawableAmount,
} from '@/lib/storeGasWallet';

describe('storeGasWallet: 鍵の作成・保存・削除', () => {
  beforeEach(() => window.localStorage.clear());

  it('作った鍵を保存し、読み戻せる (アドレスは鍵から導いたもの)', () => {
    const r = createStoreGasWallet(1_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wallet.address).toBe(privateKeyToAccount(r.wallet.privateKey).address);
    expect(loadStoreGasWallet()).toEqual(r.wallet);
  });

  it('既に鍵があるときは上書きしない (入っている POL を失わない)', () => {
    const first = createStoreGasWallet();
    const second = createStoreGasWallet();
    expect(second).toEqual({ ok: false, reason: 'already_exists' });
    expect(first.ok && loadStoreGasWallet()?.privateKey).toBe(first.ok && first.wallet.privateKey);
  });

  it('保存できない端末では成功にしない (アドレスを見せて POL を入れた後に鍵が消える偽成功を断つ)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(createStoreGasWallet()).toEqual({ ok: false, reason: 'storage_unavailable' });
    } finally {
      spy.mockRestore();
    }
  });

  it('壊れた値・鍵とアドレスが食い違う値は使わない', () => {
    window.localStorage.setItem(STORE_GAS_WALLET_STORAGE_KEY, '{"v":1}');
    expect(loadStoreGasWallet()).toBeNull();
    const r = createStoreGasWallet();
    if (!r.ok) throw new Error('setup');
    window.localStorage.setItem(
      STORE_GAS_WALLET_STORAGE_KEY,
      JSON.stringify({ ...r.wallet, address: '0x1111111111111111111111111111111111111111' }),
    );
    expect(loadStoreGasWallet()).toBeNull();
  });

  it('消すと読めなくなる', () => {
    createStoreGasWallet();
    removeStoreGasWallet();
    expect(loadStoreGasWallet()).toBeNull();
  });
});

describe('storeGasWallet: 残り回数と戻せる額', () => {
  it('残り回数 = 残高 ÷ (ガス価格 × 150,000)・0 以下は 0', () => {
    // 30 gwei × 150k = 0.0045 POL/回 → 1 POL で 222 回
    expect(estimateRemainingSends(10n ** 18n, 30n * 10n ** 9n)).toBe(222);
    expect(estimateRemainingSends(0n, 30n * 10n ** 9n)).toBe(0);
    expect(estimateRemainingSends(10n ** 18n, 0n)).toBe(0);
  });

  it('戻せる額 = 残高 − gas × maxFeePerGas・足りなければ 0', () => {
    expect(withdrawableAmount(10n ** 18n, 21_000n, 100n * 10n ** 9n)).toBe(10n ** 18n - 21_000n * 100n * 10n ** 9n);
    expect(withdrawableAmount(1_000n, 21_000n, 1n)).toBe(0n);
  });
});
