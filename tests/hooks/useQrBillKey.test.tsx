// hooks/useQrBillKey.ts: 画面に表示中の QR に載せる bill key を作り、その会計を見張り (lib/qrSaleWatch.ts) に伝える。
// 見張りの module は、呼ばれ方だけを見る差し替え (本物の見張りは tests/lib/qrSaleWatch.test.ts)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';

const watch = vi.hoisted(() => ({
  calls: [] as string[],
  shown: [] as { billKey: string; kind: string; url: string; itemName: string }[],
  throwOnShow: false,
}));
vi.mock('@/lib/qrSaleWatch', () => ({
  showQrBill: (input: { billKey: string; kind: string; url: string; itemName: string }) => {
    watch.calls.push(`show:${input.billKey}`);
    watch.shown.push(input);
    if (watch.throwOnShow) throw new Error('watch failed');
  },
  hideQrBill: (billKey: string) => {
    watch.calls.push(`hide:${billKey}`);
  },
  stopQrSaleWatch: () => {
    watch.calls.push('stop');
  },
}));

import { useQrBillKey, useQrSaleWatchScope, type QrBillKeyArgs } from '@/hooks/useQrBillKey';
import { billKeySalt } from '@/lib/relay/billKeySalt';

const URL_A = 'https://shop.test/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=1000';
const URL_B = 'https://shop.test/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=1200';

const args = (over: Partial<QrBillKeyArgs> = {}): QrBillKeyArgs => ({
  kind: 'pay', url: URL_A, shown: true, itemName: 'お支払い', ...over,
});
const keyOf = (screenUrl: string | undefined, plain = URL_A) => {
  expect(screenUrl?.startsWith(`${plain}&bk=`)).toBe(true);
  return screenUrl!.slice(`${plain}&bk=`.length);
};
// 見張りへの呼び出しは、chunk の読み込み (Promise) の後に届く。
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  watch.calls = [];
  watch.shown = [];
  watch.throwOnShow = false;
});

