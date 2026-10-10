// 店舗の設定 (useLocalStorageSettings) を複数のタブで開いたときの保存と取り込み (第 7 回レビュー D10)。
// jsdom の 1 つの window で hook を 2 つ描画し、同じ localStorage を共有する 2 つのタブに見立てる。
// - 保存は「最新の保存値を読み直し、このタブで変えたキーだけを重ねる」(古いタブの値で別のタブの変更を消さない)。
// - Web Locks があればロックの中で行う (ほぼ同時に書いても片方が消えない)。無い・拒否されたときも同じ書き込みをする。
// - 取り込みは前面に戻ったとき (focus / visibilitychange) だけ。検証済みの値だけ・未保存の変更には触れない。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createContext, createElement, useCallback, useContext, type ReactNode } from 'react';
import { getAddress, type Address } from 'viem';
import { useLocalStorageSettings } from '@/hooks/useLocalStorageSettings';
import { useQrSettings, withChain } from '@/hooks/useQrSettings';
import { useTipSettings } from '@/hooks/useTipSettings';
import { useMobileOrderDraft } from '@/hooks/useMobileOrderDraft';
import { useHandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import { useProductPresets } from '@/hooks/useProductPresets';
import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';

const useAccountMock = vi.fn();
vi.mock('wagmi', () => ({ useAccount: () => useAccountMock() }));

// タブごとに別のウォレットへ接続している状態 (useAccount がタブの Provider の値を返す)。
const TabWallet = createContext<Address | undefined>(undefined);
function useTabWallet() {
  const address = useContext(TabWallet);
  return address ? { address, isConnected: true } : { address: undefined, isConnected: false };
}

const KEY = 'openpay:qr-settings:v2';
const R0: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const R1: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const CONNECTED: Address = getAddress('0xcccccccccccccccccccccccccccccccccccccccc');
const INVOICE = 'T1234567890123';

type Pair = { limit: number; value: number };
const PAIR_KEY = 'test:pair';
function sanitizePair(loaded: Partial<Pair>): Pair {
  const limit = typeof loaded.limit === 'number' ? loaded.limit : 10;
  const value = typeof loaded.value === 'number' ? loaded.value : 0;
  return { limit, value: Math.min(value, limit) };
}

const stored = (key = KEY) => JSON.parse(window.localStorage.getItem(key) ?? 'null');

function setLocks(value: unknown) {
  Object.defineProperty(window.navigator, 'locks', { value, configurable: true });
}

/** 別のタブが前面に戻った (window の focus)。 */
function focusTab() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

/** 受け付けた順に、テストが grant() したときだけ中身を実行する Web Locks (同じ名前は 1 つずつ)。 */
function manualLocks() {
  const queue: (() => void)[] = [];
  const request = vi.fn(
    (_name: string, fn: () => unknown) =>
      new Promise((resolve, reject) => {
        queue.push(() => {
          try {
            resolve(fn());
          } catch (error) {
            reject(error);
          }
        });
      }),
  );
  return {
    request,
    waiting: () => queue.length,
    grant: async () => {
      await act(async () => {
        queue.shift()?.();
      });
    },
  };
}

/** 保存値を sanitize 済みの形にしておく (読み込み直後の移行の書き込みが起きない状態)。 */
async function seedCanonical(value: object) {
  window.localStorage.setItem(KEY, JSON.stringify(value));
  const seed = renderHook(() => useQrSettings());
  await waitFor(() => expect(seed.result.current.hydrated).toBe(true));
  seed.unmount();
}

async function twoQrTabs() {
  const a = renderHook(() => useQrSettings());
  const b = renderHook(() => useQrSettings());
  await waitFor(() => {
    expect(a.result.current.hydrated).toBe(true);
    expect(b.result.current.hydrated).toBe(true);
  });
  return { a: a.result, b: b.result };
}

beforeEach(() => {
  window.localStorage.clear();
  setLocks(undefined);
  useAccountMock.mockReset();
  useAccountMock.mockReturnValue({ address: undefined, isConnected: false });
});

afterEach(() => {
  setLocks(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('別のタブの古い値で上書きしない (D10)', () => {
  beforeEach(() => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: R0, receiverSource: 'manual' }));
  });

  it('B で受取先を変えたあと A でインボイス番号を変えても、保存は B の受取先と A のインボイス番号になる', async () => {
    const { a, b } = await twoQrTabs();
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));

    expect(stored().receiver).toBe(R1);
    expect(stored().invoiceNo).toBe(INVOICE);
    // 前面に戻ると、それぞれ相手の変更を取り込む (古い受取先で QR を作り続けない)。
    focusTab();
    expect(a.current.settings).toMatchObject({ receiver: R1, invoiceNo: INVOICE });
    expect(b.current.settings).toMatchObject({ receiver: R1, invoiceNo: INVOICE });
  });

  it('書いた直後には取り込まない (前面にないタブも自動補完などで書くため)・前面に戻ったときに取り込む', async () => {
    const { a, b } = await twoQrTabs();
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(a.current.settings.receiver).toBe(R0);
    expect(stored()).toMatchObject({ receiver: R1, storeName: 'カフェ' });
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
  });

  it('前面に戻ったタブは別のタブの変更を取り込み、その後の書き込みでも戻さない', async () => {
    const { a, b } = await twoQrTabs();
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    expect(a.current.settings.receiver).toBe(R0);

    focusTab();
    expect(a.current.settings.receiver).toBe(R1);

    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(stored()).toMatchObject({ receiver: R1, storeName: 'カフェ' });
  });

  it('タブの切り替え (visibilitychange) でも取り込む', async () => {
    const { a, b } = await twoQrTabs();
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(a.current.settings.receiver).toBe(R1);
  });

  it('同じ項目を両方のタブで変えたら、後から書いたタブの値が残り、もう片方は前面に戻ったときに揃う', async () => {
    const { a, b } = await twoQrTabs();
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'A 店' })));
    act(() => b.current.setSettings((s) => ({ ...s, storeName: 'B 店' })));
    expect(stored().storeName).toBe('B 店');
    focusTab();
    expect(a.current.settings.storeName).toBe('B 店');
  });

  it('保存値と揃っているときは書かない (読み込んだだけで別のタブの変更を書き戻さない)', async () => {
    const { a } = await twoQrTabs();
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: R1 }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => a.current.setSettings((s) => ({ ...s })));
    expect(setItem).not.toHaveBeenCalled();
    expect(stored().receiver).toBe(R1);
  });
});

