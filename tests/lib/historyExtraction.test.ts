import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildHistoryBase } from '@/lib/history';

// R15c (lib/history.ts → lib/history/* の分割) の pinning。
// 同じ期待値を分割前の単一 module (leaf の import を facade に読み替え) でも通してから分割した。
// 期待値を分割後の実装に合わせて作り直さないこと。
const now = new Date(2026, 8, 24, 12, 0, 0).getTime();
const input: BuildHistoryBase & { ts: number } = {
  ts: now,
  flow: 'direct',
  status: 'pending',
  chainId: 137,
  chainSlug: 'polygon',
  asset: 'jpyc',
  tokenAddress: '0xToken',
  payMode: 'gasless',
  gasMode: 'customer',
  merchant: '0xShop',
  merchantAmount: 1000000000000000001n,
  customer: undefined,
  feeReceiver: '0xFee',
  feeAmount: 0n,
  txHash: '0xTx',
  userOpHash: null,
  blockNumber: null,
  errorMessage: null,
  storeName: 'Shop',
  productName: 'Original product',
  note: 'Original note',
};

async function loadModules(first: 'facade' | 'leaves' = 'facade') {
  const { logger } = await import('@/lib/logger');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  if (first === 'facade') await import('@/lib/history');
  const model = await import('@/lib/history/model');
  const migrations = await import('@/lib/history/migrations');
  const storage = await import('@/lib/history/storage');
  const builders = await import('@/lib/history/builders');
  const summaries = await import('@/lib/history/summaries');
  const facade = await import('@/lib/history');
  return { facade, model, migrations, storage, builders, summaries, warn };
}

