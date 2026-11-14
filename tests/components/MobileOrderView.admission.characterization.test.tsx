// モバイル注文の画面 (MobileOrderView) の、注文を送る流れ・時間の経過・カートの境目を、今の動きのまま固定する。
//
// 見るのは画面 (role と name)・「支払いへ進む」の行き先の URL・受付の確認 (POST /api/order/admission) の本文・
// window.location.assign・localStorage だけで、部品の中の state や関数の名前には触れない。
// mock は境界 (env の flag・origin・fetch・window.location・乱数・時計) だけに置く。作りは MobileOrderView.test.tsx と同じ。
//
// 行き先の URL は「origin と path」と「query の全部の key と値」を比べる (key の並びには依らない)。
// 題に「(今の動き)」と付けた行は、こうあるべきという主張ではなく、今こう動いているという記録。
// 付けていない行のうち、「待っている間に注文を変えたら、待っていた確認は使わない」と「前回の注文の保存に売り切れの品を
// 残さない」と「受付を確かめられなかっただけのときは、止まった表示にせず、押し直せるままにする (進むのは、その押した
// 確認が通ったときだけ)」は、守る約束。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act, Profiler } from 'react';
import { formatUnits } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

// flag は既定 OFF。test ごとに立てて、afterEach で戻す (MobileOrderView.test.tsx と同じ形)。
const envHold = vi.hoisted(() => ({
  enableOrderRelay: false,
  enableMobileOrderFee: false,
  enableShopLive: false,
  enableMenuOptions: false,
  enablePreorderTime: false,
  enableOrderMemo: false,
  enableOrderCall: false,
}));
const originHold = vi.hoisted(() => ({ value: 'https://test.local' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return envHold.enableOrderRelay;
      },
      get enableMobileOrderFee() {
        return envHold.enableMobileOrderFee;
      },
      get enableShopLive() {
        return envHold.enableShopLive;
      },
      get enableMenuOptions() {
        return envHold.enableMenuOptions;
      },
      get enablePreorderTime() {
        return envHold.enablePreorderTime;
      },
      get enableOrderMemo() {
        return envHold.enableOrderMemo;
      },
      get enableOrderCall() {
        return envHold.enableOrderCall;
      },
    },
  };
});
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => originHold.value,
}));

import { MobileOrderView } from '@/components/MobileOrderView';
import { buildPayerReceipt } from '@/lib/payerReceipt';
import { calcCheckoutPayable, CHECKOUT_QTY_MAX, parseCheckoutParams } from '@/lib/url';
import type { MobileOrderConfig } from '@/lib/mobileOrder';
import type { ShopLiveState } from '@/lib/shopLive';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';

// ---------------------------------------------------------------------------------------------------------------------
// 店の設定
// ---------------------------------------------------------------------------------------------------------------------
const RECEIVER = '0x1111111111111111111111111111111111111111';
const HANDLE = 'coffee_shop';
const JPYC_DECIMALS = 18;

const config: MobileOrderConfig = {
  receiver: RECEIVER,
  chain: 'polygon',
  shopName: 'テスト珈琲店',
  mode: 'storefront',
  feePayer: 'merchant',
  socials: [],
  menu: [
    { id: 'a', name: 'ブレンド', price: '500', taxRate: 10, taxCategory: 'taxable_10' },
    { id: 'b', name: 'チーズケーキ', price: '650' },
    { id: 'c', name: '水', price: '100', taxRate: 8, taxCategory: 'taxable_8' },
  ],
};

// オプションつきの品 (大盛り +200・えび +150) と、オプションのない品。
const optionConfig: MobileOrderConfig = {
  ...config,
  menu: [
    {
      id: 'gyudon',
      name: '牛丼',
      price: '500',
      options: [
        {
          id: 'g1',
          name: 'サイズ',
          type: 'single',
          required: true,
          choices: [
            { id: 's', label: '小盛り', priceDelta: '0' },
            { id: 'l', label: '大盛り', priceDelta: '200' },
          ],
        },
        {
          id: 'g2',
          name: 'トッピング',
          type: 'multi',
          choices: [{ id: 'ebi', label: 'えび', priceDelta: '150' }],
        },
      ],
    },
    { id: 'water', name: '水', price: '100' },
  ],
};

// 東京 2024-01-15 12:00:00 (15 分の境目)。受け取りの枠とラストオーダーの判定を決まった値にする。
const TOKYO_NOON = Date.UTC(2024, 0, 15, 3, 0);
const tokyo = (hour: number, minute: number, second = 0) =>
  Date.UTC(2024, 0, 15, hour - 9, minute, second);

const TEXT = {
  pay: '支払いへ進む',
  plus: '数量を増やす',
  minus: '数量を減らす',
  closed: 'ただいま注文を受け付けていません',
  pastLastOrder: '本日のラストオーダーを過ぎました',
  tooMany: '一度に注文できるのは 10 品までです',
  soldOut: '売り切れ',
  pickup: '受取時間',
  pickupAsap: '最短（指定なし）',
  // 受付の確認が通らなかったときの、支払い欄の案内 (承認済みの字のまま)。
  retryNotice: 'お支払いへ進めませんでした。少し待ってから、もう一度「支払いへ進む」を押してください。',
  slotNotice:
    '選んだ受取時間を過ぎたため、受取時間を「最短（指定なし）」に戻しました。ほかの時間がよければ選び直してください。',
};

// ---------------------------------------------------------------------------------------------------------------------
// 境界の受け皿
// ---------------------------------------------------------------------------------------------------------------------
let assignSpy: ReturnType<typeof vi.fn<(url: string) => void>>;
let originalLocation: PropertyDescriptor | undefined;
let fetchSpy: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

const admitted = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TOKYO_NOON);
  // 既定は「受け付けた」。test ごとに差し替える。
  fetchSpy = vi.fn(async () => admitted());
  vi.stubGlobal('fetch', fetchSpy);
  // 受付の確認の後の移動 (window.location.assign) を受け止める。
  assignSpy = vi.fn();
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: assignSpy },
  });
});