describe('ほかの設定も同じ基盤で守られる', () => {
  it('チップ: 受取先とページ名', async () => {
    const a = renderHook(() => useTipSettings()).result;
    const b = renderHook(() => useTipSettings()).result;
    await waitFor(() => expect(a.current.hydrated && b.current.hydrated).toBe(true));
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1, receiverSource: 'manual' })));
    act(() => a.current.setSettings((s) => ({ ...s, name: 'ちいさな店' })));
    expect(stored('openpay:tip-settings:v2')).toMatchObject({ receiver: R1, name: 'ちいさな店' });
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
  });

  it('モバイル注文: 受取先と店名', async () => {
    const a = renderHook(() => useMobileOrderDraft()).result;
    const b = renderHook(() => useMobileOrderDraft()).result;
    await waitFor(() => expect(a.current.hydrated && b.current.hydrated).toBe(true));
    act(() => b.current.setReceiver(R1, 'manual'));
    act(() => a.current.setSettings((s) => ({ ...s, shopName: 'ちいさな店' })));
    expect(stored('openpay:mobile-order-draft:v1')).toMatchObject({ receiver: R1, shopName: 'ちいさな店' });
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
  });

  it('@handle の下書き: 受取先と自己紹介', async () => {
    const a = renderHook(() => useHandleProfileDraft()).result;
    const b = renderHook(() => useHandleProfileDraft()).result;
    await waitFor(() => expect(a.current.hydrated && b.current.hydrated).toBe(true));
    act(() => b.current.setSettings((s) => ({ ...s, to: R1 })));
    act(() => a.current.setSettings((s) => ({ ...s, bio: 'こんにちは' })));
    expect(stored('openpay:handle-profile-draft:v1')).toMatchObject({ to: R1, bio: 'こんにちは' });
    focusTab();
    expect(a.current.settings.to).toBe(R1);
  });

  it('商品: B で追加した商品を、A の管理番号の採番で消さない', async () => {
    const a = renderHook(() => useProductPresets()).result;
    const b = renderHook(() => useProductPresets()).result;
    await waitFor(() => expect(a.current.hydrated && b.current.hydrated).toBe(true));
    act(() =>
      b.current.addPreset({
        name: 'ステッカー',
        unitPrice: '200',
        token: 'jpyc',
        taxRate: 10,
        taxCategory: 'taxable_10',
        memo: null,
        enabled: true,
      }),
    );
    act(() => {
      a.current.nextReceiptNo();
    });
    const saved = stored('openpay:product-presets:v1');
    expect(saved.presets.map((p: { name: string }) => p.name)).toContain('ステッカー');
    expect(saved.receipt.n).toBe(1);
    focusTab();
    expect(a.current.presets.map((p) => p.name)).toContain('ステッカー');
  });
});