describe('history extraction contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the exact public runtime exports and their leaf identities', async () => {
    const { facade, model, migrations, storage, builders, summaries } = await loadModules();
    expect(Object.keys(facade).sort()).toEqual([
      'FEE_BREAKDOWN_UNKNOWN', 'FEE_BREAKDOWN_VERSION',
      'HISTORY_ASSET_DECIMALS', 'HISTORY_ASSET_DISPLAY', 'HISTORY_CHANGED_EVENT',
      'HISTORY_ERROR_MESSAGE_MAX_LENGTH', 'HISTORY_LINE_ITEMS_MAX', 'HISTORY_MAX_ENTRIES',
      'HISTORY_NOTE_MAX_LENGTH', 'HISTORY_PRODUCT_NAME_MAX', 'HISTORY_RECEIPT_NO_MAX',
      'HISTORY_STORAGE_KEY', 'HISTORY_UNIT_AMOUNT_MAX', 'LATEST_SCHEMA_VERSION',
      'MIGRATIONS', 'TODAY_SUMMARY_KEY', 'addEntryToTodaySummary', 'appendHistory',
      'buildHistoryEntry', 'buildTodaySummary', 'clearHistory', 'entryLineItems',
      'entryTotals', 'formatHistoryTimestamp', 'hasSeparatedBreakdown',
      'isValidTodaySummary', 'loadHistory', 'localDateKey', 'migrateToLatest',
      'networkFeeEquivalentOf', 'promotePendingHistoryByTxHash', 'readTodaySummary',
      'removeHistoryEntry',
    ]);
    for (const leaf of [model, migrations, storage, builders, summaries]) {
      for (const [name, value] of Object.entries(leaf)) {
        expect(facade[name as keyof typeof facade], name).toBe(value);
      }
    }
    expect(model.HISTORY_STORAGE_KEY).toBe('openpay:history:v1');
    expect(model.TODAY_SUMMARY_KEY).toBe('openpay:todaySummary:v1');
    expect(model.HISTORY_CHANGED_EVENT).toBe('openpay:history-changed');
  });

  it.each(['facade', 'leaves'] as const)('%s first: mixed readers/writers share one warning even across clear', async (first) => {
    const { facade, model, storage, builders, warn } = await loadModules(first);
    const readers = first === 'facade' ? [facade, storage] : [storage, facade];
    const raw = '[{"schemaVersion":999,"id":"unknown"},null]';
    window.localStorage.setItem(model.HISTORY_STORAGE_KEY, raw);
    expect(readers[0].loadHistory()).toEqual([]);
    expect(readers[1].loadHistory()).toEqual([]);
    storage.appendHistory(builders.buildHistoryEntry(input));
    facade.removeHistoryEntry('direct-0xTx');
    expect(window.localStorage.getItem(model.HISTORY_STORAGE_KEY)).toBe(raw);
    storage.clearHistory();
    window.localStorage.setItem(model.HISTORY_STORAGE_KEY, raw);
    facade.loadHistory();
    storage.removeHistoryEntry('unknown');
    facade.clearHistory();
    window.localStorage.setItem(model.HISTORY_STORAGE_KEY, raw);
    storage.loadHistory();
    expect(warn.mock.calls).toEqual([
      ['history.load.unreadable-entries-preserved', { invalid: 2, kept: 0 }],
    ]);
  });

  it.each(['facade', 'leaves'] as const)('%s first: mutating MIGRATIONS changes both migration and storage consumers', async (first) => {
    const { facade, model, migrations, storage, builders } = await loadModules(first);
    expect(facade.MIGRATIONS).toBe(migrations.MIGRATIONS);
    const original = facade.MIGRATIONS[4];
    const current = builders.buildHistoryEntry(input);
    const legacy = { ...current, schemaVersion: 4 };
    const migrated = { ...current, note: 'migration override' };
    const migrate = vi.fn(() => migrated);
    try {
      facade.MIGRATIONS[4] = migrate;
      expect(migrations.migrateToLatest(legacy)).toEqual(migrated);
      window.localStorage.setItem(model.HISTORY_STORAGE_KEY, JSON.stringify([legacy]));
      expect(storage.loadHistory()).toEqual([migrated]);
      expect(facade.loadHistory()).toEqual([migrated]);
      expect(migrate).toHaveBeenCalledTimes(3);

      // 別の import 経路からの削除も、全経路で本物の migration 欠番として効く (複製していない証拠)。
      delete migrations.MIGRATIONS[4];
      expect(facade.migrateToLatest(legacy)).toBeNull();
      expect(storage.loadHistory()).toEqual([]);
      facade.appendHistory({ ...current, id: 'new' });
      expect(window.localStorage.getItem(model.HISTORY_STORAGE_KEY)).toBe(
        JSON.stringify([{ ...current, id: 'new' }, legacy]),
      );
    } finally {
      facade.MIGRATIONS[4] = original;
    }
  });

  it.each(['append', 'append-promotion', 'promote', 'remove'] as const)(
    '%s through mixed imports preserves opaque JSON, positions, metadata and summary-before-event order',
    async (operation) => {
      const { facade, model, storage, builders } = await loadModules();
      const pending = builders.buildHistoryEntry(input);
      const future = { ...pending, schemaVersion: 999, extra: { z: [null, 1], a: 'keep' } };
      const invalid = { ...pending, asset: 'future-token' };
      const opaque = [future, invalid, null, 42, 'opaque', ['nested']];
      const extraFields = { futureMetadata: { z: 2, a: 1 } };
      const known = { ...pending, ...extraFields };
      window.localStorage.setItem(model.HISTORY_STORAGE_KEY, JSON.stringify([...opaque, known]));
      expect(facade.loadHistory()).toEqual([known]);
      expect(storage.loadHistory()).toEqual([known]);

      const observed: unknown[] = [];
      const onChange = (event: Event) => observed.push({
        type: event.type,
        history: window.localStorage.getItem(model.HISTORY_STORAGE_KEY),
        summary: window.localStorage.getItem(model.TODAY_SUMMARY_KEY),
      });
      window.addEventListener('openpay:history-changed', onChange);
      try {
        const added = facade.buildHistoryEntry({ ...input, txHash: '0xNew', status: 'success' });
        if (operation === 'append') storage.appendHistory(added);
        if (operation === 'append-promotion') facade.appendHistory({
          ...pending, status: 'success', blockNumber: '77', productName: 'Replacement',
          note: 'Replacement note', merchantAmount: '999',
        });
        if (operation === 'promote') {
          expect(storage.promotePendingHistoryByTxHash('0xTX', 'success', 77n)).toBe(true);
        }
        if (operation === 'remove') facade.removeHistoryEntry(pending.id);

        const expected = operation === 'append'
          ? [added, ...opaque, known]
          : operation === 'remove'
            ? opaque
            : [...opaque, { ...known, status: 'success', blockNumber: '77' }];
        const summary = operation === 'remove' ? null : JSON.stringify({
          date: '2026-09-24',
          byMerchant: {
            '0xshop': { count: 1, jpycAtomic: '1000000000000000001', usdcAtomic: '0', lastTs: now },
          },
        });
        expect(window.localStorage.getItem(model.HISTORY_STORAGE_KEY)).toBe(JSON.stringify(expected));
        expect(window.localStorage.getItem(model.TODAY_SUMMARY_KEY)).toBe(summary);
        expect(observed).toEqual([{
          type: 'openpay:history-changed', history: JSON.stringify(expected), summary,
        }]);
        expect(storage.loadHistory()).toEqual(facade.loadHistory());

        // 未知の生 record は読める entry と同じ id/tx hash を持っていても、変更操作の対象にならない。
        storage.removeHistoryEntry(pending.id);
        const before = window.localStorage.getItem(model.HISTORY_STORAGE_KEY);
        const events = observed.length;
        facade.removeHistoryEntry(pending.id);
        expect(facade.promotePendingHistoryByTxHash('0xTX', 'reverted')).toBe(false);
        expect(window.localStorage.getItem(model.HISTORY_STORAGE_KEY)).toBe(before);
        expect(observed).toHaveLength(events);
      } finally {
        window.removeEventListener('openpay:history-changed', onChange);
      }
    },
  );

  it('pins builder JSON bytes, field order and line-item/summary projections', async () => {
    const { facade, builders, summaries } = await loadModules();
    const entry = builders.buildHistoryEntry({ ...input, status: 'success', taxRate: 10 });
    expect(JSON.stringify(entry)).toBe(
      '{"schemaVersion":5,"id":"direct-0xTx","ts":' + now +
      ',"flow":"direct","status":"success","chainId":137,"chainSlug":"polygon",' +
      '"asset":"jpyc","tokenAddress":"0xToken","payMode":"gasless","gasMode":"customer",' +
      '"merchant":"0xShop","merchantAmount":"1000000000000000001","customer":null,' +
      '"feeReceiver":"0xFee","feeAmount":"0","txHash":"0xTx","userOpHash":null,' +
      '"blockNumber":null,"errorMessage":null,"storeName":"Shop","note":"Original note",' +
      '"provider":null,"circlePaymasterAddress":null,"circlePaymasterNetUsdc":null,' +
      '"circleVerification":null,"saleAmount":null,"networkFeeEquivalent":null,' +
      '"feeBreakdownVersion":1,"anchorAmount":null,"anchorSymbol":null,"fxRateUsdcJpy":null,' +
      '"productName":"Original product","memo":null,"taxRate":10,"taxCategory":null,' +
      '"receiptNo":null,"lineItems":null}',
    );
    expect(facade.entryLineItems(entry)).toEqual([{
      name: 'Original product', quantity: 1, unitPrice: '1.000000000000000001',
      amount: '1.000000000000000001', taxRate: 10, taxCategory: null, memo: null,
      id: 'direct-0xTx-0', currency: 'jpyc', taxAmount: '0',
    }]);
    expect(summaries.entryTotals(entry)).toEqual({
      subtotal: '1.000000000000000001', totalTax: '0', total: '1.000000000000000001',
    });
    expect(summaries.formatHistoryTimestamp(now)).toBe('2026-09-24 12:00:00');
    expect(summaries.buildTodaySummary([entry], now)).toEqual({
      date: '2026-09-24',
      byMerchant: {
        '0xshop': { count: 1, jpycAtomic: '1000000000000000001', usdcAtomic: '0', lastTs: now },
      },
    });
  });
});
