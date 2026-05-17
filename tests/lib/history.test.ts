import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendHistory,
  buildHistoryEntry,
  clearHistory,
  formatHistoryTimestamp,
  HISTORY_CHANGED_EVENT,
  HISTORY_MAX_ENTRIES,
  HISTORY_STORAGE_KEY,
  loadHistory,
  removeHistoryEntry,
  type BuildHistoryBase,
  type HistoryEntry,
} from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'test-id',
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10',
    txHash: '0xTx',
    userOpHash: '0xUserOp',
    blockNumber: '12345',
    errorMessage: null,
    storeName: 'Test Store',
    note: '',
    ...overrides,
  };
}

describe('history (LocalStorage)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('loadHistory', () => {
    it('空 LocalStorage → []', () => {
      expect(loadHistory()).toEqual([]);
    });

    it('既存 valid entries を復元する', () => {
      const e1 = entry({ id: 'a' });
      const e2 = entry({ id: 'b', txHash: '0xTx2' });
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([e1, e2]));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('a');
      expect(loaded[1].id).toBe('b');
    });

    it('not-json → [] (storage.safeGet が try/catch)', () => {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, 'not-json{{{');
      expect(loadHistory()).toEqual([]);
    });

    it('非 array (object) → []', () => {
      window.localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify({ foo: 'bar' }),
      );
      expect(loadHistory()).toEqual([]);
    });

    it('一部 entry が schema 不一致 → 有効分のみ復元', () => {
      const valid = entry({ id: 'good' });
      const invalid = { id: 123, ts: 'no', flow: 'unknown-flow' };
      window.localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify([valid, invalid, null, 'string', 42]),
      );
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('good');
    });

    it.each(['batch', 'direct', 'standard-merchant', 'standard-fee'] as const)(
      'flow=%s は valid と判定される',
      (flow) => {
        window.localStorage.setItem(
          HISTORY_STORAGE_KEY,
          JSON.stringify([entry({ flow })]),
        );
        expect(loadHistory()).toHaveLength(1);
      },
    );

    it.each(['success', 'reverted', 'error'] as const)(
      'status=%s は valid と判定される',
      (status) => {
        window.localStorage.setItem(
          HISTORY_STORAGE_KEY,
          JSON.stringify([entry({ status })]),
        );
        expect(loadHistory()).toHaveLength(1);
      },
    );

    it('gasMode=null は valid (standard モード想定)', () => {
      window.localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify([entry({ gasMode: null, payMode: 'standard' })]),
      );
      expect(loadHistory()).toHaveLength(1);
    });
  });

  describe('appendHistory', () => {
    it('空 → 1 件目を append', () => {
      appendHistory(entry({ id: 'one' }));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('one');
    });

    it('新しい entry は先頭に入る (新しい順)', () => {
      appendHistory(entry({ id: 'first' }));
      appendHistory(entry({ id: 'second' }));
      const loaded = loadHistory();
      expect(loaded.map((e) => e.id)).toEqual(['second', 'first']);
    });

    it('同一 id を二重 append → 重複しない (dedupe)', () => {
      appendHistory(entry({ id: 'dup' }));
      appendHistory(entry({ id: 'dup', merchantAmount: '999' }));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      // 既存値を保持 (新しい値で上書きしない — React StrictMode 二重発火吸収)
      expect(loaded[0].merchantAmount).toBe('1000');
    });

    it(`${HISTORY_MAX_ENTRIES} 件超過時は古いものから削除 (FIFO)`, () => {
      // appendHistory は newest-at-front の規約。seed 配列はそれを満たすよう
      // index 0 = newest、index 999 = oldest として直接 setItem する。
      const seed = Array.from({ length: HISTORY_MAX_ENTRIES }, (_, i) =>
        entry({ id: `seed-${i}` }),
      );
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(seed));

      appendHistory(entry({ id: 'overflow' }));

      const loaded = loadHistory();
      expect(loaded).toHaveLength(HISTORY_MAX_ENTRIES);
      expect(loaded[0].id).toBe('overflow');
      // newest-at-front + slice(0, MAX) → tail (oldest = seed-999) が drop
      expect(loaded.find((e) => e.id === 'seed-999')).toBeUndefined();
      // 直前まで newest (seed-0) は残る
      expect(loaded.find((e) => e.id === 'seed-0')).toBeDefined();
    });

    it('CustomEvent (HISTORY_CHANGED_EVENT) を dispatch する (自タブ同期)', () => {
      const handler = vi.fn();
      window.addEventListener(HISTORY_CHANGED_EVENT, handler);
      appendHistory(entry({ id: 'x' }));
      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener(HISTORY_CHANGED_EVENT, handler);
    });

    it('dedupe で no-op の場合は CustomEvent を発火しない', () => {
      appendHistory(entry({ id: 'same' }));
      const handler = vi.fn();
      window.addEventListener(HISTORY_CHANGED_EVENT, handler);
      appendHistory(entry({ id: 'same' }));
      expect(handler).not.toHaveBeenCalled();
      window.removeEventListener(HISTORY_CHANGED_EVENT, handler);
    });
  });

  describe('removeHistoryEntry', () => {
    it('指定 id を削除', () => {
      appendHistory(entry({ id: 'keep' }));
      appendHistory(entry({ id: 'drop' }));
      removeHistoryEntry('drop');
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('keep');
    });

    it('存在しない id の削除 → no-op (event 発火なし)', () => {
      appendHistory(entry({ id: 'a' }));
      const handler = vi.fn();
      window.addEventListener(HISTORY_CHANGED_EVENT, handler);
      removeHistoryEntry('not-exist');
      expect(handler).not.toHaveBeenCalled();
      expect(loadHistory()).toHaveLength(1);
      window.removeEventListener(HISTORY_CHANGED_EVENT, handler);
    });

    it('削除は CustomEvent を発火する', () => {
      appendHistory(entry({ id: 'go' }));
      const handler = vi.fn();
      window.addEventListener(HISTORY_CHANGED_EVENT, handler);
      removeHistoryEntry('go');
      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener(HISTORY_CHANGED_EVENT, handler);
    });
  });

  describe('clearHistory', () => {
    it('全削除', () => {
      appendHistory(entry({ id: 'x' }));
      appendHistory(entry({ id: 'y' }));
      clearHistory();
      expect(loadHistory()).toEqual([]);
    });

    it('clearHistory は CustomEvent を発火する', () => {
      const handler = vi.fn();
      window.addEventListener(HISTORY_CHANGED_EVENT, handler);
      clearHistory();
      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener(HISTORY_CHANGED_EVENT, handler);
    });
  });

  describe('buildHistoryEntry', () => {
    function base(overrides: Partial<BuildHistoryBase> = {}): BuildHistoryBase {
      return {
        flow: 'batch',
        status: 'success',
        chainId: 137,
        chainSlug: 'polygon',
        asset: 'jpyc',
        tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
        payMode: 'gasless',
        gasMode: 'customer',
        merchant: '0xMerchant',
        merchantAmount: 1000n,
        customer: '0xCustomer',
        feeReceiver: '0xFee',
        feeAmount: 10n,
        txHash: '0xTx',
        userOpHash: '0xUserOp',
        blockNumber: 12345n,
        errorMessage: null,
        storeName: 'Test Store',
        ...overrides,
      };
    }

    it('txHash あり → id="<flow>-<txHash>"', () => {
      const e = buildHistoryEntry(base());
      expect(e.id).toBe('batch-0xTx');
    });

    it('txHash null, userOpHash あり → id="<flow>-uo-<userOpHash>"', () => {
      const e = buildHistoryEntry(base({ txHash: null, userOpHash: '0xUO' }));
      expect(e.id).toBe('batch-uo-0xUO');
    });

    it('hash 全て無し → id="<flow>-err-<ts>"', () => {
      const e = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null }),
        ts: 999,
      });
      expect(e.id).toBe('batch-err-999');
    });

    it('bigint fields → string 化される (JSON 互換)', () => {
      const e = buildHistoryEntry(
        base({ merchantAmount: 12345n, feeAmount: 67n, blockNumber: 8n }),
      );
      expect(e.merchantAmount).toBe('12345');
      expect(e.feeAmount).toBe('67');
      expect(e.blockNumber).toBe('8');
    });

    it('null bigint (feeAmount/blockNumber) は null のまま保持', () => {
      const e = buildHistoryEntry(base({ feeAmount: null, blockNumber: null }));
      expect(e.feeAmount).toBeNull();
      expect(e.blockNumber).toBeNull();
    });

    it('customer=undefined → null に正規化', () => {
      const e = buildHistoryEntry(base({ customer: undefined }));
      expect(e.customer).toBeNull();
    });

    it('ts 省略時は Date.now() を使う', () => {
      const before = Date.now();
      const e = buildHistoryEntry(base({ txHash: null, userOpHash: null }));
      const after = Date.now();
      expect(e.ts).toBeGreaterThanOrEqual(before);
      expect(e.ts).toBeLessThanOrEqual(after);
    });

    it('note 省略時は空文字列で初期化される', () => {
      const e = buildHistoryEntry(base());
      expect(e.note).toBe('');
    });

    it('note 指定時はそのまま保持 (CheckoutForm の orderId 等)', () => {
      const e = buildHistoryEntry({ ...base(), note: 'order-42 / 黒コーヒー' });
      expect(e.note).toBe('order-42 / 黒コーヒー');
    });
  });

  describe('FIFO 境界 (HISTORY_MAX_ENTRIES = 1000 ちょうど)', () => {
    it('999 件 + append 1 → 1000 件、最古は残る (1000 < MAX なので eviction なし)', () => {
      const seed = Array.from({ length: 999 }, (_, i) =>
        entry({ id: `s-${i}` }),
      );
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(seed));
      appendHistory(entry({ id: 'new' }));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1000);
      // 最古 (seed-998 = index 998) も残る
      expect(loaded.find((e) => e.id === 's-998')).toBeDefined();
      expect(loaded[0].id).toBe('new');
    });

    it('1000 件 ちょうど + append 1 → 1000 件、最古 1 件 evict', () => {
      const seed = Array.from({ length: 1000 }, (_, i) =>
        entry({ id: `s-${i}` }),
      );
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(seed));
      appendHistory(entry({ id: 'new' }));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1000);
      // 最古 (index 999 = tail) は evict
      expect(loaded.find((e) => e.id === 's-999')).toBeUndefined();
      // ひとつ前 (index 998) は残る
      expect(loaded.find((e) => e.id === 's-998')).toBeDefined();
    });

    it('1500 件が既に入っている (壊れた状態) + append 1 → 1000 件に圧縮', () => {
      // 直接 seed を仕込んだ MAX 超過状態を後から append が修復する想定
      const seed = Array.from({ length: 1500 }, (_, i) =>
        entry({ id: `s-${i}` }),
      );
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(seed));
      appendHistory(entry({ id: 'fix' }));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1000);
      expect(loaded[0].id).toBe('fix');
    });
  });

  describe('SSR / defensive', () => {
    it('appendHistory: window 不在 (SSR) → no-op、throw しない', () => {
      const realWindow = global.window;
      // @ts-expect-error - SSR 環境シミュレーション
      delete global.window;
      expect(() =>
        appendHistory(entry({ id: 'ssr' })),
      ).not.toThrow();
      global.window = realWindow;
      // LocalStorage には何も入らない
      expect(realWindow.localStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull();
    });

    it('loadHistory: window 不在 → [] を返す', () => {
      const realWindow = global.window;
      // @ts-expect-error - SSR 環境シミュレーション
      delete global.window;
      expect(loadHistory()).toEqual([]);
      global.window = realWindow;
    });

    it('safeSet が throw (QuotaExceededError) → appendHistory は throw せず、既存値が保持される', () => {
      const seed = [entry({ id: 'keep' })];
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(seed));
      const setItemSpy = vi
        .spyOn(window.localStorage.__proto__, 'setItem')
        .mockImplementation(() => {
          const err = new Error('QuotaExceededError');
          err.name = 'QuotaExceededError';
          throw err;
        });
      expect(() => appendHistory(entry({ id: 'too-big' }))).not.toThrow();
      // 既存値が残る (削除されていない)
      setItemSpy.mockRestore();
      const loaded = loadHistory();
      expect(loaded.some((e) => e.id === 'keep')).toBe(true);
      // 新規 append は捨てられる
      expect(loaded.some((e) => e.id === 'too-big')).toBe(false);
    });
  });

  describe('並行 append (同期 race の境界)', () => {
    it('同一 id を 100 回 append → 1 件しか残らない (dedupe O(N))', () => {
      for (let i = 0; i < 100; i += 1) {
        appendHistory(entry({ id: 'same-id' }));
      }
      expect(loadHistory()).toHaveLength(1);
    });

    it('100 件の異なる id を append → 全件保存、新しい順', () => {
      for (let i = 0; i < 100; i += 1) {
        appendHistory(entry({ id: `seq-${i}`, ts: 1_000_000_000_000 + i }));
      }
      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // 最後に append した seq-99 が先頭、最古 seq-0 が末尾
      expect(loaded[0].id).toBe('seq-99');
      expect(loaded[99].id).toBe('seq-0');
    });
  });

  describe('formatHistoryTimestamp', () => {
    // 環境依存 (system timezone) を避けるため、結果の形式のみ検証する。
    afterEach(() => {
      vi.useRealTimers();
    });

    it('yyyy-MM-dd HH:mm:ss (ゼロ詰め) で出る', () => {
      // 2026-05-17 09:05:03 (system tz)
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 4, 17, 9, 5, 3));
      const out = formatHistoryTimestamp(Date.now());
      expect(out).toBe('2026-05-17 09:05:03');
    });

    it('ms input でも秒精度に丸めて出力', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59, 999));
      const out = formatHistoryTimestamp(Date.now());
      expect(out).toBe('2026-12-31 23:59:59');
    });
  });
});