describe('useQrBillKey — 画面の QR の URL', () => {
  it('表示中の QR: 元の URL の末尾に &bk=<11 字の base64url> を足した URL を返し、その会計を見張りに渡す', async () => {
    const { result } = renderHook(() => useQrBillKey(args()));
    const billKey = keyOf(result.current);
    expect(billKey).toMatch(/^[A-Za-z0-9_-]{11}$/);
    // 払う側が受ける形 (lib/relay/billKeySalt.ts)。
    expect(billKeySalt(billKey)).toMatch(/^0x[0-9a-f]{64}$/);
    // URL として読むと、元の param はそのままで bk だけが増える。
    const before = Object.fromEntries(new URL(URL_A).searchParams);
    expect(Object.fromEntries(new URL(result.current!).searchParams)).toEqual({ ...before, bk: billKey });
    await flush();
    expect(watch.shown).toEqual([{ billKey, kind: 'pay', url: URL_A, itemName: 'お支払い' }]);
  });

  it.each([
    ['載せない QR (url が空)', args({ url: '' })],
    ['表示していない (閉じている)', args({ shown: false })],
    ['載せない QR で、表示もしていない', args({ url: '', shown: false })],
  ])('%s → undefined を返し、bill key を作らず、見張りも呼ばない', async (_name, a) => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const { result, unmount } = renderHook(() => useQrBillKey(a));
    expect(result.current).toBeUndefined();
    await flush();
    unmount();
    await flush();
    expect(random).not.toHaveBeenCalled();
    expect(watch.calls).toEqual([]);
    random.mockRestore();
  });

  it('関係のない再描画 (同じ URL・表示中のまま) では、同じ bill key のまま。見張りにも渡し直さない', async () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const { result, rerender } = renderHook((p: QrBillKeyArgs) => useQrBillKey(p), { initialProps: args() });
    const first = result.current;
    for (let i = 0; i < 5; i += 1) rerender(args());
    // 値引きの行の名前だけが変わっても (言語の切り替え) 作り直さない。
    rerender(args({ itemName: 'Payment' }));
    expect(result.current).toBe(first);
    expect(random).toHaveBeenCalledTimes(1);
    await flush();
    expect(watch.calls).toEqual([`show:${keyOf(first)}`]);
    random.mockRestore();
  });

  it('表示する URL が変わったら (金額・明細の変更・為替の再計算) 新しい bill key。前の bill key は hide (見張りが 60 秒持つ)', async () => {
    const { result, rerender } = renderHook((p: QrBillKeyArgs) => useQrBillKey(p), { initialProps: args() });
    const first = keyOf(result.current);
    rerender(args({ url: URL_B }));
    const second = keyOf(result.current, URL_B);
    expect(second).not.toBe(first);
    await flush();
    expect(watch.calls).toEqual([`show:${first}`, `hide:${first}`, `show:${second}`]);
    expect(watch.shown[1]).toMatchObject({ billKey: second, url: URL_B });
    // 元の URL に戻しても、前の bill key は使い回さない。
    rerender(args());
    const third = keyOf(result.current);
    expect([first, second]).not.toContain(third);
  });

  it('閉じたら hide。出し直すたびに新しい bill key (同じ URL でも)', async () => {
    const { result, rerender } = renderHook((p: QrBillKeyArgs) => useQrBillKey(p), { initialProps: args() });
    const first = keyOf(result.current);
    rerender(args({ shown: false }));
    expect(result.current).toBeUndefined();
    rerender(args());
    const second = keyOf(result.current);
    expect(second).not.toBe(first);
    await flush();
    expect(watch.calls).toEqual([`show:${first}`, `hide:${first}`, `show:${second}`]);
  });

  it('載せない QR に変わったら (通貨・支払い方法の変更で url が空) bill key を外して hide', async () => {
    const { result, rerender } = renderHook((p: QrBillKeyArgs) => useQrBillKey(p), { initialProps: args() });
    const first = keyOf(result.current);
    rerender(args({ url: '' }));
    expect(result.current).toBeUndefined();
    await flush();
    expect(watch.calls).toEqual([`show:${first}`, `hide:${first}`]);
  });

  it('部品が外れたら (タブの切り替え) hide だけ。見張りは止めない', async () => {
    const { result, unmount } = renderHook(() => useQrBillKey(args()));
    const billKey = keyOf(result.current);
    unmount();
    await flush();
    expect(watch.calls).toEqual([`show:${billKey}`, `hide:${billKey}`]);
  });

  it('レジ (/checkout) の QR は kind と URL をそのまま渡す (値引きの行の名前は空)', async () => {
    const url = 'https://shop.test/checkout?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&items=Tea:1:500&gas=merchant';
    const { result } = renderHook(() => useQrBillKey({ kind: 'checkout', url, shown: true }));
    const billKey = keyOf(result.current, url);
    await flush();
    expect(watch.shown).toEqual([{ billKey, kind: 'checkout', url, itemName: '' }]);
  });

  it('StrictMode (effect の二重): 描く bill key は 1 つで、見張りには 出す → やめる → 出す が同じ bill key で届く', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result, rerender } = renderHook((p: QrBillKeyArgs) => useQrBillKey(p), { initialProps: args(), wrapper });
    const billKey = keyOf(result.current);
    rerender(args());
    expect(keyOf(result.current)).toBe(billKey);
    await flush();
    expect(new Set(watch.shown.map((s) => s.billKey))).toEqual(new Set([billKey]));
    // 最後は「出す」で終わる (表示中)。
    expect(watch.calls.at(-1)).toBe(`show:${billKey}`);
    expect(watch.calls.filter((c) => c.startsWith('hide:')).every((c) => c === `hide:${billKey}`)).toBe(true);
  });

  it('見張りの関数が throw しても、画面には何も波及しない (bill key つきの URL はそのまま・未処理の reject なし)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      watch.throwOnShow = true;
      const { result, rerender } = renderHook((p: QrBillKeyArgs) => useQrBillKey(p), { initialProps: args() });
      const first = keyOf(result.current);
      await flush();
      rerender(args({ url: URL_B }));
      expect(keyOf(result.current, URL_B)).not.toBe(first);
      await flush();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('useQrSaleWatchScope — /create を離れたら見張りを止める', () => {
  it('ページの部品が外れたら stop を 1 回。表示中の QR の部品の hide の後に届く', async () => {
    const page = renderHook(() => useQrSaleWatchScope());
    const qr = renderHook(() => useQrBillKey(args()));
    const billKey = keyOf(qr.result.current);
    await flush();
    // タブの切り替え (QR の部品だけが外れる) では止めない。
    qr.unmount();
    await flush();
    expect(watch.calls).toEqual([`show:${billKey}`, `hide:${billKey}`]);
    page.unmount();
    await flush();
    expect(watch.calls).toEqual([`show:${billKey}`, `hide:${billKey}`, 'stop']);
  });

  it('再描画では止めない', async () => {
    const page = renderHook(() => useQrSaleWatchScope());
    page.rerender();
    page.rerender();
    await flush();
    expect(watch.calls).toEqual([]);
    page.unmount();
    await waitFor(() => expect(watch.calls).toEqual(['stop']));
  });
});
