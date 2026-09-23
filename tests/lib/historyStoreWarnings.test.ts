import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadStores() {
  const { logger } = await import('@/lib/logger');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const history = await import('@/lib/history');
  const receipts = await import('@/lib/payerReceipt');
  return {
    warn,
    history: {
      key: history.HISTORY_STORAGE_KEY,
      event: 'history.load.unreadable-entries-preserved',
      read: history.loadHistory,
      remove: history.removeHistoryEntry,
      clear: history.clearHistory,
    },
    receipts: {
      key: receipts.PAYER_RECEIPTS_STORAGE_KEY,
      event: 'payerReceipts.load.unreadable-entries-preserved',
      read: receipts.loadPayerReceipts,
      remove: receipts.removePayerReceipt,
      clear: receipts.clearPayerReceipts,
    },
  };
}

describe('unreadable-entry warnings are bounded per page session and store', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['history', 'receipts'] as const)('%s warns once across repeated loads and writes, even after clearing', async (name) => {
    const stores = await loadStores();
    const store = stores[name];
    expect(store.read()).toEqual([]);
    expect(stores.warn).not.toHaveBeenCalled();

    const raw = JSON.stringify([{ schemaVersion: 999, id: 'unknown' }, null]);
    window.localStorage.setItem(store.key, raw);
    expect(store.read()).toEqual([]);
    expect(store.read()).toEqual([]);
    store.remove('unknown');
    expect(window.localStorage.getItem(store.key)).toBe(raw);

    store.clear();
    expect(store.read()).toEqual([]);
    window.localStorage.setItem(store.key, JSON.stringify([{ schemaVersion: 1000 }]));
    expect(store.read()).toEqual([]);

    expect(stores.warn).toHaveBeenCalledTimes(1);
    expect(stores.warn).toHaveBeenCalledWith(store.event, { invalid: 2, kept: 0 });
  });

  it('each store warns independently and a fresh page session can warn again', async () => {
    const first = await loadStores();
    window.localStorage.setItem(first.history.key, JSON.stringify([{ schemaVersion: 999 }]));
    window.localStorage.setItem(first.receipts.key, JSON.stringify([{ schemaVersion: 999 }]));
    for (const store of [first.history, first.receipts]) {
      store.read();
      store.read();
    }
    expect(first.warn.mock.calls).toEqual([
      [first.history.event, { invalid: 1, kept: 0 }],
      [first.receipts.event, { invalid: 1, kept: 0 }],
    ]);

    // A new module instance models a page reload; LocalStorage survives that reload.
    vi.resetModules();
    const second = await loadStores();
    for (const store of [second.history, second.receipts]) {
      store.read();
      store.read();
    }
    expect(second.warn.mock.calls).toEqual([
      [second.history.event, { invalid: 1, kept: 0 }],
      [second.receipts.event, { invalid: 1, kept: 0 }],
    ]);
  });
});
