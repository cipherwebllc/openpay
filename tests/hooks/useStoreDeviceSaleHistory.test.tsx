import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getAddress, type Hex } from 'viem';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      enableStoreGasWallet: true,
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));
// 書き手は本物。呼ばれた回数を数え、失敗 (throw・false) を差し込めるようにだけ包む。
const writer = vi.hoisted(() => ({ calls: 0, fail: null as null | 'throw' | 'false' }));
vi.mock('@/lib/storeDeviceSaleHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storeDeviceSaleHistory')>();
  return {
    ...actual,
    recordStoreDeviceSale: (...args: Parameters<typeof actual.recordStoreDeviceSale>) => {
      writer.calls += 1;
      if (writer.fail === 'throw') throw new Error('history write failed');
      if (writer.fail === 'false') return false;
      return actual.recordStoreDeviceSale(...args);
    },
  };
});

import { useStoreDeviceSaleHistory } from '@/hooks/useStoreDeviceSaleHistory';
import type { StoreDeviceRegisterState } from '@/hooks/useStoreDeviceRegister';
import { loadHistory } from '@/lib/history';
import { logger } from '@/lib/logger';
import { STORE_DEVICE_SALE_SNAPSHOT_KEY, saveStoreDeviceSaleSnapshot } from '@/lib/storeDeviceSaleSnapshot';
import type { DeviceSentMark } from '@/lib/storeDeviceSend';
import type { CheckoutParams } from '@/lib/url';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const PAYER = getAddress('0x0000000000000000000000000000000000000def');
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const HASH = `0x${'cd'.repeat(32)}` as Hex;
const SETTLED_HASH = `0x${'ef'.repeat(32)}` as Hex;
const AMOUNT = 1000n * 10n ** 18n;
const MARK: DeviceSentMark = {
  handoffId: HS,
  chainId: 80002,
  nonce: `0x${'33'.repeat(32)}`,
  hash: HASH,
  from: PAYER,
  merchant: SHOP,
  amount: AMOUNT.toString(),
  validBefore: '9999999999',
  intentSalt: `0x${'11'.repeat(32)}`,
  at: new Date('2026-11-16T02:59:30Z').getTime(),
};
const checkout: CheckoutParams = {
  to: SHOP,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'merchant',
  mode: 'gasless',
  items: [{ name: 'カフェラテ', qty: 2, price: '500' }],
  receiptNo: 'R-0012',
  submit: 'store',
};
const SESSION = { id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: SHOP, amount: AMOUNT.toString(), chainId: 80002 };

/** 書き手の読み込み (dynamic import) と、その後の書き込みが終わるまで待つ。 */
async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
  });
}
const hook = (state: StoreDeviceRegisterState, reactStrictMode = false) =>
  renderHook(({ s }: { s: StoreDeviceRegisterState }) => useStoreDeviceSaleHistory(s), {
    initialProps: { s: state },
    reactStrictMode,
  });