describe('ほぼ同時の書き込み (Web Locks)', () => {
  beforeEach(async () => {
    await seedCanonical({ receiver: R0, receiverSource: 'manual' });
  });

  it('2 つのタブの書き込みは同じ名前のロックで 1 つずつ行い、後のタブは先のタブの変更に重ねて書く', async () => {
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const { a, b } = await twoQrTabs();
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    // ロックが下りるまでは書かない。
    expect(locks.waiting()).toBe(2);
    expect(stored().invoiceNo).toBe('');
    expect(locks.request).toHaveBeenCalledWith('openpay:settings-write:openpay:qr-settings:v2', expect.any(Function));

    await locks.grant();
    await locks.grant();
    expect(stored()).toMatchObject({ receiver: R1, invoiceNo: INVOICE });
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
    expect(b.current.settings.invoiceNo).toBe(INVOICE);
  });

  it('ロックを待つ間に別のタブが書いた値は、ロックの中で読み直して残す', async () => {
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const { a } = await twoQrTabs();
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    // A がロックを待っている間に、別のタブ (別のプロセス) が受取先を書いた。
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: R1 }));
    await locks.grant();
    expect(stored()).toMatchObject({ receiver: R1, invoiceNo: INVOICE });
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
  });

  it('書き込みを待つ間に前面に戻っても、このタブの未保存の変更は取り込みで消さず、後から書いて残す', async () => {
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const { a } = await twoQrTabs();
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: R1, invoiceNo: 'T9999999999999' }));
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
    expect(a.current.settings.invoiceNo).toBe(INVOICE);

    await locks.grant();
    expect(stored()).toMatchObject({ receiver: R1, invoiceNo: INVOICE });
  });

  it('続けて変えた分はロックを 1 つだけ待ち、下りたときの最新をまとめて書く', async () => {
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const { a } = await twoQrTabs();
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カ' })));
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(locks.waiting()).toBe(1);
    await locks.grant();
    expect(stored().storeName).toBe('カフェ');
    expect(locks.waiting()).toBe(0);
  });

  it('通貨・チェーン・支払い方法は組で同期する: 別のタブで通貨・このタブでチェーンを同時に変えても、崩れた組み合わせを作らない', async () => {
    await seedCanonical({ receiver: R0, receiverSource: 'manual', token: 'usdc', chain: 'base' });
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const a = renderHook(() => useQrSettings()).result;
    await waitFor(() => expect(a.current.hydrated).toBe(true));
    expect(locks.waiting()).toBe(0);
    act(() => a.current.setSettings((s) => withChain(s, 'arbitrum')));
    // 別のタブが通貨を JPYC (Polygon) に切り替えた (その値だけを見れば正しい組み合わせ)。
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), token: 'jpyc', chain: 'polygon' }));
    focusTab();
    // JPYC × Arbitrum という組み合わせを作らない (このタブは自分の正しい組み合わせのまま)。
    expect(a.current.settings.token).toBe('usdc');
    expect(a.current.settings.chain).toBe('arbitrum');
    await locks.grant();
    expect(a.current.settings.token).toBe('usdc');
    expect(a.current.settings.chain).toBe('arbitrum');
    // 保存も組ごと (このタブの USDC × Arbitrum)。JPYC × Arbitrum を保存して、再読み込みで Polygon に戻されない。
    expect(stored()).toMatchObject({ token: 'usdc', chain: 'arbitrum', receiver: R0 });
    const reloaded = renderHook(() => useQrSettings()).result;
    await waitFor(() => expect(reloaded.current.hydrated).toBe(true));
    expect(reloaded.current.settings).toMatchObject({ token: 'usdc', chain: 'arbitrum', payMode: a.current.settings.payMode });
  });

  it('宣言していない組み合わせが重ねて崩れるときは書かず、このタブの変更を取り下げて保存値を出す', async () => {
    // value は limit 以下 (sanitize が組み合わせで値を決める)。組を宣言しない (= 安全網だけで守る) 場合。
    window.localStorage.setItem(PAIR_KEY, JSON.stringify({ limit: 10, value: 5 }));
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const a = renderHook(() => useLocalStorageSettings<Pair>(PAIR_KEY, { limit: 10, value: 0 }, sanitizePair)).result;
    await waitFor(() => expect(a.current.hydrated).toBe(true));
    act(() => a.current.setSettings((s) => ({ ...s, value: 8 })));
    // ロックを待つ間に、別のタブが上限を 6 に下げた。
    window.localStorage.setItem(PAIR_KEY, JSON.stringify({ limit: 6, value: 5 }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await locks.grant();
    // { limit: 6, value: 8 } (再読み込みで value が 6 に直される) を保存しない。
    expect(setItem).not.toHaveBeenCalled();
    expect(stored(PAIR_KEY)).toEqual({ limit: 6, value: 5 });
    expect(a.current.settings).toEqual({ limit: 6, value: 5 });
    const reloaded = renderHook(() => useLocalStorageSettings<Pair>(PAIR_KEY, { limit: 10, value: 0 }, sanitizePair)).result;
    await waitFor(() => expect(reloaded.current.hydrated).toBe(true));
    expect(reloaded.current.settings).toEqual({ limit: 6, value: 5 });
  });

  it('読み込み直後の移行の書き込みも、読み込んでから別のタブが書いた値を既定値で消さない', async () => {
    // 旧形式 (必須の項目が欠けた) の保存値。2 つのタブとも読み込み直後に移行の書き込みをする。
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: R0, receiverSource: 'manual' }));
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const { a, b } = await twoQrTabs();
    expect(locks.waiting()).toBe(2);
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    await locks.grant();
    await locks.grant();
    // B の移行は、A が書いたインボイス番号を既定値 (空) で上書きしない。
    expect(stored()).toMatchObject({ receiver: R1, invoiceNo: INVOICE, token: 'jpyc', chain: 'polygon' });
    focusTab();
    expect(b.current.settings.invoiceNo).toBe(INVOICE);
  });

  it('ロックを拒否されても (sandbox の iframe 等) 保存は止めない', async () => {
    setLocks({ request: vi.fn(() => Promise.reject(new DOMException('denied', 'SecurityError'))) });
    const { a, b } = await twoQrTabs();
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    await waitFor(() => expect(stored().receiver).toBe(R1));
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    await waitFor(() => expect(stored()).toMatchObject({ receiver: R1, invoiceNo: INVOICE }));
  });
});

