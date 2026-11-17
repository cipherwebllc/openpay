// hooks/useQrBillKey.ts: 見張りの chunk (lib/qrSaleWatch.ts) は、bill key を載せる QR を表示したときに初めて読む。
// 載せない QR・表示していない QR・/create のページの出入りだけでは読まない (この file は読んだ回数を最初から数える)。

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const watch = vi.hoisted(() => ({ imports: 0, calls: [] as string[] }));
vi.mock('@/lib/qrSaleWatch', () => {
  watch.imports += 1;
  return {
    showQrBill: (input: { billKey: string }) => watch.calls.push(`show:${input.billKey}`),
    hideQrBill: (billKey: string) => watch.calls.push(`hide:${billKey}`),
    stopQrSaleWatch: () => watch.calls.push('stop'),
  };
});

import { useQrBillKey, useQrSaleWatchScope } from '@/hooks/useQrBillKey';

const URL_A = 'https://shop.test/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=1000';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('useQrBillKey — 見張りの chunk を読む時', () => {
  it('順に: 載せない QR・表示していない QR・ページの出入りでは読まない → 載せる QR を表示したら 1 回だけ読む', async () => {
    // 1. 載せない QR (USDC・通常決済など = url が空) を表示して閉じる。
    const off = renderHook(() => useQrBillKey({ kind: 'pay', url: '', shown: true }));
    await flush();
    off.unmount();
    // 2. 載せる QR だが、まだ表示していない。
    const closed = renderHook(() => useQrBillKey({ kind: 'pay', url: URL_A, shown: false }));
    await flush();
    closed.unmount();
    // 3. /create を開いて離れる (見張りを読み込んでいなければ、止めるものが無い)。
    const page = renderHook(() => useQrSaleWatchScope());
    await flush();
    page.unmount();
    await flush();
    expect(watch.imports).toBe(0);
    expect(watch.calls).toEqual([]);

    // 4. 載せる QR を表示する。
    const shown = renderHook(() => useQrBillKey({ kind: 'pay', url: URL_A, shown: true }));
    await waitFor(() => expect(watch.calls).toHaveLength(1));
    expect(watch.imports).toBe(1);
    // 5. 出し直しても、ページを離れても、読むのは 1 回だけ。
    const page2 = renderHook(() => useQrSaleWatchScope());
    shown.unmount();
    renderHook(() => useQrBillKey({ kind: 'checkout', url: URL_A, shown: true }));
    await flush();
    page2.unmount();
    await flush();
    expect(watch.imports).toBe(1);
    expect(watch.calls.at(-1)).toBe('stop');
  });
});