// 書き手の module を先に読み込んでおく (各テストの中の dynamic import が、module の変換を待たずにすぐ解決する =
// 負荷の高い full run でも、前のテストの読み込みが次のテストへずれ込まない)。
beforeAll(async () => {
  await import('@/lib/storeDeviceSaleHistory');
});
let warn: ReturnType<typeof vi.spyOn>;
// 処理されなかった reject (書き手の失敗が hook の外へ漏れた印)。
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
/** 本物の時計で 1 回待ち、処理されなかった reject が無いことを確かめる。 */
async function expectNoUnhandledRejection() {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  expect(unhandled).toEqual([]);
}
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
  window.localStorage.clear();
  window.sessionStorage.clear();
  writer.calls = 0;
  writer.fail = null;
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useStoreDeviceSaleHistory (入金を確かめた支払いだけを、お店の取引履歴へ 1 行)', () => {
  it('received で 1 行 (写しの明細つき・tx は端末が送った tx)', async () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    hook({ phase: 'received', mark: MARK, finalized: false, previous: false });
    await settle();
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `batch-${HASH}`,
      status: 'success',
      merchantAmount: AMOUNT.toString(),
      customer: PAYER,
      receiptNo: 'R-0012',
      productName: 'カフェラテ',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, StoreDeviceRegisterState]>([
    ['idle', { phase: 'idle' }],
    ['creating', { phase: 'creating' }],
    ['waiting', { phase: 'waiting', session: SESSION, stale: false, degraded: false }],
    ['processing', { phase: 'processing' }],
    ['not_sent', { phase: 'not_sent', reason: 'rpc', canRetry: true }],
    ['sent', { phase: 'sent', mark: MARK, previous: false }],
    ['unknown', { phase: 'unknown', mark: MARK, previous: false }],
    ['unknown (端末の tx は revert・確定待ちの tx あり)', { phase: 'unknown', mark: MARK, previous: false, storeTxReverted: true, txHash: SETTLED_HASH }],
    ['reverted', { phase: 'reverted', mark: MARK, previous: false }],
    ['failed', { phase: 'failed', mark: MARK, previous: false }],
    ['marks_unreadable', { phase: 'marks_unreadable' }],
  ])('%s では書かない (書き手も読み込まない)', async (_name, state) => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    hook(state);
    await settle();
    expect(loadHistory()).toEqual([]);
    expect(writer.calls).toBe(0);
  });

  it('unknown の間は 0 行 → received に変わったら 1 行 (サーバの判定が見つけた tx で)', async () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const h = hook({ phase: 'unknown', mark: MARK, previous: false, storeTxReverted: true });
    await settle();
    expect(loadHistory()).toEqual([]);
    h.rerender({ s: { phase: 'received', mark: MARK, finalized: true, previous: false, txHash: SETTLED_HASH } });
    await settle();
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `batch-${SETTLED_HASH}`, txHash: SETTLED_HASH, receiptNo: 'R-0012' });
  });

  it('StrictMode で effect が 2 回走っても 1 行', async () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    // effect が本当に 2 回走ったことを、書き手が写しを読んだ回数で確かめる (vitest は、同じ tick に 2 回 import した mock の
    // module の 2 本目を実物で返すので、上の包みの回数では数えられない)。
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    hook({ phase: 'received', mark: MARK, finalized: false, previous: false }, true);
    await settle();
    expect(getItem.mock.calls.filter(([key]) => key === STORE_DEVICE_SALE_SNAPSHOT_KEY)).toHaveLength(2);
    expect(loadHistory()).toHaveLength(1);
  });

  it('同じ支払いの表示が更新されても (確定・再描画) 1 行のまま', async () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const h = hook({ phase: 'received', mark: MARK, finalized: false, previous: false });
    await settle();
    h.rerender({ s: { phase: 'received', mark: MARK, finalized: true, previous: false, txHash: HASH } });
    await settle();
    // 印を読み直した別の object (同じ支払い) でも
    h.rerender({ s: { phase: 'received', mark: { ...MARK }, finalized: true, previous: false, txHash: HASH } });
    await settle();
    expect(loadHistory()).toHaveLength(1);
  });

  it('再読み込みの後の「前回の送信」(previous) が received になったときも書く', async () => {
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const h = hook({ phase: 'sent', mark: MARK, previous: true });
    await settle();
    expect(loadHistory()).toEqual([]);
    h.rerender({ s: { phase: 'received', mark: MARK, finalized: false, previous: true } });
    await settle();
    expect(loadHistory()).toEqual([expect.objectContaining({ id: `batch-${HASH}`, receiptNo: 'R-0012', ts: MARK.at })]);
  });

  it('写しが無い (古い session・別のタブ) ときは、明細なしで金額と tx だけの行', async () => {
    hook({ phase: 'received', mark: MARK, finalized: false, previous: true });
    await settle();
    expect(loadHistory()).toEqual([
      expect.objectContaining({
        id: `batch-${HASH}`,
        merchantAmount: AMOUNT.toString(),
        txHash: HASH,
        lineItems: null,
        receiptNo: null,
        productName: null,
      }),
    ]);
  });

  it('次の会計の入金は、次の 1 行になる', async () => {
    const h = hook({ phase: 'received', mark: MARK, finalized: false, previous: false });
    await settle();
    h.rerender({ s: { phase: 'idle' } });
    const next = { ...MARK, handoffId: 'ZZZZZZZZZZZZZZZZZZZZZZ', hash: SETTLED_HASH, nonce: `0x${'44'.repeat(32)}` as Hex };
    h.rerender({ s: { phase: 'received', mark: next, finalized: false, previous: false } });
    await settle();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${SETTLED_HASH}`, `batch-${HASH}`]);
  });

  it('履歴の書き込みが throw しても hook は throw しない・警告は 1 回だけ (次の会計でも増やさない)', async () => {
    writer.fail = 'throw';
    const h = hook({ phase: 'received', mark: MARK, finalized: false, previous: false });
    await settle();
    expect(loadHistory()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('storeDevice.saleHistory.not-written', expect.objectContaining({ chainId: 80002 }));
    h.rerender({ s: { phase: 'idle' } });
    h.rerender({ s: { phase: 'received', mark: { ...MARK, hash: SETTLED_HASH }, finalized: false, previous: false } });
    await settle();
    expect(writer.calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    await expectNoUnhandledRejection();
  });

  it('行を作れなかった (書き手が false) ときも警告を 1 回残す', async () => {
    writer.fail = 'false';
    hook({ phase: 'received', mark: MARK, finalized: false, previous: false });
    await settle();
    expect(loadHistory()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('端末の保存領域に書けない (localStorage の setItem が throw) ときも throw しない', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    hook({ phase: 'received', mark: MARK, finalized: false, previous: false });
    await settle();
    setItem.mockRestore();
    expect(loadHistory()).toEqual([]);
    // 書けなかったことは lib/storage.ts の safeSet が警告に残す (「書けた」ことにしない)。
    expect(warn).toHaveBeenCalledWith('localStorage.set failed', expect.objectContaining({ key: 'openpay:history:v1' }));
  });
});