describe('Web Locks・BroadcastChannel が無いブラウザ (古い Safari 等)', () => {
  beforeEach(() => {
    setLocks(undefined);
    vi.stubGlobal('BroadcastChannel', undefined);
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: R0, receiverSource: 'manual' }));
  });

  it('従来どおりその場で保存し、変えたキーだけを最新の保存値に重ねる', async () => {
    const { a, b } = await twoQrTabs();
    act(() => b.current.setSettings((s) => ({ ...s, receiver: R1 })));
    expect(stored().receiver).toBe(R1);
    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    expect(stored()).toMatchObject({ receiver: R1, invoiceNo: INVOICE });
  });

  it('保存値が無ければ設定全体を書く (初めて開いたとき・従来と同じ)', async () => {
    window.localStorage.clear();
    const a = renderHook(() => useQrSettings()).result;
    await waitFor(() => expect(a.current.hydrated).toBe(true));
    expect(stored()).toEqual(a.current.settings);
  });
});

describe('取り込まない値 (受取先を別のウォレットに変えない)', () => {
  /** 決済QR タブと同じ組み合わせ: 設定 + 接続ウォレットからの自動補完。 */
  function useQrTab() {
    const { settings, setSettings, hydrated } = useQrSettings();
    const setReceiver = useCallback(
      (value: string, source: 'auto' | 'manual') => setSettings((s) => ({ ...s, receiver: value, receiverSource: source })),
      [setSettings],
    );
    const autofill = useReceiverAutofill({ receiver: settings.receiver, receiverSource: settings.receiverSource, effectiveReceiver: null, hydrated, setReceiver });
    return { settings, setSettings, hydrated, autofill };
  }

  beforeEach(() => {
    useAccountMock.mockReturnValue({ address: CONNECTED, isConnected: true });
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: R0, receiverSource: 'manual' }));
  });

  async function tab() {
    const r = renderHook(() => useQrTab()).result;
    await waitFor(() => expect(r.current.hydrated).toBe(true));
    expect(r.current.settings.receiver).toBe(R0);
    return r;
  }

  it('別のタブの保存値の受取先が不正な値なら取り込まず、空欄扱いの自動補完も走らない', async () => {
    const a = await tab();
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: 123, storeName: 'カフェ' }));
    focusTab();
    expect(a.current.settings.receiver).toBe(R0);
    // 正しい値 (店名) は取り込む。
    expect(a.current.settings.storeName).toBe('カフェ');
  });

  it('別のタブで受取先を空欄にしても取り込まず、自動補完で接続ウォレットに変わらない (B の空欄は保存値に残す)', async () => {
    const a = await tab();
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: '', receiverSource: 'manual' }));
    focusTab();
    expect(a.current.settings.receiver).toBe(R0);
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(a.current.settings.receiver).toBe(R0);
    expect(stored()).toMatchObject({ receiver: '', storeName: 'カフェ' });
    expect(stored().receiver).not.toBe(CONNECTED);
  });

  it.each([
    ['0x の途中', '0x1234'],
    ['名前の打ちかけ', 'shop.et'],
    ['ラベルの欠けた名前', '.eth'],
    ['前後の空白', ` ${R1}`],
  ])('受取先が確定していない値 (%s) は取り込まない', async (_label, receiver) => {
    const a = await tab();
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver }));
    focusTab();
    expect(a.current.settings.receiver).toBe(R0);
  });

  it('確定した受取先 (0x アドレス・名前) は取り込む', async () => {
    const a = await tab();
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: 'shop.base.eth' }));
    focusTab();
    expect(a.current.settings.receiver).toBe('shop.base.eth');
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: R1 }));
    focusTab();
    expect(a.current.settings.receiver).toBe(R1);
  });

  it('受取先とその由来は組で同期する: 未保存の手入力は、別のタブの「自動 (接続ウォレット)」で消えない', async () => {
    window.localStorage.clear();
    await seedCanonical({ receiver: R0, receiverSource: 'manual' });
    const locks = manualLocks();
    setLocks({ request: locks.request });
    const a = await tab();
    act(() => a.current.setSettings((s) => ({ ...s, receiver: R1, receiverSource: 'manual' })));
    // A がロックを待つ間に、別のタブが接続ウォレットを自動で入れた。
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: CONNECTED, receiverSource: 'auto' }));
    focusTab();
    expect(a.current.settings).toMatchObject({ receiver: R1, receiverSource: 'manual' });
    await locks.grant();
    expect(a.current.settings).toMatchObject({ receiver: R1, receiverSource: 'manual' });
    expect(stored()).toMatchObject({ receiver: R1, receiverSource: 'manual' });
    const reloaded = renderHook(() => useQrTab()).result;
    await waitFor(() => expect(reloaded.current.hydrated).toBe(true));
    expect(reloaded.current.settings).toMatchObject({ receiver: R1, receiverSource: 'manual' });
  });

  it('受取先だけを変えても由来と一緒に書く (別のタブの「自動」と手入力の受取先の組み合わせを保存しない)', async () => {
    const a = await tab();
    // A が取り込む前に、別のタブが接続ウォレットを自動で入れた。
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), receiver: CONNECTED, receiverSource: 'auto' }));
    act(() => a.current.setSettings((s) => ({ ...s, receiver: R1 })));
    expect(stored()).toMatchObject({ receiver: R1, receiverSource: 'manual' });
  });

  it.each([
    ['Web Locks あり', true],
    ['Web Locks なし', false],
  ])(
    '別のウォレットに接続した 2 つのタブ: B で「接続中のウォレットを使う」を保存しても、取り込んだ A は自分のウォレットに置き換えない (%s)',
    async (_label, withLocks) => {
      const WA = getAddress('0x1010101010101010101010101010101010101010');
      const WB = getAddress('0x2020202020202020202020202020202020202020');
      const WA2 = getAddress('0x3030303030303030303030303030303030303030');
      window.localStorage.clear();
      await seedCanonical({ receiver: R0, receiverSource: 'manual' });
      const locks = manualLocks();
      setLocks(withLocks ? { request: locks.request } : undefined);
      const flush = async () => {
        while (locks.waiting() > 0) await locks.grant();
      };
      useAccountMock.mockImplementation(useTabWallet);
      let walletA: Address = WA;
      const wrapA = ({ children }: { children: ReactNode }) => createElement(TabWallet.Provider, { value: walletA }, children);
      const wrapB = ({ children }: { children: ReactNode }) => createElement(TabWallet.Provider, { value: WB }, children);
      const a = renderHook(() => useQrTab(), { wrapper: wrapA });
      const b = renderHook(() => useQrTab(), { wrapper: wrapB });
      await waitFor(() => expect(a.result.current.hydrated && b.result.current.hydrated).toBe(true));
      expect(a.result.current.settings).toMatchObject({ receiver: R0, receiverSource: 'manual' });

      act(() => b.result.current.autofill.useConnectedWallet());
      await flush();
      expect(stored()).toMatchObject({ receiver: WB, receiverSource: 'auto' });

      // A を前面に戻す: B の受取先 (自動) を取り込むが、A の接続ウォレットへは置き換えない (A ではウォレットを切り替えていない)。
      focusTab();
      await flush();
      expect(a.result.current.settings).toMatchObject({ receiver: WB, receiverSource: 'auto' });
      expect(stored()).toMatchObject({ receiver: WB, receiverSource: 'auto' });

      // その後に A のウォレットが実際に切り替わったときは、従来どおり追従する。
      walletA = WA2;
      a.rerender();
      await flush();
      expect(a.result.current.settings).toMatchObject({ receiver: WA2, receiverSource: 'auto' });
      expect(stored()).toMatchObject({ receiver: WA2, receiverSource: 'auto' });
    },
  );

  it('別のタブが保存値を消しても (clear・削除) 取り込まず、次の保存で設定全体を書き戻す', async () => {
    const a = await tab();
    window.localStorage.clear();
    focusTab();
    expect(a.current.settings.receiver).toBe(R0);
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(stored()).toMatchObject({ receiver: R0, receiverSource: 'manual', storeName: 'カフェ' });
  });

  it('保存値が壊れていても (JSON でない・配列) 取り込まず、次の保存で直す', async () => {
    const a = await tab();
    window.localStorage.setItem(KEY, '{broken');
    focusTab();
    window.localStorage.setItem(KEY, '[1,2]');
    focusTab();
    expect(a.current.settings.receiver).toBe(R0);
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(stored()).toMatchObject({ receiver: R0, storeName: 'カフェ' });
  });

  it('必須の項目が消えた保存値 (古い版のタブが書いた等) では、その項目を既定値で取り込まない', async () => {
    const a = await tab();
    const { receiver: _drop, ...rest } = stored();
    window.localStorage.setItem(KEY, JSON.stringify(rest));
    focusTab();
    expect(a.current.settings.receiver).toBe(R0);
  });
});

describe('localStorage の例外', () => {
  it('書けなかった変更は保存済みにせず、次に書けたときにまとめて書く', async () => {
    await seedCanonical({ receiver: R0, receiverSource: 'manual' });
    const a = renderHook(() => useQrSettings()).result;
    await waitFor(() => expect(a.current.hydrated).toBe(true));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(stored().storeName).toBe('');

    act(() => a.current.setSettings((s) => ({ ...s, invoiceNo: INVOICE })));
    expect(stored()).toMatchObject({ receiver: R0, storeName: 'カフェ', invoiceNo: INVOICE });
  });

  it('読めない (private mode 等で getItem が投げる) ときは既定値で動き、例外を出さない', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const a = renderHook(() => useQrSettings()).result;
    await waitFor(() => expect(a.current.hydrated).toBe(true));
    expect(a.current.settings.receiver).toBe('');
    act(() => a.current.setSettings((s) => ({ ...s, storeName: 'カフェ' })));
    focusTab();
    expect(a.current.settings.storeName).toBe('カフェ');
  });
});
