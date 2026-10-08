import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from '@/lib/logger';
import {
  STORE_GAS_WALLET_STORAGE_KEY,
  createStoreGasWallet,
  estimateRemainingSends,
  STORE_GAS_SETTLE_GAS_ESTIMATE,
  loadStoreGasWallet,
  readStoreGasWalletKey,
  STORE_GAS_TOPUP_KEY,
  clearStoreGasTopUp,
  hasPendingStoreGasTopUp,
  markStoreGasTopUp,
  removeStoreGasWallet,
  requestStoreGasWalletPersistence,
  storeGasFundGuide,
  storeGasFundRange,
  withStoreGasWalletLock,
  withdrawableAmount,
} from '@/lib/storeGasWallet';

const OTHER = '0x1111111111111111111111111111111111111111';

describe('storeGasWallet: 鍵の作成・保存・削除', () => {
  beforeEach(() => window.localStorage.clear());

  it('作った鍵を保存し、公開情報だけを返す (鍵は送る直前に読む)', () => {
    const r = createStoreGasWallet(1_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info).toEqual({ address: r.info.address, createdAt: 1_000 });
    expect(JSON.stringify(r)).not.toContain('privateKey');
    expect(loadStoreGasWallet()).toEqual({ state: 'ok', info: r.info });
    const key = readStoreGasWalletKey(r.info.address);
    expect(key && privateKeyToAccount(key).address).toBe(r.info.address);
    expect(readStoreGasWalletKey(OTHER)).toBeNull();
  });

  it('既に鍵があるときは上書きしない', () => {
    const first = createStoreGasWallet();
    expect(createStoreGasWallet()).toEqual({ ok: false, reason: 'already_exists' });
    expect(first.ok && loadStoreGasWallet()).toEqual(first.ok && { state: 'ok', info: first.info });
  });

  it.each([
    ['壊れた JSON', '{"v":1,"privateKey":"0xabc'],
    ['欠けた値', '{"v":1}'],
    ['ゼロの鍵 (曲線の範囲外)', JSON.stringify({ v: 1, privateKey: `0x${'0'.repeat(64)}`, address: OTHER, createdAt: 1 })],
  ])('%s は「壊れている」と扱い、上に新しい鍵を作らない (入っている POL を失わない)', (_, raw) => {
    window.localStorage.setItem(STORE_GAS_WALLET_STORAGE_KEY, raw);
    expect(loadStoreGasWallet()).toEqual({ state: 'corrupt' });
    expect(createStoreGasWallet()).toEqual({ ok: false, reason: 'corrupt' });
    expect(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)).toBe(raw);
  });

  it('鍵とアドレスが食い違う値は「壊れている」', () => {
    const r = createStoreGasWallet();
    if (!r.ok) throw new Error('setup');
    const stored = JSON.parse(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)!);
    window.localStorage.setItem(STORE_GAS_WALLET_STORAGE_KEY, JSON.stringify({ ...stored, address: OTHER }));
    expect(loadStoreGasWallet()).toEqual({ state: 'corrupt' });
    expect(readStoreGasWalletKey(OTHER)).toBeNull();
  });

  it('壊れた値を読んでも、保存内容の断片をログに出さない', () => {
    const fragment = 'deadbeefcafebabe';
    window.localStorage.setItem(STORE_GAS_WALLET_STORAGE_KEY, `{"v":1,"privateKey":"0x${fragment}`);
    const spies = [
      vi.spyOn(logger, 'warn'),
      vi.spyOn(logger, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    try {
      loadStoreGasWallet();
      createStoreGasWallet();
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(fragment);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('ストレージを読めない端末は「読めない」と扱い、作らない', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(loadStoreGasWallet()).toEqual({ state: 'unavailable' });
      expect(createStoreGasWallet()).toEqual({ ok: false, reason: 'storage_unavailable' });
    } finally {
      spy.mockRestore();
    }
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

  it('消せたときだけ true (消せなかったのに「未作成」に戻さない)', () => {
    createStoreGasWallet();
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(removeStoreGasWallet()).toBe(false);
      expect(loadStoreGasWallet().state).toBe('ok');
    } finally {
      spy.mockRestore();
    }
    expect(removeStoreGasWallet()).toBe(true);
    expect(loadStoreGasWallet()).toEqual({ state: 'none' });
  });

  it('Web Locks があれば同じ名前のロックで直列化する', async () => {
    const request = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    const original = (navigator as { locks?: unknown }).locks;
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      await expect(withStoreGasWalletLock(async () => 42)).resolves.toBe(42);
      expect(request).toHaveBeenCalledWith('openpay:store-gas-wallet', expect.any(Function));
    } finally {
      Object.defineProperty(navigator, 'locks', { value: original, configurable: true });
    }
  });
});

describe('storeGasWallet: 残り回数と戻せる額', () => {
  it('残り回数 = 残高 ÷ (ガス価格 × 目安ガス 20 万)・0 以下は 0', () => {
    // 30 gwei × 20 万 = 0.006 POL/回 → 1 POL で 166 回 (Amoy 実測 gasUsed 15.6〜17.4 万を少し多めに見積もる)
    expect(STORE_GAS_SETTLE_GAS_ESTIMATE).toBe(200_000n);
    expect(estimateRemainingSends(10n ** 18n, 30n * 10n ** 9n)).toBe(166);
    expect(estimateRemainingSends(0n, 30n * 10n ** 9n)).toBe(0);
    expect(estimateRemainingSends(10n ** 18n, 0n)).toBe(0);
  });

  it('戻せる額 = 残高 − gas × maxFeePerGas・足りなければ 0', () => {
    expect(withdrawableAmount(10n ** 18n, 21_000n, 100n * 10n ** 9n)).toBe(10n ** 18n - 21_000n * 100n * 10n ** 9n);
    expect(withdrawableAmount(1_000n, 21_000n, 1n)).toBe(0n);
  });
});

describe('storeGasWallet: 入れておく目安', () => {
  it('表示 (1〜2) と数値 (補充の既定額・1 回の上限) は同じ表から・表に無いチェーンは空/null', () => {
    expect(storeGasFundRange(137)).toEqual({ min: '1', max: '2' });
    expect(storeGasFundGuide(137)).toBe('1〜2');
    expect(storeGasFundRange(43114)).toEqual({ min: '0.05', max: '0.1' });
    expect(storeGasFundGuide(43114)).toBe('0.05〜0.1');
    for (const id of [137, 80002, 8217, 1001, 43114, 43113]) {
      const r = storeGasFundRange(id)!;
      expect(Number(r.min)).toBeGreaterThan(0);
      expect(Number(r.max)).toBeGreaterThanOrEqual(Number(r.min));
    }
    expect(storeGasFundRange(1)).toBeNull();
    expect(storeGasFundGuide(1)).toBe('');
  });
});

describe('storeGasWallet: 消されにくい保存を頼む (navigator.storage.persist)', () => {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'storage');
  const ADDR = '0x0000000000000000000000000000000000000abc' as const;
  function setStorage(value: unknown) {
    Object.defineProperty(window.navigator, 'storage', { value, configurable: true });
  }
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    if (original) Object.defineProperty(window.navigator, 'storage', original);
    else delete (window.navigator as { storage?: unknown }).storage;
  });

  it('認められていればそのまま true・まだなら頼んで結果を返す', async () => {
    const persist = vi.fn(async () => true);
    setStorage({ persisted: async () => true, persist });
    expect(await requestStoreGasWalletPersistence(ADDR)).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    setStorage({ persisted: async () => false, persist: vi.fn(async () => false) });
    expect(await requestStoreGasWalletPersistence(ADDR)).toBe(false);
  });

  it('頼むのは鍵ごとに 1 回だけ (Firefox で開くたびに許可を尋ねない)・新しい鍵ではもう一度頼む', async () => {
    const persist = vi.fn(async () => false);
    setStorage({ persisted: async () => false, persist });
    await requestStoreGasWalletPersistence(ADDR);
    await requestStoreGasWalletPersistence(ADDR);
    expect(persist).toHaveBeenCalledTimes(1);
    await requestStoreGasWalletPersistence('0x0000000000000000000000000000000000000def');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('頼めない・失敗しても throw しない (鍵の作成や表示を止めない)', async () => {
    setStorage(undefined);
    expect(await requestStoreGasWalletPersistence(ADDR)).toBeNull();
    setStorage({ persist: async () => { throw new Error('denied'); } });
    expect(await requestStoreGasWalletPersistence(ADDR)).toBeNull();
  });
});

