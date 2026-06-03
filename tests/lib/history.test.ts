import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendHistory,
  buildHistoryEntry,
  clearHistory,
  formatHistoryTimestamp,
  HISTORY_CHANGED_EVENT,
  HISTORY_MAX_ENTRIES,
  HISTORY_STORAGE_KEY,
  LATEST_SCHEMA_VERSION,
  loadHistory,
  migrateToLatest,
  MIGRATIONS,
  removeHistoryEntry,
  type BuildHistoryBase,
  type HistoryEntry,
  type MigrationFn,
} from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: LATEST_SCHEMA_VERSION,
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
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: null,
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
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

    it('v4: anchor (元価格建て + FX レート) を記録する', () => {
      const e = buildHistoryEntry(
        base({
          anchorAmount: '1000',
          anchorSymbol: 'jpyc',
          fxRateUsdcJpy: '156.32',
        }),
      );
      expect(e.anchorAmount).toBe('1000');
      expect(e.anchorSymbol).toBe('jpyc');
      expect(e.fxRateUsdcJpy).toBe('156.32');
    });

    it('v4: anchor 省略時は null (通常決済)', () => {
      const e = buildHistoryEntry(base());
      expect(e.anchorAmount).toBeNull();
      expect(e.anchorSymbol).toBeNull();
      expect(e.fxRateUsdcJpy).toBeNull();
    });

    it('txHash null, userOpHash あり → id="<flow>-uo-<userOpHash>"', () => {
      const e = buildHistoryEntry(base({ txHash: null, userOpHash: '0xUO' }));
      expect(e.id).toBe('batch-uo-0xUO');
    });

    it('hash 全て無し → id="<flow>-err-<seconds>-<msg seed>"', () => {
      const e = buildHistoryEntry({
        ...base({
          txHash: null,
          userOpHash: null,
          errorMessage: 'paymaster rejected',
        }),
        ts: 1_700_000_000_000, // 1_700_000_000 秒
      });
      expect(e.id).toBe('batch-err-1700000000-paymaster rejected');
    });

    it('error id: errorMessage null → "noerr" seed', () => {
      const e = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: null }),
        ts: 1_700_000_000_500,
      });
      expect(e.id).toBe('batch-err-1700000000-noerr');
    });

    it('error id: errorMessage は 32 文字に truncate', () => {
      const e = buildHistoryEntry({
        ...base({
          txHash: null,
          userOpHash: null,
          errorMessage: 'X'.repeat(100),
        }),
        ts: 1_700_000_000_000,
      });
      // seed は 32 文字の X
      expect(e.id).toBe(`batch-err-1700000000-${'X'.repeat(32)}`);
    });

    it('error id: 同秒内の二重 build (StrictMode 二重発火想定) は同一 id', () => {
      const ts1 = 1_700_000_000_100;
      const ts2 = 1_700_000_000_900; // 同秒内 (Math.floor で 1700000000)
      const e1 = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: 'same' }),
        ts: ts1,
      });
      const e2 = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: 'same' }),
        ts: ts2,
      });
      expect(e1.id).toBe(e2.id);
    });

    it('error id: 秒またぎ (1.5 秒差) では別 id (= 別 retry として記録)', () => {
      const ts1 = 1_700_000_000_500;
      const ts2 = 1_700_000_002_000; // +1.5s
      const e1 = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: 'same' }),
        ts: ts1,
      });
      const e2 = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: 'same' }),
        ts: ts2,
      });
      expect(e1.id).not.toBe(e2.id);
    });

    it('error id: 同秒内 + 異 errorMessage → 別 id', () => {
      const ts = 1_700_000_000_000;
      const e1 = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: 'A' }),
        ts,
      });
      const e2 = buildHistoryEntry({
        ...base({ txHash: null, userOpHash: null, errorMessage: 'B' }),
        ts,
      });
      expect(e1.id).not.toBe(e2.id);
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

    it('note: 1000 文字 cap (URL params.description からの肥大化防止)', () => {
      const e = buildHistoryEntry({ ...base(), note: 'X'.repeat(5000) });
      expect(e.note.length).toBe(1000);
      expect(e.note).toBe('X'.repeat(1000));
    });

    it('note: 1000 文字ジャストはそのまま保持', () => {
      const e = buildHistoryEntry({ ...base(), note: 'A'.repeat(1000) });
      expect(e.note.length).toBe(1000);
    });

    it('errorMessage: 500 文字 cap (buildHistoryEntry 内 2 段目の防壁)', () => {
      const e = buildHistoryEntry({
        ...base({ errorMessage: 'E'.repeat(2000) }),
      });
      expect(e.errorMessage?.length).toBe(500);
    });

    it('errorMessage null は null のまま', () => {
      const e = buildHistoryEntry({ ...base({ errorMessage: null }) });
      expect(e.errorMessage).toBeNull();
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

  describe('StrictMode 二重発火 dedupe (error entry の dev mode 防御)', () => {
    it('同 errorMessage を 2 回 appendHistory → 同秒なら 1 件に dedupe', () => {
      const ts = 1_700_000_000_000;
      const e = buildHistoryEntry({
        flow: 'batch',
        status: 'error',
        chainId: 137,
        chainSlug: 'polygon',
        asset: 'jpyc',
        tokenAddress: '0xT',
        payMode: 'gasless',
        gasMode: 'customer',
        merchant: '0xM',
        merchantAmount: 0n,
        customer: '0xC',
        feeReceiver: '0xF',
        feeAmount: 0n,
        txHash: null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: 'wallet rejected',
        storeName: '',
        ts,
      });
      appendHistory(e);
      // 同 ts → 同 id を改めて build → dedupe で 1 件のまま
      const eAgain = buildHistoryEntry({
        flow: 'batch',
        status: 'error',
        chainId: 137,
        chainSlug: 'polygon',
        asset: 'jpyc',
        tokenAddress: '0xT',
        payMode: 'gasless',
        gasMode: 'customer',
        merchant: '0xM',
        merchantAmount: 0n,
        customer: '0xC',
        feeReceiver: '0xF',
        feeAmount: 0n,
        txHash: null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: 'wallet rejected',
        storeName: '',
        ts: ts + 500, // 同秒内
      });
      appendHistory(eAgain);
      expect(loadHistory()).toHaveLength(1);
    });

    it('1.5 秒 開けて再 appendHistory → 2 件 (ユーザ retry として記録)', () => {
      const base = (ts: number, errorMessage: string) =>
        buildHistoryEntry({
          flow: 'batch',
          status: 'error',
          chainId: 137,
          chainSlug: 'polygon',
          asset: 'jpyc',
          tokenAddress: '0xT',
          payMode: 'gasless',
          gasMode: 'customer',
          merchant: '0xM',
          merchantAmount: 0n,
          customer: '0xC',
          feeReceiver: '0xF',
          feeAmount: 0n,
          txHash: null,
          userOpHash: null,
          blockNumber: null,
          errorMessage,
          storeName: '',
          ts,
        });
      appendHistory(base(1_700_000_000_000, 'same'));
      appendHistory(base(1_700_000_001_500, 'same')); // +1.5s
      expect(loadHistory()).toHaveLength(2);
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

  describe('schema migration framework', () => {
    // 実 MIGRATIONS (v1→v2 が登録済) を退避し、fake migration を足すテストの後に復元する。
    const ORIGINAL_MIGRATIONS = { ...MIGRATIONS };
    afterEach(() => {
      for (const k of Object.keys(MIGRATIONS)) {
        delete (MIGRATIONS as Record<number, MigrationFn>)[Number(k)];
      }
      Object.assign(MIGRATIONS, ORIGINAL_MIGRATIONS);
    });

    describe('buildHistoryEntry が常に LATEST_SCHEMA_VERSION を stamp', () => {
      it('新規 entry は schemaVersion = LATEST_SCHEMA_VERSION (= 3)', () => {
        const base: BuildHistoryBase = {
          flow: 'batch',
          status: 'success',
          chainId: 137,
          chainSlug: 'polygon',
          asset: 'jpyc',
          tokenAddress: '0xT',
          payMode: 'gasless',
          gasMode: 'customer',
          merchant: '0xM',
          merchantAmount: 1n,
          customer: '0xC',
          feeReceiver: '0xF',
          feeAmount: 0n,
          txHash: '0xTx',
          userOpHash: '0xUO',
          blockNumber: 1n,
          errorMessage: null,
          storeName: '',
        };
        expect(buildHistoryEntry(base).schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(buildHistoryEntry(base).schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        // 新規 entry の v2 フィールドは provider 未指定なら null backfill。
        const built = buildHistoryEntry(base);
        expect(built.provider).toBeNull();
        expect(built.circlePaymasterAddress).toBeNull();
        expect(built.circlePaymasterNetUsdc).toBeNull();
        expect(built.circleVerification).toBeNull();
      });

      it('circle 経路の entry は provider/paymaster/net/verification を保持', () => {
        const built = buildHistoryEntry({
          flow: 'batch',
          status: 'success',
          chainId: 421614,
          chainSlug: 'arbitrum',
          asset: 'usdc',
          tokenAddress: '0xT',
          payMode: 'gasless',
          gasMode: 'customer',
          merchant: '0xM',
          merchantAmount: 1n,
          customer: '0xC',
          feeReceiver: '0xF',
          feeAmount: 0n,
          txHash: '0xTx',
          userOpHash: '0xUO',
          blockNumber: 1n,
          errorMessage: null,
          storeName: '',
          provider: 'circle',
          circlePaymasterAddress: '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
          circlePaymasterNetUsdc: '9000',
          circleVerification: 'client-reported',
        });
        expect(built.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(built.provider).toBe('circle');
        expect(built.circlePaymasterNetUsdc).toBe('9000');
        expect(built.circleVerification).toBe('client-reported');
      });
    });

    describe('migrateToLatest', () => {
      it('schemaVersion = LATEST → そのまま valid なら通す', () => {
        const e = entry({ id: 'a' });
        const out = migrateToLatest(e);
        expect(out).not.toBeNull();
        expect(out?.id).toBe('a');
        expect(out?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      });

      it('実 v1 entry (Circle フィールド無し) → v2 へ null backfill で生存', () => {
        // v2 フィールドを持たない正真正銘の v1 entry を構築。
        const e = entry({ id: 'real-v1' });
        const v1: Record<string, unknown> = { ...e, schemaVersion: 1 };
        delete v1.provider;
        delete v1.circlePaymasterAddress;
        delete v1.circlePaymasterNetUsdc;
        delete v1.circleVerification;
        const out = migrateToLatest(v1);
        expect(out).not.toBeNull();
        expect(out?.id).toBe('real-v1');
        expect(out?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        // drop されず null backfill される (v2 circle フィールド)
        expect(out?.provider).toBeNull();
        expect(out?.circlePaymasterAddress).toBeNull();
        expect(out?.circlePaymasterNetUsdc).toBeNull();
        expect(out?.circleVerification).toBeNull();
        // v3 fee/gas 分離フィールドも null/内訳不明で backfill される
        expect(out?.saleAmount).toBeNull();
        expect(out?.networkFeeEquivalent).toBeNull();
        expect(out?.feeBreakdownVersion).toBe(0);
      });

      it('実 v2 entry (fee/gas 分離前) → v3 へ null/内訳不明 backfill で生存', () => {
        // v3 フィールドを持たない正真正銘の v2 entry を構築 (circle フィールドは在る)。
        const e = entry({ id: 'real-v2', feeAmount: '4000' });
        const v2: Record<string, unknown> = { ...e, schemaVersion: 2 };
        delete v2.saleAmount;
        delete v2.networkFeeEquivalent;
        delete v2.feeBreakdownVersion;
        const out = migrateToLatest(v2);
        expect(out).not.toBeNull();
        expect(out?.id).toBe('real-v2');
        expect(out?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        // 後付けで分離できないため null backfill + 内訳不明印 (集計から除外される)。
        expect(out?.saleAmount).toBeNull();
        expect(out?.networkFeeEquivalent).toBeNull();
        expect(out?.feeBreakdownVersion).toBe(0);
        // 旧 feeAmount (conflated) はそのまま保持 (HistoryRow が legacy heuristic を適用)。
        expect(out?.feeAmount).toBe('4000');
      });

      it('実 v3 entry (anchor 前) → v4 へ anchor=null backfill で生存', () => {
        const e = entry({ id: 'real-v3' });
        const v3: Record<string, unknown> = { ...e, schemaVersion: 3 };
        delete v3.anchorAmount;
        delete v3.anchorSymbol;
        delete v3.fxRateUsdcJpy;
        const out = migrateToLatest(v3);
        expect(out).not.toBeNull();
        expect(out?.id).toBe('real-v3');
        expect(out?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(out?.anchorAmount).toBeNull();
        expect(out?.anchorSymbol).toBeNull();
        expect(out?.fxRateUsdcJpy).toBeNull();
      });

      it('v4 anchorSymbol が不正値 → isValidEntry 不通過で drop', () => {
        const bad = { ...entry({ id: 'bad-anchor' }), anchorSymbol: 'eth' };
        expect(migrateToLatest(bad)).toBeNull();
      });

      it('v4 anchor を持つ entry は migrate (no-op) を通過して保持される', () => {
        const e = entry({
          id: 'v4-anchor',
          anchorAmount: '1000',
          anchorSymbol: 'jpyc',
          fxRateUsdcJpy: '156.32',
        });
        const out = migrateToLatest({ ...e });
        expect(out?.anchorAmount).toBe('1000');
        expect(out?.anchorSymbol).toBe('jpyc');
        expect(out?.fxRateUsdcJpy).toBe('156.32');
      });

      it('non-object 入力 → null', () => {
        expect(migrateToLatest(null)).toBeNull();
        expect(migrateToLatest(undefined)).toBeNull();
        expect(migrateToLatest('string')).toBeNull();
        expect(migrateToLatest(42)).toBeNull();
      });

      it('schemaVersion > LATEST → null (future build からの downgrade 防御)', () => {
        const e = entry({ id: 'future' });
        const future = { ...e, schemaVersion: LATEST_SCHEMA_VERSION + 1 };
        expect(migrateToLatest(future)).toBeNull();
      });

      it('schemaVersion = LATEST + 99 → null', () => {
        const e = entry({ id: 'far-future' });
        const far = { ...e, schemaVersion: LATEST_SCHEMA_VERSION + 99 };
        expect(migrateToLatest(far)).toBeNull();
      });

      it('schemaVersion 不在 (Phase 2 初期 legacy データ) → v1 stamp → v2 へ migration', () => {
        // schemaVersion を完全に欠落させた entry を直接構築
        const e = entry({ id: 'legacy' });
        const legacy: Record<string, unknown> = { ...e };
        delete legacy.schemaVersion;
        const out = migrateToLatest(legacy);
        expect(out).not.toBeNull();
        expect(out?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(out?.id).toBe('legacy');
      });

      it('schemaVersion が non-number (string / null / object) → v1 stamp → v2', () => {
        const e = entry({ id: 'weird' });
        const out1 = migrateToLatest({ ...e, schemaVersion: '1' });
        const out2 = migrateToLatest({ ...e, schemaVersion: null });
        const out3 = migrateToLatest({ ...e, schemaVersion: { v: 1 } });
        expect(out1?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(out2?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(out3?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      });

      it('shape 不正 (id 欠落等) → migration 後 validation で null', () => {
        const e = entry({ id: 'x' });
        const broken = { ...e, id: 123 }; // id が number → isValidEntry で false
        expect(migrateToLatest(broken)).toBeNull();
      });

      it('入力 entry は mutate されない (shallow copy で隔離)', () => {
        const e = entry({ id: 'immut' });
        const input = { ...e } as Record<string, unknown>;
        delete input.schemaVersion;
        migrateToLatest(input);
        expect(input.schemaVersion).toBeUndefined();
      });
    });

    describe('migration chain (将来 v2 を投入したときの挙動を fake migration で予証)', () => {
      it('MIGRATIONS[from] を辿って repeatedly apply される', () => {
        // この test だけ LATEST を超える "fake v3" を一時的に作る:
        // LATEST_SCHEMA_VERSION = 1 を強制的に弄れないので、ここでは
        // migrateToLatest の to が 1 固定で確認できる範囲のみ test。
        // v_unknown → v1 chain (現状未登録) で drop されることを確認。
        const e = entry({ id: 'no-chain' });
        const v0 = { ...e, schemaVersion: 0 }; // 不在の version
        // MIGRATIONS[0] = undefined → migration gap → null
        expect(migrateToLatest(v0)).toBeNull();
      });

      it('MIGRATIONS[from] が登録されれば chain が走る', () => {
        // v0 → v1 の fake migration を一時登録
        const v0ToV1: MigrationFn = (entry) => ({
          ...entry,
          // v0 schema を v1 shape に変換 (ここでは恒等 + version bump)。
          // 実際の v2 → v3 等もこの形 (新 field 追加 / 旧 field 削除等)。
        });
        (MIGRATIONS as Record<number, MigrationFn>)[0] = v0ToV1;

        const e = entry({ id: 'from-v0' });
        const v0 = { ...e, schemaVersion: 0 };
        const out = migrateToLatest(v0);
        expect(out).not.toBeNull();
        expect(out?.id).toBe('from-v0');
        // v0 →(fake)→ v1 →(実 MIGRATIONS[1])→ v2 →(実 MIGRATIONS[2])→ v3 まで chain が走る
        expect(out?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      });

      it('chain 内 migration が null を返したら drop', () => {
        (MIGRATIONS as Record<number, MigrationFn>)[0] = () => null;
        const e = entry({ id: 'reject' });
        const v0 = { ...e, schemaVersion: 0 };
        expect(migrateToLatest(v0)).toBeNull();
      });

      it('chain 内 migration が non-object を返したら drop', () => {
        (MIGRATIONS as Record<number, MigrationFn>)[0] = () =>
          'not-an-object' as unknown as Record<string, unknown>;
        const e = entry({ id: 'wrong-type' });
        const v0 = { ...e, schemaVersion: 0 };
        expect(migrateToLatest(v0)).toBeNull();
      });
    });

    describe('loadHistory が migration を透過適用', () => {
      it('LocalStorage に versionless legacy + 現行 v1 混在 → 全件取込', () => {
        const e1 = entry({ id: 'v1' });
        const e2: Record<string, unknown> = { ...entry({ id: 'legacy' }) };
        delete e2.schemaVersion;
        window.localStorage.setItem(
          HISTORY_STORAGE_KEY,
          JSON.stringify([e1, e2]),
        );
        const loaded = loadHistory();
        expect(loaded).toHaveLength(2);
        expect(loaded[0].schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(loaded[1].schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      });

      it('LocalStorage に future version 混在 → future のみ drop', () => {
        const e1 = entry({ id: 'v1' });
        const future = { ...entry({ id: 'v999' }), schemaVersion: 999 };
        window.localStorage.setItem(
          HISTORY_STORAGE_KEY,
          JSON.stringify([e1, future]),
        );
        const loaded = loadHistory();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].id).toBe('v1');
      });
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