afterEach(() => {
  envHold.enableOrderRelay = false;
  envHold.enableMobileOrderFee = false;
  envHold.enableShopLive = false;
  envHold.enableMenuOptions = false;
  envHold.enablePreorderTime = false;
  envHold.enableOrderMemo = false;
  envHold.enableOrderCall = false;
  originHold.value = 'https://test.local';
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方・操作 (名前つき)
// ---------------------------------------------------------------------------------------------------------------------
/** メニューの品のカード (品の名前で探す)。カートの明細を開いていない間だけ使う (明細にも同じ名前が出るため)。 */
function menuCard(name: string): HTMLElement {
  const cards = screen
    .getAllByRole('listitem')
    .filter((li) => within(li).queryByText(name) !== null);
  if (cards.length !== 1) throw new Error(`menu card "${name}": ${cards.length} 件`);
  return cards[0];
}
/** メニューの「＋」を times 回押す (1 回目で「＋」が「− n ＋」に替わるので、毎回取り直す)。 */
function add(name: string, times = 1) {
  for (let i = 0; i < times; i++) {
    fireEvent.click(within(menuCard(name)).getByRole('button', { name: TEXT.plus }));
  }
}
function removeOne(name: string) {
  fireEvent.click(within(menuCard(name)).getByRole('button', { name: TEXT.minus }));
}
/** オプションつきの牛丼を「大盛り・えび」で 1 つ入れる (同じ選び方は同じ行の数量が増える)。 */
function addGyudonLargeWithShrimp() {
  fireEvent.click(within(menuCard('牛丼')).getByRole('button', { name: /選ぶ/ }));
  fireEvent.click(screen.getByRole('radio', { name: /大盛り/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /えび/ }));
  fireEvent.click(screen.getByRole('button', { name: 'カートに追加' }));
}

/** 開いた明細の行 (品の名前で探す)。メニューのカードにも同じ名前があるときは、後ろ (明細) の方。 */
function cartLine(name: string): HTMLElement {
  const items = screen
    .getAllByRole('listitem')
    .filter((li) => within(li).queryByText(name) !== null);
  if (items.length === 0) throw new Error(`cart line "${name}": 0 件`);
  return items[items.length - 1];
}

const payLink = () => screen.queryByRole('link', { name: TEXT.pay });
const payButton = () => screen.queryByRole('button', { name: TEXT.pay });
/** 支払い欄の案内 (role="alert")。この画面で alert はこれだけ。出ていなければ null。 */
const notice = () => screen.queryByRole('alert');
/** 受付の確認を断る応答 (本文は route と同じ形)。 */
const refused = (status: number, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** 応答の本文を読み終えるまで待つ (本文を読むのは 409 のときだけ)。 */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}
/** 支払い欄 (下のカートバー) の合計のボタン。 */
const cartToggle = () => screen.queryByRole('button', { name: /ご注文内容/ });

function payHref(): string {
  const link = payLink();
  if (!link) throw new Error('「支払いへ進む」の link が無い');
  return link.getAttribute('href') ?? '';
}

/**
 * 行き先の URL を読む。origin と path はここで比べる (どの URL も https://test.local/checkout)。
 * query は全部の key と値を返す。同じ key が 2 回出たら落とす (全部を比べるため)。
 */
function readCheckoutUrl(href: string) {
  const url = new URL(href);
  expect(`${url.origin}${url.pathname}`).toBe('https://test.local/checkout');
  const keys = [...url.searchParams.keys()];
  expect(new Set(keys).size).toBe(keys.length);
  expect(url.hash).toBe('');
  return {
    query: Object.fromEntries(url.searchParams.entries()),
    /** /checkout が URL から作り直す支払額 (小計 − 値引き)。利用料の上乗せは含まない。 */
    payable: () => {
      const parsed = parseCheckoutParams(url.searchParams);
      if (!parsed.ok) throw new Error('/checkout が読めない URL');
      return formatUnits(calcCheckoutPayable(parsed.params, JPYC_DECIMALS), JPYC_DECIMALS);
    },
  };
}

/** URL の items の 1 行 (名前は encodeURIComponent・税つきは 6 区切り)。 */
const item = (name: string, qty: number, price: string, tax = '') =>
  `${encodeURIComponent(name)}:${qty}:${price}${tax}`;

/** 受付の確認の POST の本文 (JSON)。 */
const postedBodies = () =>
  fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as unknown);

/** 「支払いへ進む」を押して、受付の確認の応答の後まで待つ。返り値 = click が既定の動き (link の移動) を止めたか。 */
async function pressPay(): Promise<{ defaultPrevented: boolean }> {
  const link = payLink();
  if (!link) throw new Error('「支払いへ進む」の link が無い');
  let notPrevented = true;
  await act(async () => {
    notPrevented = fireEvent.click(link);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return { defaultPrevented: !notPrevented };
}

/** 外から解決する fetch (応答を待っている間の画面を見る)。 */
function gatedFetch() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  fetchSpy.mockImplementation(() => promise);
  const settle = async (fn: () => void) => {
    await act(async () => {
      fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  };
  return {
    admit: () => settle(() => resolve(admitted())),
    respond: (response: Response) => settle(() => resolve(response)),
    fail: () => settle(() => reject(new TypeError('Failed to fetch'))),
  };
}

/** 呼ばれるたびに別の応答を待つ fetch。何本目 (0 始まり) の応答かを選んで、外から返す。 */
function gatedFetches() {
  const gates: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  fetchSpy.mockImplementation(
    () =>
      new Promise<Response>((resolve, reject) => {
        gates.push({ resolve, reject });
      }),
  );
  const settle = async (fn: () => void) => {
    await act(async () => {
      fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  };
  return {
    admit: (index: number) => settle(() => gates[index].resolve(admitted())),
    respond: (index: number, response: Response) => settle(() => gates[index].resolve(response)),
    fail: (index: number) => settle(() => gates[index].reject(new TypeError('Failed to fetch'))),
  };
}

/** 受付番号を決まった値にする (乱数の 0,1,2,3,4,5 → "234567")。 */
function fixOrderCode() {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((buf) => {
    (buf as Uint32Array).set([0, 1, 2, 3, 4, 5]);
    return buf;
  });
}

const live = (soldOut: string[], updatedAt = 1): ShopLiveState => ({
  soldOut,
  paused: false,
  updatedAt,
});

const LAST_ORDER_KEY = `openpay:last-order:v1:h:${HANDLE}`;
/** この端末に保存してある「前回の注文」の cart (無ければ null)。 */
const savedCart = () =>
  (JSON.parse(window.localStorage.getItem(LAST_ORDER_KEY) ?? 'null') as { cart: unknown } | null)
    ?.cart ?? null;
/** 支払い済みの「前回の注文」をこの端末に置く (1 分前に進んで、その 30 秒後に確定した控えがある)。 */
function seedPaidLastOrder(cart: { id: string; qty: number }[]) {
  const ts = TOKYO_NOON - 60_000;
  window.localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ receiver: RECEIVER, cart, ts }));
  window.localStorage.setItem(
    'openpay:payerReceipts:v1',
    JSON.stringify([
      buildPayerReceipt(
        { asset: 'jpyc', amount: '100', merchantAddress: RECEIVER, txHash: `0x${'cd'.repeat(32)}` },
        new Date(ts + 30_000),
      ),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. 注文を送る流れ: 受付の確認 (admission) を通る経路 = @handle の店 + 時間の flag ON
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 「支払いへ進む」: 受付の確認を通る経路 (@handle + 時間の flag ON)', () => {
  beforeEach(() => {
    envHold.enablePreorderTime = true;
  });

  it('受け付けられたら、画面の link と同じ URL へ 1 回だけ移る (URL の全部・POST の本文の全部・受け取り時刻なし)', async () => {
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド', 2);
    add('水');
    expect(screen.getByText('1100 JPYC')).toBeInTheDocument();

    const href = payHref();
    const url = readCheckoutUrl(href);
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: [
        item('ブレンド', 2, '500', ':10:taxable_10:'),
        item('水', 1, '100', ':8:taxable_8:'),
      ].join(','),
      fee_kind: 'storefront',
      store_handle: HANDLE,
      store: 'テスト珈琲店',
    });
    // URL の額 (/checkout が作り直す支払額) = 画面の合計。
    expect(url.payable()).toBe('1100');

    const pressed = await pressPay();

    // link の既定の移動は止めて、受付の確認の後に自分で移る。
    expect(pressed.defaultPrevented).toBe(true);
    expect(fetchSpy.mock.calls).toEqual([
      [
        '/api/order/admission',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: expect.any(String),
        },
      ],
    ]);
    expect(postedBodies()).toEqual([{ handle: HANDLE, merchant: RECEIVER, mode: 'storefront' }]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    // 受け付けられた後は、止まった案内を出さない。
    expect(screen.queryByText(TEXT.closed)).toBeNull();
  });

  it('全部のせ (オプション・複数の品・値引き・お客様負担の利用料・店内・受け取り時刻・チェーン・受注の通知・戻り先): URL と POST の本文の全部', async () => {
    envHold.enableOrderRelay = true;
    envHold.enableMobileOrderFee = true;
    envHold.enableMenuOptions = true;
    fixOrderCode();
    renderWithIntl(
      <MobileOrderView
        config={{
          ...optionConfig,
          mode: 'preorder',
          feePayer: 'customer',
          chains: ['polygon', 'kaia'],
          dineIn: true,
          minLeadMinutes: 30,
          discount: { kind: 'percent', value: '10' },
          invoiceNo: 'T1234567890123',
        }}
        handle={HANDLE}
        backHref="/ja/@coffee_shop"
        backLabel="テスト珈琲店"
      />,
    );
    addGyudonLargeWithShrimp();
    addGyudonLargeWithShrimp(); // 牛丼（大盛り・えび）850 × 2 = 1,700
    add('水', 3); // 100 × 3 = 300 → 小計 2,000
    fireEvent.click(screen.getByRole('button', { name: 'JPYC (Kaia)' }));
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '7' } });
    const select = screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
    fireEvent.change(select, {
      target: { value: (within(select).getByRole('option', { name: '12:30' }) as HTMLOptionElement).value },
    });

    // 小計 2,000 − 値引き 10% (200) = 1,800。利用料 3% (54) はお客様に上乗せ → 画面の合計 1,854。
    expect(screen.getByText('1854 JPYC')).toBeInTheDocument();
    expect(screen.getByText('小計 2000 JPYC から 200 JPYC 値引き')).toBeInTheDocument();
    expect(screen.getByText('システム利用料 54 JPYC（3%）を含みます')).toBeInTheDocument();

    const href = payHref();
    const url = readCheckoutUrl(href);
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      chain: 'kaia',
      // オプションのない品 (メニューの順) が先、オプションの行 (入れた順) が後。
      items: [item('水', 3, '100'), item('牛丼（大盛り・えび）', 2, '850')].join(','),
      disc: '200',
      fee_kind: 'preorder',
      fee_payer: 'customer',
      order_id: '234567',
      description: 'テーブル 7',
      webhook: 'https://test.local/api/order/notify?h=coffee_shop',
      store_handle: HANDLE,
      store: 'テスト珈琲店',
      rcpt: '234567',
      inv: 'T1234567890123',
      pickup_at: String(tokyo(12, 30)),
      back: '/ja/@coffee_shop',
      backName: 'テスト珈琲店',
    });
    // URL の額 = 小計 − 値引き (利用料は /checkout が fee_kind と fee_payer から足す)。画面の 1,854 = 1,800 + 54。
    expect(url.payable()).toBe('1800');

    await pressPay();

    // POST の本文は 4 つだけ (値引き・明細・利用料の負担者は、この画面からは送らない)。
    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) },
    ]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  it('応答を待っている間は link が押せないボタンに替わり、押しても POST は 1 回・移るのも 1 回。応答の後はまた押せる', async () => {
    const gate = gatedFetch();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();

    fireEvent.click(payLink()!);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();
    fireEvent.click(payButton()!);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();

    await gate.admit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    // 応答の後は link に戻り、もう一度押すと 2 回目の確認を送る。
    expect(payLink()).not.toBeNull();
    fetchSpy.mockImplementation(async () => admitted());
    await pressPay();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(assignSpy.mock.calls).toEqual([[href], [href]]);
  });

  // 応答の後に進むのは「押した時点の URL」。待っている間にお客様が注文の中身を変えたら、待っていた確認は使わない
  // (移らない・止まった案内を出さない)。「支払いへ進む」は押し直せる状態に戻り、押し直すと新しい中身で確認を送る。
  it('待っている間に品を足すと、待っていた確認が 200 で返っても、足す前の URL へ移らない。押し直すと 2 本目の確認を送り、足した後の URL へ移る', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    fireEvent.click(payLink()!);
    expect(payButton()).toBeDisabled();

    add('水');
    await gate.admit(0);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    // 足したところで待ちが解けて、新しい合計の link が出ている。
    expect(screen.getByText('600 JPYC')).toBeInTheDocument();
    const next = payHref();
    expect(readCheckoutUrl(next).query).toEqual({
      ...readCheckoutUrl(href).query,
      items: [item('ブレンド', 1, '500', ':10:taxable_10:'), item('水', 1, '100', ':8:taxable_8:')].join(','),
    });
    expect(readCheckoutUrl(next).payable()).toBe('600');

    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(payButton()).toBeDisabled();
    await gate.admit(1);

    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it('確認が返ってこないままでも、注文を変えれば「支払いへ進む」を押し直せる。変えなければ押せないまま (今の動き)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);

    // 1 本目は返ってこない。変えなければ、時間が進んでも押せないまま。
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();

    add('ブレンド');

    expect(screen.getByText('1000 JPYC')).toBeInTheDocument();
    const next = payHref();
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await gate.admit(1);
    expect(assignSpy.mock.calls).toEqual([[next]]);
    expect(readCheckoutUrl(next).payable()).toBe('1000');
  });

  // 数量が「開いたときの値 (0)」へ戻る操作でも、今の数量 (1) から変わるので無効にする (比べる相手は今の数量)。
  it('待っている間に − で品を外してカートを空にすると、支払い欄が消え、待っていた確認が 200 で返っても移らない', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);

    removeOne('ブレンド');

    expect(cartToggle()).toBeNull();
    expect(payButton()).toBeNull();
    await gate.admit(0);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    // 入れ直すと、新しい確認から始まる。
    add('ブレンド');
    const next = payHref();
    fireEvent.click(payLink()!);
    await gate.admit(1);
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  // 操作の種類ごと。品: 牛丼 (オプションつき)・水・お茶。店内 (テーブル番号)・事前注文 (受け取りの枠)・チェーン 2 つ。
  // 押す前のカート: 牛丼（大盛り・えび）× 1 と 水 × 2、テーブル 7、枠は指定なし、チェーンは Polygon。
  const editConfig: MobileOrderConfig = {
    ...optionConfig,
    menu: [...optionConfig.menu, { id: 'tea', name: 'お茶', price: '50' }],
    mode: 'preorder',
    minLeadMinutes: 30,
    dineIn: true,
    chains: ['polygon', 'kaia'],
  };
  const GYUDON = '牛丼（大盛り・えび）';
  const openCart = () => fireEvent.click(cartToggle()!);
  const edits: {
    name: string;
    edit: () => void;
    /** 変えた後の URL の query で、押したときから変わる key。 */
    changed: Record<string, string>;
    /** 押し直した確認の本文に足されるもの。 */
    body?: Record<string, unknown>;
  }[] = [
    {
      name: 'メニューの ＋ (まだ入れていない品)',
      edit: () => add('お茶'),
      changed: { items: [item('水', 2, '100'), item('お茶', 1, '50'), item(GYUDON, 1, '850')].join(',') },
    },
    {
      name: 'メニューの ＋ (入れてある品)',
      edit: () => add('水'),
      changed: { items: [item('水', 3, '100'), item(GYUDON, 1, '850')].join(',') },
    },
    {
      name: 'メニューの −',
      edit: () => removeOne('水'),
      changed: { items: [item('水', 1, '100'), item(GYUDON, 1, '850')].join(',') },
    },
    {
      name: '「選ぶ」からオプションの品を足す',
      edit: () => addGyudonLargeWithShrimp(),
      changed: { items: [item('水', 2, '100'), item(GYUDON, 2, '850')].join(',') },
    },
    {
      name: '明細の行の ＋ (オプションの行)',
      edit: () => {
        openCart();
        fireEvent.click(within(cartLine(GYUDON)).getByRole('button', { name: TEXT.plus }));
      },
      changed: { items: [item('水', 2, '100'), item(GYUDON, 2, '850')].join(',') },
    },
    {
      name: '明細の行の − (オプションの行)',
      edit: () => {
        openCart();
        fireEvent.click(within(cartLine(GYUDON)).getByRole('button', { name: TEXT.minus }));
      },
      changed: { items: item('水', 2, '100') },
    },
    {
      name: '明細の行の − (オプションのない品)',
      edit: () => {
        openCart();
        fireEvent.click(within(cartLine('水')).getByRole('button', { name: TEXT.minus }));
      },
      changed: { items: [item('水', 1, '100'), item(GYUDON, 1, '850')].join(',') },
    },
    {
      name: 'テーブル番号',
      edit: () => fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '8' } }),
      changed: { description: 'テーブル 8' },
    },
    {
      name: '受け取りの枠',
      edit: () => {
        const select = screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
        fireEvent.change(select, {
          target: { value: (within(select).getByRole('option', { name: '12:45' }) as HTMLOptionElement).value },
        });
      },
      changed: { pickup_at: String(tokyo(12, 45)) },
      body: { pickupAt: tokyo(12, 45) },
    },
    {
      name: '支払いチェーン',
      edit: () => fireEvent.click(screen.getByRole('button', { name: 'JPYC (Kaia)' })),
      changed: { chain: 'kaia' },
    },
  ];

  it.each(edits)('待っている間の操作「$name」で、待っていた確認は無効になる: 200 で返っても移らず、押し直すと変えた後の中身で進む', async ({ edit, changed, body }) => {
    envHold.enableMenuOptions = true;
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={editConfig} handle={HANDLE} />);
    addGyudonLargeWithShrimp();
    add('水', 2);
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '7' } });
    const before = readCheckoutUrl(payHref()).query;
    expect(before).toMatchObject({
      items: [item('水', 2, '100'), item(GYUDON, 1, '850')].join(','),
      description: 'テーブル 7',
    });
    expect(before.chain).toBeUndefined();
    expect(before.pickup_at).toBeUndefined();
    fireEvent.click(payLink()!);
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();

    edit();

    // 待ちが解けて、変えた後の URL の link が出る。
    const next = payHref();
    expect(readCheckoutUrl(next).query).toEqual({ ...before, ...changed });
    await gate.admit(0);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(payHref()).toBe(next);

    fireEvent.click(payLink()!);
    await gate.admit(1);

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder' },
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', ...body },
    ]);
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  // 「前回と同じ注文」は、カートが空のときだけ出る。確認を待ったまま空になる道は、売り切れの反映だけ (お客様が数量を
  // 減らして空にしたときは、その操作で確認が無効になっている)。店のページは開いたときの売り切れしか持たないので、
  // 今の画面でこの道が起きるのは、待っている間にページが描き直されたときだけ。
  it('待っている間に売り切れでカートが空になって出た「前回と同じ注文」を押すと、待っていた確認は無効になる: 200 で返っても移らず、押し直すと戻した注文で進む', async () => {
    seedPaidLastOrder([{ id: 'c', qty: 1 }]);
    const gate = gatedFetches();
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} live={live([])} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    view.rerender(<MobileOrderView config={config} handle={HANDLE} live={live(['a'], 2)} />);
    expect(cartToggle()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '前回と同じ注文（1 品）' }));

    expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    const next = payHref();
    expect(readCheckoutUrl(next).query.items).toBe(item('水', 1, '100', ':8:taxable_8:'));
    await gate.admit(0);
    expect(assignSpy).not.toHaveBeenCalled();

    fireEvent.click(payLink()!);
    await gate.admit(1);
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it.each(['409', '例外'])('無効にした確認が %s で返っても、止まった案内も押し直しの案内も出ない。押し直した確認が 409 なら止まり、例外なら押し直しの案内が出る', async (kind) => {
    const gate = gatedFetches();
    const settle = (index: number) =>
      kind === '409' ? gate.respond(index, new Response('{}', { status: 409 })) : gate.fail(index);
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    add('水');

    await settle(0);

    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(payLink()).not.toBeNull();
    expect(screen.getByText('600 JPYC')).toBeInTheDocument();

    fireEvent.click(payLink()!);
    await settle(1);

    expect(assignSpy).not.toHaveBeenCalled();
    if (kind === '409') {
      expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
      expect(payLink()).toBeNull();
      expect(cartToggle()).toBeNull();
    } else {
      expect(screen.queryByText(TEXT.closed)).toBeNull();
      expect(notice()?.textContent).toBe(TEXT.retryNotice);
      expect(payLink()).not.toBeNull();
    }
  });

  it.each(['200', '409', '例外'])('押し直した確認を待っている間に、無効にした前の確認が %s で返っても、待ちは解けない (移らない・案内も出ない)。押し直した確認が通ると移る', async (kind) => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    add('水');
    const next = payHref();
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    if (kind === '200') await gate.admit(0);
    else if (kind === '409') await gate.respond(0, new Response('{}', { status: 409 }));
    else await gate.fail(0);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();

    await gate.admit(1);

    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  // 注文の中身を変える部品を押しても、中身が変わらないなら (上限の数量で ＋ など)、待っていた確認はそのまま使う。
  // 押す前のカート: 水 と 牛丼（大盛り・えび）がどちらも上限の数量、テーブル番号は上限の長さ (16 字)、枠は 12:45、チェーンは Polygon。
  const TABLE_16 = '1234567890123456';
  const tableInput = () => screen.getByLabelText('テーブル番号') as HTMLInputElement;
  const unchangedEdits: {
    name: string;
    edit: () => void;
    /** 押す前のテーブル番号 (既定は上限の長さ)。 */
    table?: string;
    /** 操作の後の入力欄の値 (見るときだけ)。 */
    typed?: string;
  }[] = [
    // 行き先の URL に載るテーブル番号は、前後の空白を落とした値。空白を足しただけでは注文は変わらない (入力欄には残る)。
    {
      name: 'テーブル番号の末尾に空白を足す',
      table: '7',
      edit: () => fireEvent.change(tableInput(), { target: { value: '7 ' } }),
      typed: '7 ',
    },
    {
      name: 'テーブル番号の先頭に空白を足す',
      table: '7',
      edit: () => fireEvent.change(tableInput(), { target: { value: ' 7' } }),
      typed: ' 7',
    },
    {
      name: '上限の数量で、メニューの ＋',
      edit: () =>
        fireEvent.click(
          within(
            screen.getAllByRole('listitem').filter((li) => within(li).queryByText('水') !== null)[0],
          ).getByRole('button', { name: TEXT.plus }),
        ),
    },
    {
      name: '上限の数量で、明細の行の ＋ (オプションのない品)',
      edit: () => fireEvent.click(within(cartLine('水')).getByRole('button', { name: TEXT.plus })),
    },
    {
      name: '上限の数量で、明細の行の ＋ (オプションの行)',
      edit: () => fireEvent.click(within(cartLine(GYUDON)).getByRole('button', { name: TEXT.plus })),
    },
    {
      name: '上限の数量の行と同じ選び方を、「選ぶ」から足す',
      edit: () => addGyudonLargeWithShrimp(),
    },
    {
      name: '選んであるチェーンをもう一度押す',
      edit: () => fireEvent.click(screen.getByRole('button', { name: 'JPYC (Polygon)' })),
    },
    {
      name: '選んである受け取りの枠をもう一度選ぶ',
      edit: () => {
        const select = screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
        fireEvent.change(select, { target: { value: String(tokyo(12, 45)) } });
      },
    },
    {
      name: '上限の長さのテーブル番号に 1 字足す (切り詰めて同じ値)',
      edit: () =>
        fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: `${TABLE_16}7` } }),
    },
  ];

  it.each(unchangedEdits)('待っている間の操作「$name」は注文の中身を変えないので、待っていた確認は無効にならない: 200 で返ると、押したときの URL へそのまま移る', async ({ edit, table = TABLE_16, typed }) => {
    envHold.enableMenuOptions = true;
    const gate = gatedFetches();
    renderWithIntl(
      <MobileOrderView
        config={editConfig}
        handle={HANDLE}
        // 上限の数量から始める (事前に入れたカートなので、明細は開いている)。
        initialCart={[
          { id: 'water', qty: CHECKOUT_QTY_MAX },
          { id: 'gyudon', qty: CHECKOUT_QTY_MAX, options: { g1: 'l', g2: ['ebi'] } },
        ]}
      />,
    );
    fireEvent.change(tableInput(), { target: { value: table } });
    fireEvent.change(screen.getByLabelText(TEXT.pickup), { target: { value: String(tokyo(12, 45)) } });
    const href = payHref();
    expect(readCheckoutUrl(href).query).toMatchObject({
      items: [item('水', CHECKOUT_QTY_MAX, '100'), item(GYUDON, CHECKOUT_QTY_MAX, '850')].join(','),
      description: `テーブル ${table}`,
      pickup_at: String(tokyo(12, 45)),
    });
    expect(readCheckoutUrl(href).query.chain).toBeUndefined();
    fireEvent.click(payLink()!);
    expect(payButton()).toBeDisabled();

    edit();

    if (typed !== undefined) expect(tableInput()).toHaveValue(typed);
    // 待ちは解けていない。
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();
    await gate.admit(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    // 応答の後の画面の link も、押したときと同じ URL (中身は変わっていない)。
    expect(payHref()).toBe(href);
  });

  // 売り切れの品の行は注文の明細に入らない。選ぶ画面を開いた後で売り切れが反映された品を足しても、注文は変わらない。
  it('待っている間に「選ぶ」を開き、その品が売り切れになってから足しても、注文の中身は変わらないので、待っていた確認は無効にならない', async () => {
    envHold.enableMenuOptions = true;
    const gate = gatedFetches();
    const view = renderWithIntl(
      <MobileOrderView config={optionConfig} handle={HANDLE} live={live([])} />,
    );
    add('水');
    const href = payHref();
    fireEvent.click(payLink()!);

    fireEvent.click(within(menuCard('牛丼')).getByRole('button', { name: /選ぶ/ }));
    view.rerender(<MobileOrderView config={optionConfig} handle={HANDLE} live={live(['gyudon'], 2)} />);
    // 選ぶ画面は開いたまま。
    fireEvent.click(screen.getByRole('radio', { name: /大盛り/ }));
    fireEvent.click(screen.getByRole('button', { name: 'カートに追加' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // 合計も待ちもそのまま。
    expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();
    await gate.admit(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(payHref()).toBe(href);
  });

  it('注文の中身を変えない操作 (明細を開く・「選ぶ」を開いてキャンセルする) では、待っていた確認は無効にならない', async () => {
    envHold.enableMenuOptions = true;
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={optionConfig} handle={HANDLE} />);
    add('水');
    const href = payHref();
    fireEvent.click(payLink()!);

    fireEvent.click(cartToggle()!);
    expect(cartToggle()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(menuCard('牛丼')).getByRole('button', { name: /選ぶ/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();
    await gate.admit(0);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // 自動の更新 (時刻の取り直し・売り切れの反映) では無効にしない: 押した時点の注文で進む。
  it('待っている間に時刻の取り直しで選んだ枠が外れても、待っていた確認は有効のまま: 進む先と確認の本文は押したときの枠 (今の動き)', async () => {
    const gate = gatedFetches();
    renderWithIntl(
      <MobileOrderView
        config={{ ...config, mode: 'preorder', minLeadMinutes: 30 }}
        handle={HANDLE}
      />,
    );
    add('ブレンド');
    const select = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
    fireEvent.change(select(), {
      target: { value: (within(select()).getByRole('option', { name: '12:30' }) as HTMLOptionElement).value },
    });
    const href = payHref();
    expect(readCheckoutUrl(href).query.pickup_at).toBe(String(tokyo(12, 30)));

    fireEvent.click(payLink()!);
    // 30 秒たつと、最短の受け取り (今 + 準備 30 分) は 12:45 の枠になる。12:30 の枠は (まだ先の時刻だが) 候補から外れる。
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(within(select()).queryByRole('option', { name: '12:30' })).toBeNull();
    expect(select().value).toBe('');
    // 待ちは解けていない。
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();

    await gate.admit(0);

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) },
    ]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    // 応答の後の画面の link は、枠の無い URL。
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBeUndefined();
  });

  it('待っている間に売り切れが反映されても、待っていた確認は有効のまま: 画面の合計は減るが、進む先は押したときの URL (今の動き)', async () => {
    const gate = gatedFetches();
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} live={live([])} />);
    add('ブレンド');
    add('水');
    const href = payHref();
    fireEvent.click(payLink()!);

    view.rerender(<MobileOrderView config={config} handle={HANDLE} live={live(['a'], 2)} />);

    expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();

    await gate.admit(0);

    // 受け付けられたのは押した時点の注文。売り切れになった品が入ったままの URL へ進む。
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(readCheckoutUrl(href).payable()).toBe('600');
  });

  // 押せないボタンに替わるのは再描画の後。handler の中の二度押しの印も state なので、再描画の前に届いた
  // 2 回目の click は止まらない。人の 2 度押しは click ごとに再描画が挟まる見込みだが、実機では確かめていない。
  it('再描画が挟まらずに click が 2 回届くと、POST も移動も 2 回になる (今の動き・/checkout の側は ref で 1 回に止める)', async () => {
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    const link = payLink()!;

    await act(async () => {
      fireEvent.click(link);
      fireEvent.click(link);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(assignSpy.mock.calls).toEqual([[href], [href]]);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 受付の確認が通らなかったとき。進むのは「その押した確認が 200」のときだけ (ここは変わらない)。
  //   - 確かめられなかっただけ (通信の例外・429・500 以上): 止まった表示にせず、支払い欄に案内を出して、押し直せるままにする。
  //   - 選んだ受け取りの枠だけが過ぎていた (409 pickup_slot_unavailable で、端末の時計でもその枠が候補に無い):
  //     枠を「最短（指定なし）」に戻して、案内を出す。
  //   - それ以外 (お店の側の拒否・知らない応答): 今までどおり止まった表示 (開き直すまで戻らない)。
  // -------------------------------------------------------------------------------------------------------------------
  it('fetch が例外で落ちたら移らない。止まった表示にはせず、支払い欄を残して「支払いへ進む」のすぐ上に案内を出す。自動では送り直さない。もう一度押すと新しい確認を送り、200 なら移る', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    fireEvent.click(payLink()!);

    await gate.fail(0);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(notice()?.nextElementSibling).toBe(payLink());
    expect(cartToggle()).not.toBeNull();
    expect(payHref()).toBe(href);
    // 自動の送り直しは無い: 時間が進んでも、確認は 1 回のまま・案内も出たまま・移らない。
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(assignSpy).not.toHaveBeenCalled();

    // 押し直す: 新しい確認を送る。押した時に案内は消え、応答を待つ間は押せないボタン。
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
    expect(payButton()).toBeDisabled();
    expect(assignSpy).not.toHaveBeenCalled();

    await gate.admit(1);

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'storefront' },
      { handle: HANDLE, merchant: RECEIVER, mode: 'storefront' },
    ]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(notice()).toBeNull();
  });

  it.each([429, 500, 502, 503, 504])('応答が %i なら移らない。止まった表示にはせず、支払い欄を残して案内を出す。押し直した確認をお店の停止 (409) で断られたら、そこで止まる', async (status) => {
    fetchSpy.mockImplementation(async () => refused(status, 'x'));
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();

    await pressPay();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(payHref()).toBe(href);
    expect(cartToggle()).not.toBeNull();

    // やり直しでも、進むには新しい確認の 200 が要る。お店が止めていれば進まない。
    fetchSpy.mockImplementation(async () => refused(409, 'store_not_accepting'));
    await pressPay();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it('429 が 2 回続いても、押し直すたびに新しい確認を送る (案内は押した時に消え、断られるとまた出る)。3 回目が 200 なら移る', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();

    fireEvent.click(payLink()!);
    await gate.respond(0, refused(429, 'rate_limited'));
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    fireEvent.click(payLink()!);
    expect(notice()).toBeNull();
    await gate.respond(1, refused(429, 'rate_limited'));
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(assignSpy).not.toHaveBeenCalled();

    fireEvent.click(payLink()!);
    await gate.admit(2);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // お店の側の拒否と、知らない応答。やり直せると決めない。
  const stopResponses: { name: string; response: () => Response }[] = [
    { name: '400', response: () => refused(400, 'invalid_request') },
    { name: '404', response: () => refused(404, 'storefront_not_found') },
    { name: '413', response: () => refused(413, 'payload_too_large') },
    { name: '409 store_not_accepting', response: () => refused(409, 'store_not_accepting') },
    { name: '409 storefront_changed', response: () => refused(409, 'storefront_changed') },
    { name: '409 pickup_slots_unavailable', response: () => refused(409, 'pickup_slots_unavailable') },
    { name: '409 知らない理由', response: () => refused(409, 'something_new') },
    { name: '409 理由なし', response: () => new Response('{}', { status: 409 }) },
    { name: '409 本文が JSON でない', response: () => new Response('<html>', { status: 409 }) },
    { name: '409 本文が空', response: () => new Response(null, { status: 409 }) },
    { name: '409 本文が JSON の null', response: () => new Response('null', { status: 409 }) },
  ];

  it.each(stopResponses)('応答が $name なら、今までどおり止まった表示: 移らず、支払い欄が消え、押し直しの案内は出ない。品を足しても・時間が進んでも戻らない。開き直すと戻る', async ({ response }) => {
    fetchSpy.mockImplementation(async () => response());
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');

    await pressPay();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    expect(cartToggle()).toBeNull();
    add('水');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 開き直す (mount し直す) と受付に戻る。
    view.unmount();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(payLink()).not.toBeNull();
  });

  // 受け取りの枠 (事前注文・準備 30 分)。12:00:00 に開くと、候補は 12:30 から。
  const slotConfig: MobileOrderConfig = { ...config, mode: 'preorder', minLeadMinutes: 30 };
  const pickupSelect = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
  const pickupOption = (name: string) =>
    within(pickupSelect()).queryByRole<HTMLOptionElement>('option', { name });
  const choosePickup = (name: string) =>
    fireEvent.change(pickupSelect(), { target: { value: pickupOption(name)!.value } });
  /**
   * 12:30 の枠を選んでから、時計だけ 1 ms 進める (30 秒の取り直しは回さない)。今 + 準備 30 分の最短の枠は 12:45 に
   * なるので、12:30 は端末の時計でも過ぎた枠。画面の候補にはまだ残っている。
   */
  function choose1230ThenLetItPass() {
    choosePickup('12:30');
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBe(String(tokyo(12, 30)));
    vi.setSystemTime(TOKYO_NOON + 1);
    expect(pickupOption('12:30')).not.toBeNull();
  }

  it('選んだ枠が端末の時計でも過ぎている 409 pickup_slot_unavailable: 止まった表示にせず、候補を作り直して「最短（指定なし）」に戻し、案内を出す。選び直さずに押すと、枠なしの確認を送り、200 なら枠の無い URL へ移る', async () => {
    fetchSpy.mockImplementation(async () => refused(409, 'pickup_slot_unavailable'));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();

    await pressPay();
    await flush();

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()?.textContent).toBe(TEXT.slotNotice);
    expect(notice()?.nextElementSibling).toBe(payLink());
    // 候補は今の時刻で作り直してある (30 秒の区切りを待たない): 12:30 は消え、12:45 からになる。
    expect(pickupOption('12:30')).toBeNull();
    expect(pickupOption('12:45')).not.toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupOption(TEXT.pickupAsap)?.selected).toBe(true);
    expect(cartToggle()).not.toBeNull();
    const next = payHref();
    expect(readCheckoutUrl(next).query.pickup_at).toBeUndefined();

    fetchSpy.mockImplementation(async () => admitted());
    await pressPay();

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) },
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder' },
    ]);
    expect(assignSpy.mock.calls).toEqual([[next]]);
    expect(notice()).toBeNull();
  });

  it('枠を「最短」に戻すときは、案内を出すのと同じ描画で、link の URL からも枠を外す (案内と、過ぎた枠の URL が並ぶ描画は 1 回も無い)', async () => {
    fetchSpy.mockImplementation(async () => refused(409, 'pickup_slot_unavailable'));
    const commits: { notice: boolean; href: string | null }[] = [];
    renderWithIntl(
      <Profiler
        id="view"
        onRender={() => {
          commits.push({
            notice: document.querySelector('[role="alert"]') !== null,
            href: document.querySelector('a[href*="/checkout"]')?.getAttribute('href') ?? null,
          });
        }}
      >
        <MobileOrderView config={slotConfig} handle={HANDLE} />
      </Profiler>,
    );
    add('ブレンド');
    choose1230ThenLetItPass();

    await pressPay();
    await flush();

    expect(notice()?.textContent).toBe(TEXT.slotNotice);
    const withNotice = commits.filter((c) => c.notice);
    expect(withNotice.length).toBeGreaterThan(0);
    expect(withNotice.filter((c) => c.href === null || c.href.includes('pickup_at'))).toEqual([]);
  });

  // 端末の候補に残っている枠を断られるのは、お店が準備時間やラストオーダーを変えたか、端末の時計が遅いとき。
  // 候補を作り直しても同じ枠がまた出るので、やり直せると決めない (今までどおり止まった表示)。
  it.each([
    { slot: '12:30', clockAhead: 0 },
    { slot: '12:45', clockAhead: 1 },
  ])('端末の時計ではまだ候補に残っている枠 ($slot・時計 +$clockAhead ms) への 409 pickup_slot_unavailable は、止まった表示', async ({ slot, clockAhead }) => {
    fetchSpy.mockImplementation(async () => refused(409, 'pickup_slot_unavailable'));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup(slot);
    vi.setSystemTime(TOKYO_NOON + clockAhead);

    await pressPay();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it('枠を選んでいない (最短) 確認への 409 pickup_slot_unavailable は、止まった表示 (戻す枠が無い)', async () => {
    fetchSpy.mockImplementation(async () => refused(409, 'pickup_slot_unavailable'));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    vi.setSystemTime(TOKYO_NOON + 1);

    await pressPay();
    await flush();

    expect(postedBodies()).toEqual([{ handle: HANDLE, merchant: RECEIVER, mode: 'preorder' }]);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
  });

  it.each(stopResponses)('選んだ枠が端末の時計でも過ぎていても、応答が $name なら止まった表示 (枠の失効の扱いにするのは、理由が pickup_slot_unavailable のときだけ)', async ({ response }) => {
    fetchSpy.mockImplementation(async () => response());
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();

    await pressPay();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it('枠を戻して作り直した候補が 0 件なら、今ある「本日の枠が無い」の止まった表示になる', async () => {
    fetchSpy.mockImplementation(async () => refused(409, 'pickup_slot_unavailable'));
    // ラストオーダー 12:30: 12:00:00 の候補は 12:30 の 1 つだけ。1 ms 後は 0 件。
    renderWithIntl(<MobileOrderView config={{ ...slotConfig, lastOrder: '12:30' }} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();

    await pressPay();
    await flush();

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it('案内「最短に戻しました」は、受け取り時間を選び直すと消える (確認は送らない)。選んだ枠で押すと、その枠の確認を送り、200 なら移る', async () => {
    fetchSpy.mockImplementation(async () => refused(409, 'pickup_slot_unavailable'));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();
    await pressPay();
    await flush();
    expect(notice()?.textContent).toBe(TEXT.slotNotice);

    choosePickup('12:45');

    expect(notice()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const next = payHref();
    expect(readCheckoutUrl(next).query.pickup_at).toBe(String(tokyo(12, 45)));

    fetchSpy.mockImplementation(async () => admitted());
    await pressPay();

    expect(postedBodies()[1]).toEqual({
      handle: HANDLE,
      merchant: RECEIVER,
      mode: 'preorder',
      pickupAt: tokyo(12, 45),
    });
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it('案内「最短に戻しました」は、品を足しても残り、次に「支払いへ進む」を押した時に消える (応答を待つ間は出ない)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();
    fireEvent.click(payLink()!);
    await gate.respond(0, refused(409, 'pickup_slot_unavailable'));
    await flush();
    expect(notice()?.textContent).toBe(TEXT.slotNotice);

    add('水');
    expect(notice()?.textContent).toBe(TEXT.slotNotice);

    fireEvent.click(payLink()!);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
    expect(payButton()).toBeDisabled();
  });

  it('案内「お支払いへ進めませんでした」は、品を足しても・受け取り時間を選んでも、次に押すまで残る。押した時に消える', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    add('水');
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    choosePickup('12:45');
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const next = payHref();
    fireEvent.click(payLink()!);

    expect(notice()).toBeNull();
    expect(payButton()).toBeDisabled();
    await gate.admit(1);
    expect(postedBodies()[1]).toEqual({
      handle: HANDLE,
      merchant: RECEIVER,
      mode: 'preorder',
      pickupAt: tokyo(12, 45),
    });
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  /** 本文を読み終えるのを外から決める 409 の応答 (本文を読んでいる間の画面を見る)。 */
  function slowBody409() {
    let resolve!: (body: unknown) => void;
    const body = new Promise<unknown>((res) => {
      resolve = res;
    });
    return {
      response: { ok: false, status: 409, json: () => body } as unknown as Response,
      deliver: async (value: unknown) => {
        await act(async () => {
          resolve(value);
          for (let i = 0; i < 5; i++) await Promise.resolve();
        });
      },
    };
  }

  it('409 の本文を読んでいる間に注文を変えたら、その応答は使わない: 枠は戻さず、案内も止まった表示も出ない。押し直すと、変えた後の中身で進む', async () => {
    const slow = slowBody409();
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();
    fireEvent.click(payLink()!);
    await gate.respond(0, slow.response);
    // 本文を読んでいる間は、待ちのまま。
    expect(payButton()).toBeDisabled();
    expect(notice()).toBeNull();

    add('水');
    const next = payHref();

    await slow.deliver({ ok: false, error: 'pickup_slot_unavailable' });

    expect(notice()).toBeNull();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
    // 枠も候補も、そのまま (戻していない・作り直していない)。
    expect(pickupSelect().value).toBe(String(tokyo(12, 30)));
    expect(pickupOption('12:30')).not.toBeNull();
    expect(payHref()).toBe(next);

    fireEvent.click(payLink()!);
    await gate.admit(1);

    expect(postedBodies()[1]).toEqual({
      handle: HANDLE,
      merchant: RECEIVER,
      mode: 'preorder',
      pickupAt: tokyo(12, 30),
    });
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it('409 の本文を読んでいる間に注文を変えて押し直したら、前の応答の本文が届いても、押し直した確認の待ちは解けない (案内も出ない)。押し直した確認が通ると移る', async () => {
    const slow = slowBody409();
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choose1230ThenLetItPass();
    fireEvent.click(payLink()!);
    await gate.respond(0, slow.response);
    add('水');
    const next = payHref();
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await slow.deliver({ ok: false, error: 'pickup_slot_unavailable' });

    expect(notice()).toBeNull();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();
    expect(assignSpy).not.toHaveBeenCalled();

    await gate.admit(1);

    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  // 時間切れは足していない。本文が届かない 409 は、status だけで止まる前の動きより待ちが延びる (枠を選んでいるときだけ)。
  it('枠を選んだ確認への 409 の本文が届かない間は、待ちのまま (時間切れは無い)。注文を変えれば押し直せる', async () => {
    const slow = slowBody409();
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:45');
    fireEvent.click(payLink()!);
    await gate.respond(0, slow.response);

    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(payLink()).toBeNull();
    expect(payButton()).toBeDisabled();
    expect(notice()).toBeNull();
    expect(screen.queryByText(TEXT.closed)).toBeNull();

    add('水');

    expect(payLink()).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('枠を選んでいない確認への 409 は、本文を読まずに止まる (本文が届かなくても待たない)', async () => {
    const slow = slowBody409();
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);

    await gate.respond(0, slow.response);

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payButton()).toBeNull();
  });

  // 押せないボタンに替わる前に届いた 2 回目の click は止めていない (上の「POST も移動も 2 回」)。1 本目の例外で押し直せる
  // 状態に戻った後、まだ返っていない 2 本目の 200 で古い URL へ移らないのは、「注文を変えたら待っている確認は無効」が効くから。
  it('再描画の前に click が 2 回届き、1 本目が例外で案内が出た後に受け取り時間を変えると、2 本目が 200 で返っても、変える前の URL へ移らない。押し直すと変えた後の URL へ移る', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    const before = payHref();
    const link = payLink()!;
    await act(async () => {
      fireEvent.click(link);
      fireEvent.click(link);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await gate.fail(0);

    // 1 本目の例外で待ちが解け、案内が出ている (2 本目はまだ返っていない)。
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(payHref()).toBe(before);

    choosePickup('12:45');
    const next = payHref();
    expect(readCheckoutUrl(next).query).toEqual({
      ...readCheckoutUrl(before).query,
      pickup_at: String(tokyo(12, 45)),
    });

    await gate.admit(1);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(payHref()).toBe(next);

    fireEvent.click(payLink()!);
    await gate.admit(2);

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder' },
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder' },
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 45) },
    ]);
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it('再描画の前に click が 2 回届き、1 本目が例外・2 本目が 200 で、その間に注文を変えていなければ、押したときの URL へ移る (2 本とも同じ中身の確認・今の動き)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    const link = payLink()!;
    await act(async () => {
      fireEvent.click(link);
      fireEvent.click(link);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(assignSpy).not.toHaveBeenCalled();

    await gate.admit(1);

    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // 案内の文は、ボタンの名前と選択肢の名前を引いている。どちらかの字を変えたら、案内の文も一緒に直す。
  it.each([
    ['ja', jaMessages.MobileOrder],
    ['en', enMessages.MobileOrder],
  ] as const)('案内の文 (%s) は、「支払いへ進む」のボタンと「最短（指定なし）」の選択肢を、画面と同じ字で引いている', (_locale, m) => {
    expect(m.admissionRetryNotice).toContain(m.payButton);
    expect(m.admissionSlotNotice).toContain(m.pickupAsap);
  });

  it('案内の文は承認された字のまま (ja / en)', () => {
    expect(jaMessages.MobileOrder.admissionRetryNotice).toBe(TEXT.retryNotice);
    expect(jaMessages.MobileOrder.admissionSlotNotice).toBe(TEXT.slotNotice);
    expect(enMessages.MobileOrder.admissionRetryNotice).toBe(
      "Couldn't continue to payment. Please wait a moment, then tap “Proceed to pay” again.",
    );
    expect(enMessages.MobileOrder.admissionSlotNotice).toBe(
      "The pickup time you chose has passed, so it's been reset to “Soonest (unspecified)”. Choose another time if you prefer.",
    );
  });

  it('応答の本文は読まない: status が 200 なら、本文が ok: false でも移る (今の動き・/checkout の側は本文も見る)', async () => {
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    );
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();

    await pressPay();

    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(screen.queryByText(TEXT.closed)).toBeNull();
  });

  it('「支払いへ進む」を押した時点で、受付の確認の結果を待たずに「前回の注文」を保存する (拒否されても残る)', async () => {
    const gate = gatedFetch();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド', 2);
    add('水');
    const saved = () =>
      JSON.parse(
        window.localStorage.getItem(`openpay:last-order:v1:h:${HANDLE}`) ?? 'null',
      ) as unknown;
    const record = {
      receiver: RECEIVER,
      cart: [
        { id: 'a', qty: 2 },
        { id: 'c', qty: 1 },
      ],
      ts: TOKYO_NOON,
    };
    expect(saved()).toBeNull();

    fireEvent.click(payLink()!);

    // 応答はまだ返っていない (POST は出た・移っていない・拒否の案内も無い)。この時点でもう保存してある。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(saved()).toEqual(record);

    await gate.respond(new Response('{}', { status: 409 }));

    // 拒否されても、保存はそのまま残る。
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(saved()).toEqual(record);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. 注文を送る流れ: 受付の確認を通らない経路 (link のまま /checkout へ)
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 「支払いへ進む」: 受付の確認を通らない経路 (link のまま移る)', () => {
  it('時間の flag OFF の @handle の店: POST も assign もせず、link の移動を止めない', async () => {
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');

    const pressed = await pressPay();

    expect(pressed.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(payLink()).not.toBeNull();
  });

  it('時間の flag ON でも @handle の無いページ (?s=): POST も assign もせず、link の移動を止めない。URL に store_handle は無い', async () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(<MobileOrderView config={config} />);
    add('ブレンド', 2);
    add('水');

    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: [
        item('ブレンド', 2, '500', ':10:taxable_10:'),
        item('水', 1, '100', ':8:taxable_8:'),
      ].join(','),
      fee_kind: 'storefront',
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('1100');

    const pressed = await pressPay();

    expect(pressed.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. 額の種類ごとに、URL の全部と「URL の額 = 画面の合計」
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 額の種類ごとの URL (全部の query) と画面の合計', () => {
  it('1 注文 100 円引きの店 (@handle): 小計 750 − 100 = 650。URL の disc は 100', () => {
    renderWithIntl(
      <MobileOrderView
        config={{ ...config, discount: { kind: 'amount', value: '100' } }}
        handle={HANDLE}
      />,
    );
    add('チーズケーキ');
    add('水');
    expect(screen.getByText('650 JPYC')).toBeInTheDocument();
    expect(screen.getByText('小計 750 JPYC から 100 JPYC 値引き')).toBeInTheDocument();

    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: [item('チーズケーキ', 1, '650'), item('水', 1, '100', ':8:taxable_8:')].join(','),
      disc: '100',
      fee_kind: 'storefront',
      store_handle: HANDLE,
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('650');
  });

  it('事前注文・お店負担の利用料 (flag ON): 画面の合計に上乗せしない。URL は fee_kind と fee_payer を運ぶ', () => {
    envHold.enableMobileOrderFee = true;
    renderWithIntl(
      <MobileOrderView config={{ ...config, mode: 'preorder', feePayer: 'merchant' }} handle={HANDLE} />,
    );
    add('ブレンド', 3);
    expect(screen.getByText('1500 JPYC')).toBeInTheDocument();
    expect(screen.queryByText(/システム利用料/)).toBeNull();

    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: item('ブレンド', 3, '500', ':10:taxable_10:'),
      fee_kind: 'preorder',
      fee_payer: 'merchant',
      store_handle: HANDLE,
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('1500');
  });

  it('オプションの選び方が違う同じ品は別の行になり、それぞれの単価で URL に載る (flag ON)', () => {
    envHold.enableMenuOptions = true;
    renderWithIntl(<MobileOrderView config={optionConfig} />);
    addGyudonLargeWithShrimp(); // 850
    // 既定の選び方 (小盛り・トッピングなし) = 500。
    fireEvent.click(within(menuCard('牛丼')).getByRole('button', { name: /選ぶ/ }));
    fireEvent.click(screen.getByRole('button', { name: 'カートに追加' }));
    expect(screen.getByText('1350 JPYC')).toBeInTheDocument();

    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: [item('牛丼（大盛り・えび）', 1, '850'), item('牛丼（小盛り）', 1, '500')].join(','),
      fee_kind: 'storefront',
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('1350');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. 時間の経過
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 時間の経過 (時間の flag ON)', () => {
  beforeEach(() => {
    envHold.enablePreorderTime = true;
  });

  it('今の時刻は 30 秒ごとに取り直す: ラストオーダーを過ぎても、次の 30 秒の区切りまでは受付のまま', () => {
    // 12:09:50 に開く。ラストオーダーは 12:10。
    vi.setSystemTime(tokyo(12, 9, 50));
    renderWithIntl(<MobileOrderView config={{ ...config, lastOrder: '12:10' }} />);
    add('ブレンド');
    expect(payLink()).not.toBeNull();
    expect(screen.getByText('ラストオーダー 12:10')).toBeInTheDocument();

    // 時計は 12:10:19.999 (ラストオーダーの後) だが、画面の時刻はまだ開いたときのまま。
    act(() => {
      vi.advanceTimersByTime(29_999);
    });
    expect(payLink()).not.toBeNull();
    expect(screen.queryByText(TEXT.pastLastOrder)).toBeNull();

    // 30 秒の区切りで取り直して、受付が止まる。
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(TEXT.pastLastOrder)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it('受付開始の時刻を過ぎると、次の 30 秒の区切りで受付が始まる', () => {
    vi.setSystemTime(tokyo(12, 59, 45));
    renderWithIntl(<MobileOrderView config={{ ...config, openFrom: '13:00' }} />);
    add('ブレンド');
    expect(screen.getByText('本日の受付は 13:00 に開始します。')).toBeInTheDocument();
    expect(payLink()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.queryByText('本日の受付は 13:00 に開始します。')).toBeNull();
    expect(payLink()).not.toBeNull();
  });

  it('時刻を取り直す timer は flag ON の間だけ 1 つ増え、画面を閉じると残らない', () => {
    // ほかの hook も timer を持つので、flag OFF の数との差で見る。
    envHold.enablePreorderTime = false;
    const off = renderWithIntl(<MobileOrderView config={config} />);
    const withoutClock = vi.getTimerCount();
    off.unmount();
    expect(vi.getTimerCount()).toBe(0);

    envHold.enablePreorderTime = true;
    const on = renderWithIntl(<MobileOrderView config={config} />);
    expect(vi.getTimerCount()).toBe(withoutClock + 1);
    on.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('選んだ受け取りの枠が候補から外れたら選択を外す: URL から pickup_at が消え、POST の本文にも載らない', async () => {
    renderWithIntl(
      <MobileOrderView
        config={{ ...config, mode: 'preorder', minLeadMinutes: 30 }}
        handle={HANDLE}
      />,
    );
    add('ブレンド');
    // 12:00 + 30 分 → 最初の枠は 12:30。
    const select = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
    const optionValue = (name: string) =>
      (within(select()).getByRole('option', { name }) as HTMLOptionElement).value;
    fireEvent.change(select(), { target: { value: optionValue('12:30') } });
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBe(String(tokyo(12, 30)));

    // 30 秒たつと 12:00:30 + 30 分 → 最初の枠は 12:45。12:30 は候補から外れる。
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(within(select()).queryByRole('option', { name: '12:30' })).toBeNull();
    expect(select().value).toBe('');
    expect(within(select()).getByRole<HTMLOptionElement>('option', { name: TEXT.pickupAsap }).selected).toBe(true);
    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: item('ブレンド', 1, '500', ':10:taxable_10:'),
      fee_kind: 'preorder',
      fee_payer: 'merchant',
      store_handle: HANDLE,
      store: 'テスト珈琲店',
    });

    await pressPay();

    expect(postedBodies()).toEqual([{ handle: HANDLE, merchant: RECEIVER, mode: 'preorder' }]);
    expect(assignSpy.mock.calls).toEqual([[payHref()]]);
  });

  it('まだ候補に残っている枠は、時間が進んでも選んだまま', () => {
    renderWithIntl(
      <MobileOrderView config={{ ...config, mode: 'preorder', minLeadMinutes: 30 }} />,
    );
    add('ブレンド');
    const select = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
    const value = (within(select()).getByRole('option', { name: '12:45' }) as HTMLOptionElement).value;
    fireEvent.change(select(), { target: { value } });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(select().value).toBe(String(tokyo(12, 45)));
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBe(String(tokyo(12, 45)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. 10 品を超えたとき
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 一度に注文できるのは 10 品まで (行の数で数える)', () => {
  const names = Array.from({ length: 11 }, (_, i) => `品${String(i + 1).padStart(2, '0')}`);
  const elevenItems: MobileOrderConfig = {
    ...config,
    menu: names.map((name, i) => ({ id: `m${i + 1}`, name, price: '100' })),
  };

  it('10 品ちょうどは支払える (数量は数えない)。11 品目で案内に替わって支払えなくなり、1 品減らすと戻る', () => {
    renderWithIntl(<MobileOrderView config={elevenItems} />);
    for (const name of names.slice(0, 10)) add(name);
    add(names[0], 2); // 1 品目だけ数量 3 (行の数は 10 のまま)

    expect(screen.getByText('1200 JPYC')).toBeInTheDocument();
    expect(screen.queryByText(TEXT.tooMany)).toBeNull();
    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: [item(names[0], 3, '100'), ...names.slice(1, 10).map((n) => item(n, 1, '100'))].join(','),
      fee_kind: 'storefront',
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('1200');

    add(names[10]); // 11 品目

    expect(screen.getByText(TEXT.tooMany)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    // 合計も明細を開くボタンも出さない (案内だけ)。
    expect(cartToggle()).toBeNull();
    expect(screen.queryByText(/\d JPYC$/)).toBeNull();

    removeOne(names[10]);

    expect(screen.queryByText(TEXT.tooMany)).toBeNull();
    expect(screen.getByText('1200 JPYC')).toBeInTheDocument();
    expect(readCheckoutUrl(payHref()).query).toEqual(url.query);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. カートに入れた後で売り切れになった品
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — カートに入れた後で売り切れになった品', () => {
  it('売り切れになった品は、合計・点数・URL から落ちる。売り切れが解けると、入れた数量のまま戻る', () => {
    const view = renderWithIntl(<MobileOrderView config={config} live={live([])} />);
    add('ブレンド', 2);
    add('水');
    expect(screen.getByText('1100 JPYC')).toBeInTheDocument();
    const before = readCheckoutUrl(payHref()).query;

    view.rerender(<MobileOrderView config={config} live={live(['a'], 2)} />);

    expect(within(menuCard('ブレンド')).getByText(TEXT.soldOut)).toBeInTheDocument();
    expect(within(menuCard('ブレンド')).queryByRole('button', { name: TEXT.plus })).toBeNull();
    expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    expect(within(cartToggle()!).getByText('1')).toBeInTheDocument(); // 点数
    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: item('水', 1, '100', ':8:taxable_8:'),
      fee_kind: 'storefront',
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('100');

    view.rerender(<MobileOrderView config={config} live={live([], 3)} />);

    expect(screen.getByText('1100 JPYC')).toBeInTheDocument();
    expect(readCheckoutUrl(payHref()).query).toEqual(before);
  });

  it('オプションで入れた行も、その品が売り切れになると落ちる (flag ON)', () => {
    envHold.enableMenuOptions = true;
    const view = renderWithIntl(<MobileOrderView config={optionConfig} live={live([])} />);
    addGyudonLargeWithShrimp();
    add('水');
    expect(screen.getByText('950 JPYC')).toBeInTheDocument();

    view.rerender(<MobileOrderView config={optionConfig} live={live(['gyudon'], 2)} />);

    expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    const url = readCheckoutUrl(payHref());
    expect(url.query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: item('水', 1, '100'),
      fee_kind: 'storefront',
      store: 'テスト珈琲店',
    });
    expect(url.payable()).toBe('100');
  });

  it('カートの品が全部売り切れになると、支払い欄が消える', () => {
    const view = renderWithIntl(<MobileOrderView config={config} live={live([])} />);
    add('ブレンド');
    expect(payLink()).not.toBeNull();

    view.rerender(<MobileOrderView config={config} live={live(['a'], 2)} />);

    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  // 保存する中身は /checkout へ渡す明細と同じ (売り切れを除く)。数量の state から保存すると、注文していない品が、
  // 支払い済みと判定された後・売り切れが解除された次回の「前回と同じ注文」に入る。
  it('売り切れで URL から落ちた品は、「前回の注文」の保存にも残らない。売り切れが解けてから押すと、戻った品も保存に入る', async () => {
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} live={live([])} />);
    add('ブレンド', 2);
    add('水');
    view.rerender(<MobileOrderView config={config} handle={HANDLE} live={live(['a'], 2)} />);
    expect(readCheckoutUrl(payHref()).query.items).toBe(item('水', 1, '100', ':8:taxable_8:'));

    await pressPay();

    expect(savedCart()).toEqual([{ id: 'c', qty: 1 }]);

    view.rerender(<MobileOrderView config={config} handle={HANDLE} live={live([], 3)} />);
    await pressPay();

    expect(savedCart()).toEqual([
      { id: 'a', qty: 2 },
      { id: 'c', qty: 1 },
    ]);
  });

  it('オプションで入れた行も同じ: 売り切れの品の行は保存に残らず、売り切れでない品は選んだオプションごと保存される (flag ON)', async () => {
    envHold.enableMenuOptions = true;
    const gyudon = { id: 'gyudon', qty: 2, options: { g1: 'l', g2: 'ebi' } };
    const view = renderWithIntl(
      <MobileOrderView config={optionConfig} handle={HANDLE} live={live([])} />,
    );
    addGyudonLargeWithShrimp();
    addGyudonLargeWithShrimp();
    add('水', 3);

    // 売り切れなし: オプションのない品が先、オプションの行が後 (今までどおり)。
    await pressPay();
    expect(savedCart()).toEqual([{ id: 'water', qty: 3 }, gyudon]);

    view.rerender(<MobileOrderView config={optionConfig} handle={HANDLE} live={live(['gyudon'], 2)} />);
    expect(readCheckoutUrl(payHref()).query.items).toBe(item('水', 3, '100'));
    await pressPay();
    expect(savedCart()).toEqual([{ id: 'water', qty: 3 }]);

    view.rerender(<MobileOrderView config={optionConfig} handle={HANDLE} live={live(['water'], 3)} />);
    expect(readCheckoutUrl(payHref()).query.items).toBe(item('牛丼（大盛り・えび）', 2, '850'));
    await pressPay();
    expect(savedCart()).toEqual([gyudon]);
  });

  // 保存するのは「支払いへ進む」を押したときだけ。全部が売り切れだと押す場所が無いので、保存は書き換わらない
  // (空の cart で、前の保存を上書きしない)。
  it('カートの品が全部売り切れになると押す場所が無く、前に保存した「前回の注文」はそのまま残る', async () => {
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} live={live([])} />);
    add('ブレンド', 2);
    add('水');
    await pressPay();
    const record = window.localStorage.getItem(LAST_ORDER_KEY);
    expect(savedCart()).toEqual([
      { id: 'a', qty: 2 },
      { id: 'c', qty: 1 },
    ]);

    view.rerender(<MobileOrderView config={config} handle={HANDLE} live={live(['a', 'c'], 2)} />);

    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    expect(window.localStorage.getItem(LAST_ORDER_KEY)).toBe(record);
  });
});