describe('storeGasWallet: 補充の途中の印 (別のタブの「消す」を止める)', () => {
  const ADDR = '0x0000000000000000000000000000000000000abc' as const;
  const OTHER_ADDR = '0x0000000000000000000000000000000000000def' as const;
  beforeEach(() => window.localStorage.clear());

  it('置くと 30 分は途中・同じアドレスの印だけを外す', () => {
    expect(markStoreGasTopUp(ADDR, 1_000)).toBe(true);
    expect(hasPendingStoreGasTopUp(ADDR, 1_000 + 29 * 60_000)).toBe(true);
    expect(hasPendingStoreGasTopUp(ADDR, 1_000 + 30 * 60_000)).toBe(false); // タブを閉じても残り続けない
    expect(hasPendingStoreGasTopUp(OTHER_ADDR, 1_000)).toBe(false);
    clearStoreGasTopUp(OTHER_ADDR); // 別のアドレスの印は外さない
    expect(hasPendingStoreGasTopUp(ADDR, 1_000)).toBe(true);
    clearStoreGasTopUp(ADDR);
    expect(hasPendingStoreGasTopUp(ADDR, 1_000)).toBe(false);
  });

  it('印を読めないときは途中とみなす (迷ったら消さない)・置けないときは false (補充しない)', () => {
    window.localStorage.setItem(STORE_GAS_TOPUP_KEY, '{broken');
    expect(hasPendingStoreGasTopUp(ADDR)).toBe(true);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(markStoreGasTopUp(ADDR)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
