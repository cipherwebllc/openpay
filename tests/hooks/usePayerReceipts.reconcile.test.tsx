import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  buildPayerReceipt,
  loadPayerReceipts,
  PAYER_RECEIPTS_STORAGE_KEY,
  type PayerReceipt,
} from '@/lib/payerReceipt';
import type { ReceiptTxStatus } from '@/lib/payerReceiptReconcile';

// 第 7 回レビュー A10: 控えの on-chain 照合。照合 (reconcilePendingReceipts) は実物で、on-chain の照会
// (fetchReceiptTxStatus) だけを差し替える。照合の状態はモジュールに 1 つなので、テストごとにモジュールを
// 読み直す (vi.resetModules)。照会の mock は読み直しても同じものを返す (vi.hoisted)。
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/payerReceiptReconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payerReceiptReconcile')>()),
  fetchReceiptTxStatus: fetchMock,
}));

const NOW = new Date('2026-10-09T01:00:00.000Z');
const CHAIN = 80002;

function pending(txHash: string): PayerReceipt {
  return {
    ...buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash, chainId: CHAIN }, NOW),
    status: 'pending',
    paidAt: undefined,
  };
}

function seed(receipts: PayerReceipt[]) {
  window.localStorage.setItem(PAYER_RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
}

const statusOf = (txHash: string) => loadPayerReceipts().find((r) => r.txHash === txHash)?.status;
const queried = (txHash: string) => fetchMock.mock.calls.filter(([, h]) => h === txHash).length;

async function loadHook() {
  vi.resetModules();
  return (await import('@/hooks/usePayerReceipts')).usePayerReceipts;
}

// 時計を進めて、照会の応答 (microtask) と再描画を流す。
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// 応答を保留できる照会。同時に照会中の件数とその最大を数える。
function holdResponses() {
  const held: Array<{ hash: string; resolve: (s: ReceiptTxStatus) => void }> = [];
  const counter = { active: 0, max: 0 };
  fetchMock.mockImplementation(
    (_chainId: number, hash: string) =>
      new Promise<ReceiptTxStatus>((resolve) => {
        counter.active += 1;
        counter.max = Math.max(counter.max, counter.active);
        held.push({
          hash,
          resolve: (s) => {
            counter.active -= 1;
            resolve(s);
          },
        });
      }),
  );
  return { held, counter };
}

describe('usePayerReceipts: 照合の調整 (A10)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pending が 11 件: 同時に照会するのは 10 件まで・11 件目も同じ画面のまま照会して確定する', async () => {
    const usePayerReceipts = await loadHook();
    seed(Array.from({ length: 11 }, (_, i) => pending(`0xbatch-${i}`)));
    // 新しい 10 件は未着 (unknown)・11 件目 (いちばん古い) は成立済み。
    fetchMock.mockImplementation(async (_c: number, h: string): Promise<ReceiptTxStatus> =>
      h === '0xbatch-10' ? 'success' : 'unknown',
    );
    renderHook(() => usePayerReceipts());
    await advance(0);
    expect(statusOf('0xbatch-10')).toBe('confirmed');
    // 1 回目の 10 件は 1 回ずつ (すぐには再照会しない)。
    for (let i = 0; i < 10; i++) expect(queried(`0xbatch-${i}`)).toBe(1);
    expect(queried('0xbatch-10')).toBe(1);
  });

  it('未着 (unknown) だった控えは間隔を空けて再照会し、成立したら確定する', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xretry')]);
    fetchMock.mockResolvedValueOnce('unknown').mockResolvedValue('success');
    renderHook(() => usePayerReceipts());
    await advance(0);
    expect(queried('0xretry')).toBe(1);
    expect(statusOf('0xretry')).toBe('pending');
    await advance(14_000);
    expect(queried('0xretry')).toBe(1);
    await advance(1_000);
    expect(queried('0xretry')).toBe(2);
    expect(statusOf('0xretry')).toBe('confirmed');
  });

  it('照会した画面が応答の前に外れても、残った画面が引き継いで再照会する', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xhandoff')]);
    const { held } = holdResponses();
    const a = renderHook(() => usePayerReceipts());
    await advance(0);
    const b = renderHook(() => usePayerReceipts());
    await advance(0);
    expect(queried('0xhandoff')).toBe(1);
    a.unmount();
    held[0].resolve('unknown');
    await advance(0);
    await advance(15_000);
    expect(queried('0xhandoff')).toBe(2);
    held[1].resolve('success');
    await advance(0);
    expect(b.result.current.receipts[0].status).toBe('confirmed');
  });

  it('pending 21 件を 2 か所でマウント: 同時の照会は全体で 10 件まで・成立の保存通知で並走が増えない', async () => {
    const usePayerReceipts = await loadHook();
    seed(Array.from({ length: 21 }, (_, i) => pending(`0xcap-${i}`)));
    const { held, counter } = holdResponses();
    renderHook(() => usePayerReceipts());
    renderHook(() => usePayerReceipts());
    await advance(0);
    expect(counter.active).toBe(10);
    // 1 件ずつ成立させる (控えの保存 → 全画面の再読込 → 照合のやり直し) 間も、同時の照会は 10 件を超えない。
    for (let i = 0; i < 21; i++) {
      held[i].resolve('success');
      await advance(0);
      expect(counter.max).toBeLessThanOrEqual(10);
    }
    expect(fetchMock).toHaveBeenCalledTimes(21);
    expect(loadPayerReceipts().every((r) => r.status === 'confirmed')).toBe(true);
  });

  it('1 か所のマウントでも、1 件成立の保存通知で照会を重ねて始めない (同時 10 件のまま)', async () => {
    const usePayerReceipts = await loadHook();
    seed(Array.from({ length: 21 }, (_, i) => pending(`0xone-${i}`)));
    const { held, counter } = holdResponses();
    renderHook(() => usePayerReceipts());
    await advance(0);
    expect(counter.active).toBe(10);
    held[0].resolve('success');
    await advance(0);
    expect(counter.active).toBe(10);
    expect(counter.max).toBe(10);
  });

  it('1 件の再照会は上限の回数で止まる (未確定のまま)', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xgiveup')]);
    fetchMock.mockResolvedValue('unknown');
    renderHook(() => usePayerReceipts());
    await advance(0);
    for (let i = 0; i < 24; i++) await advance(5 * 60_000);
    // 初回 + 再照会 8 回 (15 秒から倍々・最大 5 分 = 約 23 分)。2 時間たっても増えない。
    expect(queried('0xgiveup')).toBe(9);
    expect(statusOf('0xgiveup')).toBe('pending');
  });

  it('画面がすべて外れたら、照会もタイマーも止まる', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xstop')]);
    fetchMock.mockResolvedValue('unknown');
    const view = renderHook(() => usePayerReceipts());
    await advance(0);
    expect(queried('0xstop')).toBe(1);
    view.unmount();
    await advance(60 * 60_000);
    expect(queried('0xstop')).toBe(1);
  });

  it('確定 (成立 / 失敗) を確かめた控えは、マウントし直しても照会せず、pending に戻っていれば覚えた結果で保存し直す', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xdone')]);
    fetchMock.mockResolvedValue('reverted');
    const first = renderHook(() => usePayerReceipts());
    await advance(0);
    expect(statusOf('0xdone')).toBe('failed');
    first.unmount();
    // ストアの控えが pending に戻っていても (別タブの古い書き込み等)、RPC は重ねずに確かめた結果で保存し直す。
    seed([pending('0xdone')]);
    renderHook(() => usePayerReceipts());
    await advance(60_000);
    expect(queried('0xdone')).toBe(1);
    expect(statusOf('0xdone')).toBe('failed');
  });

  // Codex 2 回目の指摘: on-chain の結果だけで照合済みにせず、ストアへ保存できたかを見る。
  it('成立を確かめても保存に失敗したら、RPC を重ねずに間隔を空けて保存だけやり直す', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xsavefail')]);
    fetchMock.mockResolvedValue('success');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    renderHook(() => usePayerReceipts());
    await advance(0);
    expect(queried('0xsavefail')).toBe(1);
    expect(statusOf('0xsavefail')).toBe('pending');
    await advance(15_000);
    expect(statusOf('0xsavefail')).toBe('confirmed');
    expect(queried('0xsavefail')).toBe(1);
    setItem.mockRestore();
  });

  it('保存のときに控えを読めなかった (一時的な読み込みの失敗) ら、間隔を空けて保存だけやり直す', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xreadfail')]);
    const { held } = holdResponses();
    renderHook(() => usePayerReceipts());
    await advance(0);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    getItem.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    held[0].resolve('success');
    await advance(0);
    getItem.mockRestore();
    expect(statusOf('0xreadfail')).toBe('pending');
    await advance(15_000);
    expect(statusOf('0xreadfail')).toBe('confirmed');
    expect(queried('0xreadfail')).toBe(1);
  });

  it('別タブの古い書き込みで pending に戻ったら (画面はそのまま)、RPC を重ねずに覚えた結果で保存し直す', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xstale-tab')]);
    fetchMock.mockResolvedValue('success');
    const view = renderHook(() => usePayerReceipts());
    await advance(0);
    expect(statusOf('0xstale-tab')).toBe('confirmed');
    seed([pending('0xstale-tab')]);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: PAYER_RECEIPTS_STORAGE_KEY }));
    });
    await advance(0);
    expect(statusOf('0xstale-tab')).toBe('confirmed');
    expect(view.result.current.receipts[0].status).toBe('confirmed');
    expect(queried('0xstale-tab')).toBe(1);
  });

  // Codex 2 回目の指摘 (P3): 画面が 0 の間に古くなった一覧で照会を始めない。
  it('画面が 0 の間に消えた控えは、もう一度マウントしたとき照会しない (最新の一覧を先に使う)', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xgone')]);
    fetchMock.mockResolvedValue('unknown');
    const first = renderHook(() => usePayerReceipts());
    await advance(0);
    expect(queried('0xgone')).toBe(1);
    first.unmount();
    seed([]);
    await advance(20_000);
    renderHook(() => usePayerReceipts());
    await advance(0);
    expect(queried('0xgone')).toBe(1);
  });

  it('同時にマウントした 2 か所から同じ控えを重ねて照会しない', async () => {
    const usePayerReceipts = await loadHook();
    seed([pending('0xdup')]);
    fetchMock.mockResolvedValue('success');
    renderHook(() => {
      usePayerReceipts();
      return usePayerReceipts();
    });
    await advance(0);
    expect(statusOf('0xdup')).toBe('confirmed');
    expect(queried('0xdup')).toBe(1);
  });
});
