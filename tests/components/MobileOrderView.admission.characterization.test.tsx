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
import { act, useEffect } from 'react';
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

import { MobileOrderView, pickupSelectSlots } from '@/components/MobileOrderView';
import { MobileOrderCartBar } from '@/components/MobileOrderCartBar';
import { buildPayerReceipt } from '@/lib/payerReceipt';
import { pickupSlots } from '@/lib/shopTime';
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
// 準備 30 分の店では、12:30 の枠の受付の期限は 12:00:00。handle のあるページでは、期限まで 5 分を切った枠 (11:55:00 より後の
// 12:30) は、選んでいなければ受取時間の欄に出ない (下の 4c)。「12:00:00 に 12:30 の枠を選んである」場面は、11:55:00 に開いて
// 選び、12:00:00 まで時間を進めて作る (選んである枠は期限まで欄に残る。30 秒ごとの取り直しは 12:00:00 ちょうどにあり、
// 次は 12:00:30 = 12:00:00 に開いたときと同じ)。
const SELECTABLE_UNTIL = tokyo(11, 55);
const untilNoon = () =>
  act(() => {
    vi.advanceTimersByTime(TOKYO_NOON - Date.now());
  });

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
  // 選んだ受取時間を、自動で「最短（指定なし）」に戻したときの、受取時間の欄の下の案内 (承認済みの字のまま)。
  pickupReset:
    '選んだ受取時間は選べなくなったため、「最短（指定なし）」に戻しました。ほかの時間がよければ、選び直してください。',
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
/** 受取時間の欄の下の案内 (role="status")。この画面で status はこれだけ。出ていなければ null。 */
const pickupReset = () => screen.queryByRole('status');
/** 受付の確認を断る応答 (本文は route と同じ形)。 */
const refused = (status: number, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
    vi.setSystemTime(SELECTABLE_UNTIL);
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
    untilNoon();

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

  // 「前回と同じ注文」は、カートが空のときだけ出る。確認を待ったまま空になる道は、props の更新 (売り切れの反映・注文の中の
  // 品がメニューから消える) だけ (お客様が数量を減らして空にしたときは、その操作で確認が無効になっている)。店のページは
  // 開いたときの売り切れとメニューしか持たないので、今の画面でこの道が起きるのは、待っている間にページが描き直されたときだけ。
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
  // 押す前のカート: 水 と 牛丼（大盛り・えび）がどちらも上限の数量、テーブル番号は既定では上限の長さ (16 字)、枠は 12:45、チェーンは Polygon。
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
    // URL を作るときに落ちる文字 (制御文字・片方だけになったサロゲート) を足しただけでも、行き先の URL は同じ。
    {
      name: 'テーブル番号の間にタブを含む値を貼り付ける',
      table: '78',
      edit: () => fireEvent.change(tableInput(), { target: { value: '7\t8' } }),
      typed: '7\t8',
    },
    {
      name: '15 桁のテーブル番号の末尾に絵文字を足す (16 字に切り詰めて、絵文字の前半だけが残る)',
      table: '123456789012345',
      edit: () => fireEvent.change(tableInput(), { target: { value: '123456789012345😀' } }),
      typed: '123456789012345\ud83d',
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
    vi.setSystemTime(SELECTABLE_UNTIL);
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
    untilNoon();
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
    // 待っている確認は 12:30 の枠で送ってあり、200 なら 12:30 つきの URL へ移る。「最短に戻しました」は、ここでは出さない。
    expect(pickupReset()).toBeNull();

    await gate.admit(0);

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) },
    ]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    // 応答の後の画面の link は、枠の無い URL。
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBeUndefined();
    // 枠つきで移り始めた後も、出さない。
    expect(pickupReset()).toBeNull();
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
  //     最初のその失敗の後に、この画面から送れる確認は 2 本まで。使い切った後は、止まった表示。
  //   - それ以外 (409 の全部の理由・知らない応答): 今までどおり、status だけで止まった表示 (開き直すまで戻らない)。
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

  // 最初の「確かめられなかった」失敗の後に、この画面から送れる確認は 2 本まで (送る時に数える)。受付の確認の枠
  // (rate limit) は、同じネットワークのほかのお客様と共有なので、その失敗の後に 1 つの画面が足せる確認は、今までの
  // 0 本に対して最大 +2 本。二度押しでも、注文を変えて押し直しても、通って移った後でも、この 2 本は増えない。
  /** n 本目 (0 始まり) の確認を、種類ごとの「確かめられなかった」で返す。 */
  const failAs = (gate: ReturnType<typeof gatedFetches>, index: number, kind: string) =>
    kind === '例外' ? gate.fail(index) : gate.respond(index, refused(Number(kind), 'x'));

  it('例外 → 案内 → 押す → 429 → 案内 → 押す → 503 で、止まった表示になる (確認は 3 本・案内は消える・その後は押す所が無く、品を足しても・時間が進んでも戻らない)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');

    fireEvent.click(payLink()!);
    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    fireEvent.click(payLink()!);
    await gate.respond(1, refused(429, 'rate_limited'));
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(screen.queryByText(TEXT.closed)).toBeNull();

    fireEvent.click(payLink()!);
    await gate.respond(2, refused(503, 'kv_unavailable'));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
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
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each(['例外', '429', '500', '503'])('案内を 2 回出した後の 3 回目の失敗が %s なら、止まった表示', async (kind) => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    for (const index of [0, 1]) {
      fireEvent.click(payLink()!);
      await failAs(gate, index, kind);
      expect(notice()?.textContent).toBe(TEXT.retryNotice);
    }

    fireEvent.click(payLink()!);
    await failAs(gate, 2, kind);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
  });

  it('注文を変えても、送れる本数は戻らない: 案内 → 品を足して押す → 案内 → 品を足して押す → 3 回目の失敗で止まった表示', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    add('水');
    fireEvent.click(payLink()!);
    await gate.fail(1);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    add('チーズケーキ');
    fireEvent.click(payLink()!);
    await gate.fail(2);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
  });

  it.each(['例外', '429'])('最初の有効な失敗の前は、今までどおり数えない: 注文を変えて無効にした確認が 3 本 %s で返った後でも、有効な失敗の後に 2 本送れる (案内は 2 回出て、3 回目の失敗で止まる)', async (kind) => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    // 押す → 待つ間に品を足す (待っていた確認は無効) → その確認が失敗で返る、を 3 回。
    for (const index of [0, 1, 2]) {
      fireEvent.click(payLink()!);
      add('水');
      await failAs(gate, index, kind);
      expect(notice()).toBeNull();
      expect(screen.queryByText(TEXT.closed)).toBeNull();
    }

    for (const index of [3, 4]) {
      fireEvent.click(payLink()!);
      await failAs(gate, index, kind);
      expect(notice()?.textContent).toBe(TEXT.retryNotice);
      expect(screen.queryByText(TEXT.closed)).toBeNull();
    }
    fireEvent.click(payLink()!);
    await failAs(gate, 5, kind);

    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
  });

  /** 再描画が挟まらずに届く 2 回の click (押せないボタンに替わる前の二度押し)。 */
  const doublePress = async () => {
    const link = payLink()!;
    await act(async () => {
      fireEvent.click(link);
      fireEvent.click(link);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  };
  const unavailable = () => refused(503, 'kv_unavailable');

  it('最初の失敗の後に二度押しを繰り返しても、送れる確認は 2 本まで: 最初の 1 本と合わせて確認は 3 本で、片方の失敗で止まった表示になる (もう一度押す所が無い)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    await gate.respond(0, unavailable());
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 押し直しの二度押し: 2 本とも送る (これで使い切る)。
    await doublePress();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    await gate.respond(1, unavailable());

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();

    await gate.respond(2, unavailable());

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
  });

  it('最初の失敗の後に「押し直す → 待つ間に数量を変える → 古い確認が失敗で返る」を繰り返しても、送れる確認は 2 本まで: 確認は 3 本で、2 回目に数量を変えた所で止まった表示になる', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    await gate.respond(0, unavailable());
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 水の追加と削除を交互に、4 回まで試す。押す所がなくなったら、そこで終わり。
    let rounds = 0;
    for (const round of [0, 1, 2, 3]) {
      if (!payLink()) break;
      rounds += 1;
      fireEvent.click(payLink()!);
      if (round % 2 === 0) add('水');
      else removeOne('水');
      await gate.respond(round + 1, unavailable());
    }

    expect(rounds).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it('送れる確認が 1 本残っている間は、待つ間に注文を変えても押し直せる。最後の 1 本を待つ間に注文を変えると、その場で止まった表示になる (押しても送れない「支払いへ進む」を出さない)。無効にした確認が 200 で返っても移らない', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 1 本目の押し直し (残り 1 本) を待つ間に注文を変える: 今までどおり、押し直せる状態に戻る。
    fireEvent.click(payLink()!);
    add('水');
    expect(payLink()).not.toBeNull();
    expect(screen.queryByText(TEXT.closed)).toBeNull();

    // 2 本目の押し直し (これで使い切る) を待つ間に注文を変える: 押し直せる状態には戻さない。
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(payButton()).toBeDisabled();
    add('チーズケーキ');

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    expect(cartToggle()).toBeNull();

    await gate.admit(2);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
  });

  it('最後の 1 本でも、待つ間に注文を変えず、200 で返れば移る (途中で注文を変えて押し直した分も 1 本に数える)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);
    await gate.fail(0);
    fireEvent.click(payLink()!);
    add('水');
    const next = payHref();

    fireEvent.click(payLink()!);
    await gate.admit(2);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(assignSpy.mock.calls).toEqual([[next]]);
    expect(screen.queryByText(TEXT.closed)).toBeNull();
  });

  it('「確かめられなかった」失敗がまだ無い間は、今までどおり何本でも送れる: 待つ間に注文を変えて押し直すのを 5 回繰り返した後でも、次の確認が 200 なら移る', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    for (let round = 0; round < 5; round++) {
      fireEvent.click(payLink()!);
      add('水');
    }
    const next = payHref();

    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    await gate.admit(5);

    expect(assignSpy.mock.calls).toEqual([[next]]);
    expect(screen.queryByText(TEXT.closed)).toBeNull();
  });

  // 確認が通ると /checkout へ移る。ここでは移動を受け止めているので、同じ画面が残る (ブラウザの「戻る」で同じ画面が
  // そのまま戻った場合にあたる)。
  it('押し直した確認が通って移った後も、送れる本数は戻らない: 失敗 → 200 → 同じ画面で押す → 失敗で、案内でなく止まった表示 (確認は 3 本)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    fireEvent.click(payLink()!);
    await gate.fail(0);
    fireEvent.click(payLink()!);
    await gate.admit(1);
    expect(assignSpy.mock.calls).toEqual([[href]]);

    fireEvent.click(payLink()!);
    await gate.fail(2);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  it('送れる本数を使い切った後に「支払いへ進む」を押すと、確認を送らずに止まった表示にする: 失敗 → 失敗 → 200 で移った後、同じ画面で押す', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    fireEvent.click(payLink()!);
    await gate.fail(0);
    fireEvent.click(payLink()!);
    await gate.fail(1);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    fireEvent.click(payLink()!);
    await gate.admit(2);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(payLink()).not.toBeNull();

    const pressed = await pressPay();

    // link の移動も止めたまま (受付を確かめずに /checkout へ行かせない)。
    expect(pressed.defaultPrevented).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  it('送れる確認が 1 本のときの二度押しは、1 本だけ送る。2 回目の click は送らずに止まった表示にし、送った 1 本が 200 で返れば移る (今の動き)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    const href = payHref();
    fireEvent.click(payLink()!);
    await gate.fail(0);
    fireEvent.click(payLink()!);
    await gate.fail(1);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    await doublePress();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();

    await gate.admit(2);

    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // 後から届く応答。送れる本数を数え始める前 (最初の失敗の前) から飛んでいた確認は、数に入っていない。その確認が
  // 後から失敗で返っても、送れる本数は増えも減りもしない (減らすのは送る時だけ)。
  it('再描画の前の二度押しで 2 本飛び、1 本目の失敗の後に押し直してから、2 本目が後から失敗で返っても、送れる本数は変わらない: 案内が出て、もう 1 本だけ送れる。その失敗で止まった表示 (確認は 2 + 2 = 4 本)', async () => {
    const gate = gatedFetches();
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    await doublePress();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 1 本目が失敗: ここから、送れるのは 2 本。
    await gate.respond(0, unavailable());
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 押し直す (残り 1 本)。最初から飛んでいた 2 本目が、その後に失敗で返る。
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await gate.respond(1, unavailable());

    // 残りは 1 本のまま: 止まった表示ではなく案内で、押し直せる。
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 最後の 1 本。その失敗で止まる。
    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    await gate.respond(3, unavailable());

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();

    // 押し直しの 1 本目 (まだ返っていなかった確認) が失敗で返っても、そのまま。
    await gate.respond(2, unavailable());

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
  });

  it('再描画の前の二度押しの 2 本が、同じ描画の間に 2 本とも失敗で返っても、送れる本数は 2 本のまま (2 本目の失敗で書き換えない・減らさない): 押し直しの 1 本目の失敗では案内、2 本目の失敗で止まった表示 (確認は 2 + 2 = 4 本)', async () => {
    const rejects: ((error: Error) => void)[] = [];
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejects.push(reject);
        }),
    );
    const failTogether = async (...indexes: number[]) => {
      await act(async () => {
        for (const index of indexes) rejects[index](new TypeError('Failed to fetch'));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
    };
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    await doublePress();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await failTogether(0, 1);

    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 押し直しの 1 本目 (残り 1 本) の失敗: まだ送れるので案内。
    fireEvent.click(payLink()!);
    await failTogether(2);
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(notice()?.textContent).toBe(TEXT.retryNotice);

    // 押し直しの 2 本目 (これで使い切る) の失敗: 止まった表示。
    fireEvent.click(payLink()!);
    await failTogether(3);

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
  });

  // お店の側の拒否と、知らない応答。やり直せると決めない。409 は理由によらず止まった表示 (本文は読まない)。
  const stopResponses: { name: string; response: () => Response }[] = [
    { name: '400', response: () => refused(400, 'invalid_request') },
    { name: '404', response: () => refused(404, 'storefront_not_found') },
    { name: '413', response: () => refused(413, 'payload_too_large') },
    { name: '409 store_not_accepting', response: () => refused(409, 'store_not_accepting') },
    { name: '409 storefront_changed', response: () => refused(409, 'storefront_changed') },
    { name: '409 pickup_slots_unavailable', response: () => refused(409, 'pickup_slots_unavailable') },
    { name: '409 pickup_slot_unavailable', response: () => refused(409, 'pickup_slot_unavailable') },
    { name: '409 知らない理由', response: () => refused(409, 'something_new') },
    { name: '409 理由なし', response: () => new Response('{}', { status: 409 }) },
    { name: '409 本文が JSON でない', response: () => new Response('<html>', { status: 409 }) },
    { name: '409 本文が空', response: () => new Response(null, { status: 409 }) },
  ];

  it.each(stopResponses)('応答が $name なら、今までどおり止まった表示: 移らず、支払い欄が消え、押し直しの案内は出ない。品を足しても・時間が進んでも戻らない。開き直すと戻る', async ({ response }) => {
    fetchSpy.mockImplementation(async () => response());
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');

    await pressPay();

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

  // 枠を選んだ確認でも同じ。押す前に時計だけ 1 ms 進めた場合 (今 + 準備 30 分の最短の枠が 12:45 になり、選んだ 12:30 が
  // 端末の計算でも候補から外れる。画面の候補は 30 秒の取り直しまで古いまま) も、枠を外して続けたりはしない。
  it.each(
    stopResponses.flatMap((r) => [
      { ...r, clockAhead: 0 },
      { ...r, clockAhead: 1 },
    ]),
  )('12:30 の枠を選んだ確認への応答が $name なら (押す前に時計 +$clockAhead ms)、止まった表示: 枠は選んだまま・押し直しの案内は出ない', async ({ response, clockAhead }) => {
    fetchSpy.mockImplementation(async () => response());
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    vi.setSystemTime(TOKYO_NOON + clockAhead);

    await pressPay();

    expect(postedBodies()).toEqual([
      { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) },
    ]);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(notice()).toBeNull();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
  });

  it.each(['枠なし', '枠あり'])('409 は status だけで止まる (%s): 本文を読まないので、本文が届かなくても待たない', async (kind) => {
    const json = vi.fn(() => new Promise<unknown>(() => {}));
    const text = vi.fn(() => new Promise<string>(() => {}));
    const gate = gatedFetches();
    if (kind === '枠あり') vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    if (kind === '枠あり') {
      choosePickup('12:30');
      untilNoon();
    }
    fireEvent.click(payLink()!);

    await gate.respond(0, { ok: false, status: 409, json, text } as unknown as Response);

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payButton()).toBeNull();
    expect(notice()).toBeNull();
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
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

  // 案内の文は、ボタンの名前を引いている。ボタンの字を変えたら、案内の文も一緒に直す。
  it.each([
    ['ja', jaMessages.MobileOrder],
    ['en', enMessages.MobileOrder],
  ] as const)('案内の文 (%s) は、「支払いへ進む」のボタンを、画面と同じ字で引いている', (_locale, m) => {
    expect(m.admissionRetryNotice).toContain(m.payButton);
  });

  it('案内の文は承認された字のまま (ja / en)', () => {
    expect(jaMessages.MobileOrder.admissionRetryNotice).toBe(TEXT.retryNotice);
    expect(enMessages.MobileOrder.admissionRetryNotice).toBe(
      "Couldn't continue to payment. Please wait a moment, then tap “Proceed to pay” again.",
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

  it('選んだ受け取りの枠が候補から外れたら選択を外し、欄の下に案内を出す: URL から pickup_at が消え、POST の本文にも載らない', async () => {
    vi.setSystemTime(SELECTABLE_UNTIL);
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
    untilNoon();
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBe(String(tokyo(12, 30)));
    expect(pickupReset()).toBeNull();

    // 30 秒たつと 12:00:30 + 30 分 → 最初の枠は 12:45。12:30 は候補から外れる。
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(within(select()).queryByRole('option', { name: '12:30' })).toBeNull();
    expect(select().value).toBe('');
    expect(within(select()).getByRole<HTMLOptionElement>('option', { name: TEXT.pickupAsap }).selected).toBe(true);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
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
    // 進んだ先は枠の無い URL (最短)。案内は出たまま。
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
  });

  it('まだ候補に残っている枠は、時間が進んでも選んだまま (案内も出ない)', () => {
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
    expect(pickupReset()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4b. 選んだ受取時間を、自動で「最短（指定なし）」に戻したときの案内 (受取時間の欄のすぐ下・role="status")
//   - 出すのは、選んでいた枠が候補から外れて、選択を最短に戻した時。最初から最短・枠が候補に残っている間は出さない。
//   - 案内が言うのは「今の選択は最短で、この先は最短で進む」。枠つきの URL へ進む (進むかもしれない) 間は出さない:
//     ページを離れ始めた後は出さない。受付の確認を待っている間は出さず、その確認が移らずに終わった所で出す。
//   - 消えるのは、お客様が受取時間を選んだ時だけ。
//   - 送るもの (確認の本文)・進む先 (URL)・枠を外す動き・世代・送れる本数は、案内の有無で変わらない。
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 選んだ受取時間を自動で「最短（指定なし）」に戻したときの案内 (時間の flag ON)', () => {
  beforeEach(() => {
    envHold.enablePreorderTime = true;
  });

  // 事前注文・準備 30 分。12:00:00 に開くと、候補は 12:30 から。30 秒後の取り直しで、12:30 は候補から外れる。
  const slotConfig: MobileOrderConfig = { ...config, mode: 'preorder', minLeadMinutes: 30 };
  const pickupSelect = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
  const pickupOption = (name: string) =>
    within(pickupSelect()).queryByRole<HTMLOptionElement>('option', { name });
  const choosePickup = (name: string) =>
    fireEvent.change(pickupSelect(), { target: { value: pickupOption(name)!.value } });
  const passTime = (ms = 30_000) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const SLOT_BODY = { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) };
  const ASAP_BODY = { handle: HANDLE, merchant: RECEIVER, mode: 'preorder' };
  /** 再描画を挟まない二度押し (2 本とも同じ中身の確認)。 */
  async function pressPayTwiceAtOnce() {
    const link = payLink()!;
    await act(async () => {
      fireEvent.click(link);
      fireEvent.click(link);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  it('案内の文は承認された字のまま (ja / en)。key は MobileOrder の中だけにある', () => {
    expect(jaMessages.MobileOrder.pickupResetNotice).toBe(TEXT.pickupReset);
    expect(enMessages.MobileOrder.pickupResetNotice).toBe(
      "The pickup time you chose is no longer available, so it's been reset to “Soonest (unspecified)”. Choose another time if you'd like.",
    );
    // 同じ名前の key が、ほかの namespace (入れ子も) に無い。
    const pathsOf = (node: unknown, path: string[] = []): string[] =>
      node !== null && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) =>
            key === 'pickupResetNotice'
              ? [[...path, key].join('.')]
              : pathsOf(value, [...path, key]),
          )
        : [];
    expect(pathsOf(jaMessages)).toEqual(['MobileOrder.pickupResetNotice']);
    expect(pathsOf(enMessages)).toEqual(['MobileOrder.pickupResetNotice']);
  });

  // 案内の文は、欄の選択肢の名前を引いている。選択肢の字を変えたら、案内の文も一緒に直す。
  it.each([
    ['ja', jaMessages.MobileOrder],
    ['en', enMessages.MobileOrder],
  ] as const)('案内の文 (%s) は、「最短（指定なし）」の選択肢を、欄と同じ字で引いている', (_locale, m) => {
    expect(m.pickupResetNotice).toContain(m.pickupAsap);
  });

  it('最初から「最短（指定なし）」のままなら、時間が進んで候補が入れ替わっても、案内は出ない', () => {
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    // 12:00:00 は 12:30 の枠の受付の期限ちょうど (期限まで 5 分を切っている) なので、選んでいない 12:30 は欄に無い (4c)。
    expect(pickupOption('12:30')).toBeNull();
    expect(pickupOption('12:45')).not.toBeNull();
    expect(pickupReset()).toBeNull();

    passTime();

    expect(pickupOption('12:30')).toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
    passTime(20 * 60_000);
    expect(pickupOption('12:45')).toBeNull();
    expect(pickupReset()).toBeNull();
  });

  it('選んだ枠が候補に残っている間は出ない。候補から外れた所で、欄のすぐ下に出る (role は status・alert ではない・aria-label なし)', () => {
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:45');

    // 12:15:00 ちょうどの取り直しまでは、最短の受け取り (今 + 30 分) が 12:45 の枠に収まる。
    passTime(15 * 60_000);
    expect(pickupSelect().value).toBe(String(tokyo(12, 45)));
    expect(pickupReset()).toBeNull();

    // 12:15:30 の取り直しで、最短は 13:00 の枠になる。
    passTime();

    expect(pickupOption('12:45')).toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupOption(TEXT.pickupAsap)!.selected).toBe(true);
    const shown = pickupReset()!;
    expect(shown.textContent).toBe(jaMessages.MobileOrder.pickupResetNotice);
    expect(shown.textContent).toContain(pickupOption(TEXT.pickupAsap)!.textContent);
    expect(pickupSelect().nextElementSibling).toBe(shown);
    expect(shown.tagName).toBe('P');
    expect(shown.hasAttribute('aria-label')).toBe(false);
    // 支払いのボタンの上の案内 (alert) とは別の要素。そちらは出ていない。
    expect(notice()).toBeNull();
    // 選び直せる: 欄には次の候補がある。支払い欄も残っている。
    expect(pickupOption('13:00')).not.toBeNull();
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBeUndefined();
  });

  it('英語の画面では、英語の案内が出る', () => {
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />, { locale: 'en' });
    fireEvent.click(
      within(menuCard('ブレンド')).getByRole('button', { name: enMessages.MobileOrder.qtyIncrease }),
    );
    const select = () => screen.getByLabelText(enMessages.MobileOrder.pickupLabel) as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: String(tokyo(12, 30)) } });
    untilNoon();
    expect(select().value).toBe(String(tokyo(12, 30)));

    passTime();

    expect(select().value).toBe('');
    expect(select().selectedOptions[0].textContent).toBe(enMessages.MobileOrder.pickupAsap);
    expect(pickupReset()?.textContent).toBe(enMessages.MobileOrder.pickupResetNotice);
    expect(select().nextElementSibling).toBe(pickupReset());
  });

  it('案内は、お客様が別の受取時間を選ぶと消える。選び直した枠がまた候補から外れると、また出る', () => {
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    passTime();
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    choosePickup('12:45');

    expect(pickupReset()).toBeNull();
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBe(String(tokyo(12, 45)));

    // 12:15:30 の取り直しで 12:45 も外れる。
    passTime(15 * 60_000);

    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
  });

  it('自分で選び直して消えた案内は、その後の確認が失敗で返っても戻らない (選んだ枠は選んだまま)', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    passTime();
    expect(pickupReset()).not.toBeNull();
    choosePickup('12:45');
    expect(pickupReset()).toBeNull();

    fireEvent.click(payLink()!);
    await gate.fail(0);

    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(pickupSelect().value).toBe(String(tokyo(12, 45)));
    expect(pickupReset()).toBeNull();
    // 注文を変えて、押し直した確認を無効にした所でも戻らない。
    fireEvent.click(payLink()!);
    add('水');
    expect(pickupReset()).toBeNull();
    expect(postedBodies()).toEqual([
      { ...ASAP_BODY, pickupAt: tokyo(12, 45) },
      { ...ASAP_BODY, pickupAt: tokyo(12, 45) },
    ]);
  });

  // 案内が出ている間、欄の選択は「最短（指定なし）」。ブラウザは、選んである選択肢をもう一度選んでも change を出さないので、
  // この行は「最短を選ぶ change でも消える (自分で選んだ後は出さない)」を、change を直接送って確かめる。
  it('案内は、「最短（指定なし）」を選ぶ change でも消える', () => {
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    passTime();
    expect(pickupReset()).not.toBeNull();

    fireEvent.change(pickupSelect(), { target: { value: '' } });

    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
  });

  it('案内は、受取時間を選ぶ以外では消えない (品を足す・明細を開く・時間が進む・カートを空にして入れ直す・「支払いへ進む」を押して待つ)。そのまま進む先は枠の無い URL', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    passTime();
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    add('水');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    fireEvent.click(cartToggle()!);
    fireEvent.click(cartToggle()!);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    passTime(60_000);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    // カートを空にすると支払い欄 (受取時間の欄ごと) が消える。入れ直すと、欄と一緒に案内も戻る (選択は最短のまま)。
    removeOne('ブレンド');
    removeOne('水');
    expect(cartToggle()).toBeNull();
    expect(pickupReset()).toBeNull();
    add('ブレンド');
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    // 押して待つ間も出たまま。この確認は枠なし (最短) で、進む先も枠の無い URL。
    const href = payHref();
    expect(readCheckoutUrl(href).query.pickup_at).toBeUndefined();
    fireEvent.click(payLink()!);
    expect(payButton()).toBeDisabled();
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    await gate.admit(0);

    expect(postedBodies()).toEqual([ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
  });

  // 受付の確認が 200 で返り、選んだ枠つきの URL へ移り始めた後も、/checkout が返るまでこのページは残り、時刻の取り直しも
  // 動き続ける。その間に枠が外れても、「最短に戻しました」は出さない (進む先は選んだ枠)。
  it('移動を始めた後 (選んだ枠つきの URL へ assign した後) に枠が外れても、案内は出ない', async () => {
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    const href = payHref();

    await pressPay();

    expect(postedBodies()).toEqual([SLOT_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(readCheckoutUrl(href).query.pickup_at).toBe(String(tokyo(12, 30)));

    passTime();

    // 枠を外す動きそのものは今までどおり。
    expect(pickupOption('12:30')).toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
    passTime(5 * 60_000);
    expect(pickupReset()).toBeNull();
  });

  it.each(['例外', '429', '503'])('待っている間に枠が外れても、その場では出ない。その確認がやり直せる失敗 (%s) で終わると、押し直しの案内と一緒に出る。押し直した確認は枠なし (最短) で、進む先も枠の無い URL', async (kind) => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);

    passTime();

    expect(pickupSelect().value).toBe('');
    expect(payButton()).toBeDisabled();
    expect(pickupReset()).toBeNull();

    if (kind === '例外') await gate.fail(0);
    else await gate.respond(0, refused(Number(kind), 'x'));

    // 2 つの案内は別の場所: 受取時間の欄のすぐ下 (status) と、「支払いへ進む」のすぐ上 (alert)。
    expect(assignSpy).not.toHaveBeenCalled();
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(notice()?.nextElementSibling).toBe(payLink());
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(pickupSelect().nextElementSibling).toBe(pickupReset());
    expect(
      pickupReset()!.compareDocumentPosition(notice()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 押し直す: 押し直しの案内は押した時に消える。受取時間の案内は残る (選び直していない)。
    const next = payHref();
    expect(readCheckoutUrl(next).query.pickup_at).toBeUndefined();
    fireEvent.click(payLink()!);
    expect(notice()).toBeNull();
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    await gate.admit(1);

    expect(postedBodies()).toEqual([SLOT_BODY, ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it('待っている間に枠が外れ、注文を変えて待っていた確認を無効にすると、その場で案内が出る。無効にした確認が 200 で返っても移らず、押し直した確認は枠なし', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);
    passTime();
    expect(pickupReset()).toBeNull();

    add('水');

    // 待っていた確認 (12:30 の枠つき) は、もう使わない。次に押すと最短で送る。
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(notice()).toBeNull();
    const next = payHref();
    expect(readCheckoutUrl(next).query.pickup_at).toBeUndefined();

    await gate.admit(0);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    fireEvent.click(payLink()!);
    await gate.admit(1);

    expect(postedBodies()).toEqual([SLOT_BODY, ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[next]]);
  });

  it('待っている間に枠が外れた後、お客様が自分で別の枠を選ぶと、案内は出ない (待っていた確認は無効・押し直した確認は選んだ枠)', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);
    passTime();

    choosePickup('12:45');

    expect(pickupReset()).toBeNull();
    await gate.admit(0);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(pickupReset()).toBeNull();

    const next = payHref();
    fireEvent.click(payLink()!);
    await gate.admit(1);

    expect(postedBodies()).toEqual([SLOT_BODY, { ...ASAP_BODY, pickupAt: tokyo(12, 45) }]);
    expect(assignSpy.mock.calls).toEqual([[next]]);
    expect(pickupReset()).toBeNull();
  });

  it('待っている間に枠が外れ、その確認が 409 で終わると、今までどおり止まった表示 (支払い欄ごと消えるので、案内は見えない)', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);
    passTime();

    await gate.respond(0, refused(409, 'pickup_slot_unavailable'));

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(cartToggle()).toBeNull();
    expect(payLink()).toBeNull();
    expect(notice()).toBeNull();
    expect(pickupReset()).toBeNull();
    expect(postedBodies()).toEqual([SLOT_BODY]);
  });

  it('押し直しの案内が出ている所 (待っていない) で枠が外れると、その場で出る: 2 つの案内が別の場所に同時に出る', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);
    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(pickupSelect().value).toBe(String(tokyo(12, 30)));
    expect(pickupReset()).toBeNull();

    passTime();

    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(pickupSelect().nextElementSibling).toBe(pickupReset());
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(notice()?.nextElementSibling).toBe(payLink());
  });

  // 再描画の前の二度押しでは、1 本目が返った所で「支払いへ進む」は押せる link に戻るが、2 本目 (同じ枠つき) はまだ飛んでいる。
  // 2 本目が 200 なら枠つきの URL へ移る (今の動き) ので、2 本目が返るまでは「最短に戻しました」を出さない。
  it('二度押しの 1 本目が失敗で返った後に枠が外れても、2 本目が返るまでは出ない。2 本目が 200 なら、出ないまま選んだ枠つきの URL へ移る', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    const href = payHref();
    await pressPayTwiceAtOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await gate.fail(0);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(payLink()).not.toBeNull();

    passTime();

    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();

    await gate.admit(1);

    expect(postedBodies()).toEqual([SLOT_BODY, SLOT_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(readCheckoutUrl(href).query.pickup_at).toBe(String(tokyo(12, 30)));
    expect(pickupReset()).toBeNull();
  });

  it('二度押しの 1 本目が失敗で返った後に枠が外れ、2 本目も失敗で返ると、そこで出る', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    await pressPayTwiceAtOnce();
    await gate.fail(0);
    passTime();
    expect(pickupReset()).toBeNull();

    await gate.fail(1);

    expect(assignSpy).not.toHaveBeenCalled();
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
  });

  it('二度押しの 1 本目が失敗で返った後に枠が外れ、押し直した確認 (枠なし) を待つ間に、2 本目 (枠つき) が 200 で返ると、出ないまま枠つきの URL へ移る (進む先は今の動き)', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    const href = payHref();
    await pressPayTwiceAtOnce();
    await gate.fail(0);
    passTime();

    fireEvent.click(payLink()!);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(pickupReset()).toBeNull();

    await gate.admit(1);

    expect(postedBodies()).toEqual([SLOT_BODY, SLOT_BODY, ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(pickupReset()).toBeNull();
    // 移り始めた後は、残りの確認が失敗で返っても出さない。
    await gate.fail(2);
    expect(pickupReset()).toBeNull();
  });

  // 枠を外す effect が動いてから描き直すまでの間に click が届くと、その click は「描き直す前の画面」の枠つきで進む
  // (進む先と本文は今の動き)。effect はその時点で誰も待っていないので案内を出すと決めているが、この click が取り下げる。
  // click を「effect の直後・描き直しの前」に届けるために、同じ commit の後ろの effect から押す。
  function ClickAfterCommit({ run }: { run: (() => void) | null }) {
    useEffect(() => {
      run?.();
    }, [run]);
    return null;
  }
  it.each(['200', '例外'])('枠を外す effect の直後・描き直しの前に届いた click の確認が %s で返る: 200 なら出ないまま枠つきの URL へ移る・失敗なら、そこで出る', async (kind) => {
    const gate = gatedFetches();
    const tree = (run: (() => void) | null) => (
      <>
        <MobileOrderView config={slotConfig} handle={HANDLE} />
        <ClickAfterCommit run={run} />
      </>
    );
    vi.setSystemTime(SELECTABLE_UNTIL);
    const view = renderWithIntl(tree(null));
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    const href = payHref();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      view.rerender(tree(() => fireEvent.click(payLink()!)));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    // click は、枠が外れる前の画面の中身で確認を送っている。
    expect(postedBodies()).toEqual([SLOT_BODY]);
    expect(pickupSelect().value).toBe('');
    expect(payButton()).toBeDisabled();
    expect(pickupReset()).toBeNull();

    if (kind === '200') {
      await gate.admit(0);
      expect(assignSpy.mock.calls).toEqual([[href]]);
      expect(readCheckoutUrl(href).query.pickup_at).toBe(String(tokyo(12, 30)));
      expect(pickupReset()).toBeNull();
    } else {
      await gate.fail(0);
      expect(assignSpy).not.toHaveBeenCalled();
      expect(notice()?.textContent).toBe(TEXT.retryNotice);
      expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    }
  });

  it('待つ間に枠が外れて案内が出ても、送れる確認の本数は変わらない: 失敗 → 押す → 失敗 → 押す → 失敗で止まった表示 (確認は 3 本・2 本目からは枠なし)', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);
    passTime();
    await gate.fail(0);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    fireEvent.click(payLink()!);
    await gate.respond(1, refused(429, 'rate_limited'));
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    fireEvent.click(payLink()!);
    await gate.fail(2);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(postedBodies()).toEqual([SLOT_BODY, ASAP_BODY, ASAP_BODY]);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(pickupReset()).toBeNull();
  });

  // 受付の確認を通らない経路 (@handle の無いページ = ?s= の注文ページ・ビルダーのプレビュー)。
  it('@handle の無いページでも、選んだ枠が候補から外れた所で出る', () => {
    renderWithIntl(<MobileOrderView config={slotConfig} />);
    add('ブレンド');
    choosePickup('12:30');

    passTime();

    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBeUndefined();
  });

  it('@handle の無いページで link を押した後 (link の移動でページを離れ始めた後) に枠が外れても、案内は出ない。link の移動は止めない', async () => {
    renderWithIntl(<MobileOrderView config={slotConfig} />);
    add('ブレンド');
    choosePickup('12:30');
    const href = payHref();
    expect(readCheckoutUrl(href).query.pickup_at).toBe(String(tokyo(12, 30)));

    const pressed = await pressPay();

    expect(pressed.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();

    passTime();

    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
  });

  it('ビルダーのプレビューで、店主が準備時間を延ばして選んだ枠が外れた場合も出る (文は理由を言っていない)', () => {
    const view = renderWithIntl(<MobileOrderView config={slotConfig} />);
    add('ブレンド');
    choosePickup('12:30');

    view.rerender(<MobileOrderView config={{ ...slotConfig, minLeadMinutes: 60 }} />);

    expect(pickupOption('12:30')).toBeNull();
    expect(pickupOption('13:00')).not.toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
  });

  it('候補が 1 つも無くなって枠が外れたときは、支払い欄ごと消えるので見えない (選び直す欄が無い)', () => {
    const view = renderWithIntl(<MobileOrderView config={slotConfig} />);
    add('ブレンド');
    choosePickup('12:30');

    // ラストオーダー 12:10: 最短の受け取り (12:30) がラストオーダーを越えるので、候補は 0 件。
    view.rerender(<MobileOrderView config={{ ...slotConfig, lastOrder: '12:10' }} />);

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(cartToggle()).toBeNull();
    expect(pickupReset()).toBeNull();
  });

  // 「選べなくなった」が事実なのは、外した枠が候補に無い間だけ。プレビューで店主が設定を戻して、外した枠が候補に戻ったら
  // 出さない (選択は最短のまま)。その枠が時間の経過でまた候補から外れたら、また出る。
  it('外した枠が候補に戻っている間は出さない (プレビューで準備時間を延ばして戻した)。その枠がまた候補から外れると出る', () => {
    const view = renderWithIntl(<MobileOrderView config={slotConfig} />);
    add('ブレンド');
    choosePickup('12:30');
    view.rerender(<MobileOrderView config={{ ...slotConfig, minLeadMinutes: 60 }} />);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    view.rerender(<MobileOrderView config={slotConfig} />);

    expect(pickupOption('12:30')).not.toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();

    passTime();

    expect(pickupOption('12:30')).toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 案内を、受取時間の欄と「支払いへ進む」の説明 (aria-describedby) として結ぶ。
  //   - 支払う人は必ず「支払いへ進む」に触れる。そこで、最短に戻した理由が説明として読まれる (案内がその場で読み上げ
  //     られたかどうかに依らない)。
  //   - 結ぶのは、案内が DOM に出ている間だけ。出ていない間は属性そのものを出さない (無い id を指さない)。
  //   - 名前 (欄 = 「受取時間」・リンク = 「支払いへ進む」) は変えない。押し直しの案内 (alert) は説明に混ぜない。
  // -------------------------------------------------------------------------------------------------------------------
  const NOTICE_ID = 'mo-pickup-notice';
  /** 12:30 を選び、その枠が候補から外れて「最短（指定なし）」に戻った所 (案内が出ている)。 */
  function openWithResetNotice() {
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    passTime();
  }
  const describedBy = (el: Element | null) => el!.getAttribute('aria-describedby');

  it('案内が出ている間、受取時間の欄と「支払いへ進む」の説明は、案内の文になる (名前は変わらない)', () => {
    openWithResetNotice();

    expect(pickupReset()?.id).toBe(NOTICE_ID);
    expect(describedBy(pickupSelect())).toBe(NOTICE_ID);
    expect(pickupSelect()).toHaveAccessibleDescription(TEXT.pickupReset);
    expect(pickupSelect()).toHaveAccessibleName(TEXT.pickup);
    expect(describedBy(payLink())).toBe(NOTICE_ID);
    expect(payLink()).toHaveAccessibleDescription(TEXT.pickupReset);
    expect(payLink()).toHaveAccessibleName(TEXT.pay);
  });

  it('英語の画面では、欄と「Proceed to pay」の説明は、英語の案内の文になる', () => {
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />, { locale: 'en' });
    fireEvent.click(
      within(menuCard('ブレンド')).getByRole('button', { name: enMessages.MobileOrder.qtyIncrease }),
    );
    const select = () => screen.getByLabelText(enMessages.MobileOrder.pickupLabel) as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: String(tokyo(12, 30)) } });
    untilNoon();
    passTime();

    const link = screen.getByRole('link', { name: enMessages.MobileOrder.payButton });
    expect(select()).toHaveAccessibleDescription(enMessages.MobileOrder.pickupResetNotice);
    expect(link).toHaveAccessibleDescription(enMessages.MobileOrder.pickupResetNotice);
  });

  it('案内が出ていない間は、欄にもリンクにも aria-describedby の属性そのものが無い (最初から・選んだ直後・選んだ枠が候補に残っている間)', () => {
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    const expectNotDescribed = () => {
      expect(pickupReset()).toBeNull();
      expect(document.getElementById(NOTICE_ID)).toBeNull();
      expect(pickupSelect().hasAttribute('aria-describedby')).toBe(false);
      expect(payLink()!.hasAttribute('aria-describedby')).toBe(false);
    };
    expectNotDescribed();

    choosePickup('12:45');
    expectNotDescribed();

    passTime();
    expect(pickupSelect().value).toBe(String(tokyo(12, 45)));
    expectNotDescribed();
  });

  it('選び直して案内が消えると、欄とリンクの属性も消える。選び直した枠がまた外れて案内が戻ると、属性も戻る', () => {
    openWithResetNotice();
    expect(describedBy(pickupSelect())).toBe(NOTICE_ID);
    expect(describedBy(payLink())).toBe(NOTICE_ID);

    choosePickup('12:45');

    expect(pickupReset()).toBeNull();
    expect(pickupSelect().hasAttribute('aria-describedby')).toBe(false);
    expect(payLink()!.hasAttribute('aria-describedby')).toBe(false);

    // 12:15:30 の取り直しで 12:45 も外れる。
    passTime(15 * 60_000);

    expect(pickupSelect().value).toBe('');
    expect(pickupSelect()).toHaveAccessibleDescription(TEXT.pickupReset);
    expect(payLink()).toHaveAccessibleDescription(TEXT.pickupReset);
  });

  it('案内の id は、出ている間、画面に 1 つだけ (カートを空にして入れ直した後も)', () => {
    openWithResetNotice();
    expect(document.querySelectorAll(`#${NOTICE_ID}`)).toHaveLength(1);
    expect(document.getElementById(NOTICE_ID)).toBe(pickupReset());

    removeOne('ブレンド');
    expect(document.querySelectorAll(`#${NOTICE_ID}`)).toHaveLength(0);
    add('ブレンド');

    expect(document.querySelectorAll(`#${NOTICE_ID}`)).toHaveLength(1);
    expect(payLink()).toHaveAccessibleDescription(TEXT.pickupReset);
  });

  it('押し直しの案内 (alert) と同時に出たときも、リンクの説明は受取時間の案内だけ (alert の文は混ざらない)', async () => {
    const gate = gatedFetches();
    vi.setSystemTime(SELECTABLE_UNTIL);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    fireEvent.click(payLink()!);
    passTime();
    // 待っている間は、案内もリンクも無い (押せないボタン)。
    expect(pickupReset()).toBeNull();
    expect(payLink()).toBeNull();
    expect(pickupSelect().hasAttribute('aria-describedby')).toBe(false);

    await gate.fail(0);

    // 2 つの案内とリンクが、同じ描き直しで出る。
    expect(notice()?.textContent).toBe(TEXT.retryNotice);
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(describedBy(payLink())).toBe(NOTICE_ID);
    expect(payLink()).toHaveAccessibleDescription(TEXT.pickupReset);
    expect(payLink()).toHaveAccessibleName(TEXT.pay);
    expect(pickupSelect()).toHaveAccessibleDescription(TEXT.pickupReset);
  });

  // 下で渡す props の組み合わせ (案内の文があり、候補が 0 件、または受取時間の欄を出さないのに、押せるリンクが出ている) は、
  // このテスト file の MobileOrderView の描き方からは作っていない (候補が 0 件なら支払い欄ごと消える)。
  // 部品の約束として、props を直接渡して確かめる: 描かない案内を、リンクは指さない。
  it('案内の文が渡っても、案内を描かないとき (候補が 0 件・受取時間の欄を出さない) は、リンクに aria-describedby の属性が無い', () => {
    const bar = (pickup: { show: boolean; slots: number[] }) => (
      <MobileOrderCartBar
        tooMany={false}
        tableNumber=""
        onTableNumberChange={() => {}}
        needsTable={false}
        pickup={{ ...pickup, value: null, onChange: () => {}, notice: TEXT.pickupReset }}
        cart={{
          open: false,
          onToggle: () => {},
          lines: [],
          decimals: JPYC_DECIMALS,
          count: 1,
          totalHuman: '500',
          subtotalHuman: '500',
          discount: 0n,
          feeUpcharge: 0n,
          feeBps: 0,
          onItemQtyChange: () => {},
          onOptionQtyChange: () => {},
        }}
        checkoutUrl="https://test.local/checkout?to=x"
        checkoutPending={false}
      />
    );
    // 比べる元: 欄と候補があれば、案内が出て、リンクが指す。
    const view = renderWithIntl(bar({ show: true, slots: [tokyo(12, 45)] }));
    expect(pickupReset()?.id).toBe(NOTICE_ID);
    expect(describedBy(payLink())).toBe(NOTICE_ID);

    // 候補が 0 件: 欄の代わりに「本日受け取れる時間がありません」。案内は描かない。
    view.rerender(bar({ show: true, slots: [] }));
    expect(screen.getByText(jaMessages.MobileOrder.pickupNone)).toBeInTheDocument();
    expect(document.getElementById(NOTICE_ID)).toBeNull();
    expect(payLink()!.hasAttribute('aria-describedby')).toBe(false);

    // 受取時間の欄を出さない (候補はある)。
    view.rerender(bar({ show: false, slots: [tokyo(12, 45)] }));
    expect(screen.queryByLabelText(TEXT.pickup)).toBeNull();
    expect(document.getElementById(NOTICE_ID)).toBeNull();
    expect(payLink()!.hasAttribute('aria-describedby')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4c. 受付の期限が近い受取時間は、受取時間の欄で新しくは選べない (handle のあるページ・時間の flag ON)
//   - 枠の受付の期限 = 枠 − 準備の時間。期限まで 5 分を切った枠は、選んでいなければ欄の選択肢に出さない。
//   - 選んである枠は、本当の期限まで欄に残る (選んだまま進める。期限で、4b のとおり最短に戻して案内を出す)。
//   - 残る枠が無いとき (その日の最後の 1 枠の期限が近い) は、絞らない。
//   - handle の無いページ (受付の確認が無い) は、絞らない。
//   - 変わるのは欄の選択肢だけ。受付の判定 (支払い欄が出る / 止まった表示)・選んだ枠を外す時・案内・確認の本文・進む先は、
//     絞る前の候補で決まる。
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 受付の期限が近い受取時間は、新しくは選べない (時間の flag ON)', () => {
  beforeEach(() => {
    envHold.enablePreorderTime = true;
  });

  // 事前注文・準備 30 分。12:30 の枠の受付の期限は 12:00:00、その 5 分前は 11:55:00。
  const slotConfig: MobileOrderConfig = { ...config, mode: 'preorder', minLeadMinutes: 30 };
  const MARGIN_EDGE = tokyo(11, 55);
  const pickupSelect = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
  const pickupOption = (name: string) =>
    within(pickupSelect()).queryByRole<HTMLOptionElement>('option', { name });
  const choosePickup = (name: string) =>
    fireEvent.change(pickupSelect(), { target: { value: pickupOption(name)!.value } });
  /** 欄の選択肢の字 (上から)。 */
  const optionNames = (count?: number) =>
    within(pickupSelect())
      .getAllByRole('option')
      .map((option) => option.textContent)
      .slice(0, count);
  const passTime = (ms = 30_000) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const SLOT_BODY = { handle: HANDLE, merchant: RECEIVER, mode: 'preorder', pickupAt: tokyo(12, 30) };
  const ASAP_BODY = { handle: HANDLE, merchant: RECEIVER, mode: 'preorder' };
  // ブレンド 1 つを入れた、枠の無い (最短の) URL の query の全部。
  const ASAP_QUERY = {
    to: RECEIVER,
    token: 'jpyc',
    items: item('ブレンド', 1, '500', ':10:taxable_10:'),
    fee_kind: 'preorder',
    fee_payer: 'merchant',
    store_handle: HANDLE,
    store: 'テスト珈琲店',
  };

  it.each([
    { name: '期限の 5 分前より 1 ms 前', at: MARGIN_EDGE - 1, first: ['12:30', '12:45'], count: 48 },
    { name: '期限の 5 分前ちょうど', at: MARGIN_EDGE, first: ['12:30', '12:45'], count: 48 },
    { name: '期限の 5 分前から 1 ms 後', at: MARGIN_EDGE + 1, first: ['12:45', '13:00'], count: 47 },
    { name: '期限ちょうど', at: TOKYO_NOON, first: ['12:45', '13:00'], count: 47 },
  ])('$name に開く: 欄の先頭は $first (隠れるのは先頭の 1 枠だけ)', ({ at, first, count }) => {
    vi.setSystemTime(at);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');

    expect(optionNames(3)).toEqual([TEXT.pickupAsap, ...first]);
    expect(optionNames()).toHaveLength(1 + count);
    // 欄の選択は最短のまま。案内は出ない。支払い欄は出ている。
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
    expect(readCheckoutUrl(payHref()).query).toEqual(ASAP_QUERY);
  });

  it('開いたまま時間が進むと、期限の 5 分前を過ぎた次の取り直しで、選んでいない先頭の枠が欄から消える (選択は最短のまま・案内は出ない・支払い欄は残る)', () => {
    vi.setSystemTime(tokyo(11, 54, 30));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:30']);

    // 11:55:00 ちょうどの取り直しでは、まだ出ている。
    passTime();
    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:30']);

    // 11:55:30 の取り直しで消える。
    passTime();

    expect(optionNames(3)).toEqual([TEXT.pickupAsap, '12:45', '13:00']);
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
    expect(notice()).toBeNull();
    expect(readCheckoutUrl(payHref()).query).toEqual(ASAP_QUERY);

    // 本当の期限 (12:00:00) を過ぎても、選んでいなかった枠の案内は出ない。
    passTime(5 * 60_000);
    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:45']);
    expect(pickupReset()).toBeNull();
  });

  it('選んである枠は、期限まで 5 分を切っても欄に残り、選んだままで押すと、その枠の本文と URL で進む', async () => {
    vi.setSystemTime(MARGIN_EDGE);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');

    // 11:56:00 (期限まで 4 分)。
    passTime(60_000);

    expect(optionNames(3)).toEqual([TEXT.pickupAsap, '12:30', '12:45']);
    expect(pickupSelect().value).toBe(String(tokyo(12, 30)));
    expect(pickupReset()).toBeNull();
    const href = payHref();
    expect(readCheckoutUrl(href).query).toEqual({ ...ASAP_QUERY, pickup_at: String(tokyo(12, 30)) });

    const pressed = await pressPay();

    expect(pressed.defaultPrevented).toBe(true);
    expect(postedBodies()).toEqual([SLOT_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(screen.queryByText(TEXT.closed)).toBeNull();
  });

  it('選んである枠は、本当の期限 (12:00:00) までは選んだまま。期限を過ぎた次の取り直しで、最短に戻して案内を出す', async () => {
    vi.setSystemTime(MARGIN_EDGE);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');

    untilNoon();

    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:30']);
    expect(pickupSelect().value).toBe(String(tokyo(12, 30)));
    expect(pickupReset()).toBeNull();

    passTime();

    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:45']);
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    const href = payHref();
    expect(readCheckoutUrl(href).query).toEqual(ASAP_QUERY);

    await pressPay();

    expect(postedBodies()).toEqual([ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  it.each(['12:45', TEXT.pickupAsap])('期限まで 5 分を切った枠から「%s」に選び直すと、元の枠は欄から消える (もう一度は選べない)', (next) => {
    vi.setSystemTime(MARGIN_EDGE);
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    passTime(60_000);
    expect(pickupOption('12:30')).not.toBeNull();

    choosePickup(next);

    expect(pickupOption('12:30')).toBeNull();
    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:45']);
    expect(pickupSelect().value).toBe(next === '12:45' ? String(tokyo(12, 45)) : '');
    // 自分で選び直したので、「最短に戻しました」は出ない。
    expect(pickupReset()).toBeNull();
  });

  it('隠れた枠は欄の選択肢に無く、選べない。「最短（指定なし）」のまま押すと、枠の無い本文と URL で進む', async () => {
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');

    expect(pickupOption('12:30')).toBeNull();
    // 選択肢に無い値を送っても、選択は最短のまま。
    fireEvent.change(pickupSelect(), { target: { value: String(tokyo(12, 30)) } });
    expect(pickupSelect().value).toBe('');
    const href = payHref();
    expect(readCheckoutUrl(href).query).toEqual(ASAP_QUERY);

    const pressed = await pressPay();

    expect(pressed.defaultPrevented).toBe(true);
    expect(postedBodies()).toEqual([ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
    expect(screen.queryByText(TEXT.closed)).toBeNull();
  });

  it('先頭の枠が隠れている間も、次の枠は選べて、その枠の本文と URL で進む', async () => {
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');

    choosePickup('12:45');

    const href = payHref();
    expect(readCheckoutUrl(href).query).toEqual({ ...ASAP_QUERY, pickup_at: String(tokyo(12, 45)) });
    await pressPay();
    expect(postedBodies()).toEqual([{ ...ASAP_BODY, pickupAt: tokyo(12, 45) }]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // その日の最後の 1 枠を隠しても、代わりの「最短（指定なし）」も同じ時刻に受付が終わる。隠さない。
  it('その日の最後の 1 枠だけが残っているときは、期限まで 5 分を切っても隠さない: 選べて、その枠で進む', async () => {
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(<MobileOrderView config={{ ...slotConfig, lastOrder: '12:30' }} handle={HANDLE} />);
    add('ブレンド');

    expect(optionNames()).toEqual([TEXT.pickupAsap, '12:30']);
    expect(screen.queryByText(jaMessages.MobileOrder.pickupNone)).toBeNull();

    choosePickup('12:30');
    const href = payHref();
    expect(readCheckoutUrl(href).query.pickup_at).toBe(String(tokyo(12, 30)));
    await pressPay();
    expect(postedBodies()).toEqual([SLOT_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  it('枠が 2 つ残っているときは、期限の近い先頭の 1 枠だけ隠す', () => {
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(<MobileOrderView config={{ ...slotConfig, lastOrder: '12:45' }} handle={HANDLE} />);
    add('ブレンド');

    expect(optionNames()).toEqual([TEXT.pickupAsap, '12:45']);
  });

  it('候補が 1 つも無いときは、今までどおり止まった表示 (受取時間の欄も支払い欄も出ない)', () => {
    vi.setSystemTime(tokyo(11, 56));
    // 最短の受け取り (12:30) がラストオーダー 12:15 を越える。
    renderWithIntl(<MobileOrderView config={{ ...slotConfig, lastOrder: '12:15' }} handle={HANDLE} />);
    add('ブレンド');

    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(screen.queryByLabelText(TEXT.pickup)).toBeNull();
    expect(cartToggle()).toBeNull();
    expect(payLink()).toBeNull();
  });

  // 受付の確認が無いページ (?s= の注文ページ・ビルダーのプレビュー) は、期限で支払えなくなることが無いので、絞らない。
  it('handle の無いページでは絞らない: 期限まで 5 分を切った先頭の枠も欄に出て、選べる', async () => {
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(<MobileOrderView config={slotConfig} />);
    add('ブレンド');

    expect(optionNames(3)).toEqual([TEXT.pickupAsap, '12:30', '12:45']);
    expect(optionNames()).toHaveLength(1 + 48);

    choosePickup('12:30');

    const { store_handle: _storeHandle, ...withoutHandle } = ASAP_QUERY;
    expect(readCheckoutUrl(payHref()).query).toEqual({
      ...withoutHandle,
      pickup_at: String(tokyo(12, 30)),
    });
    const pressed = await pressPay();
    expect(pressed.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('時間の flag OFF の handle のページは今までどおり: 受取時間の欄は無く、link のまま移る', async () => {
    envHold.enablePreorderTime = false;
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');

    expect(screen.queryByLabelText(TEXT.pickup)).toBeNull();
    expect(readCheckoutUrl(payHref()).query).toEqual(ASAP_QUERY);
    const pressed = await pressPay();
    expect(pressed.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('店頭の注文 (事前注文でない) の handle のページは今までどおり: 受取時間の欄は無く、枠の無い本文で確かめて進む', async () => {
    vi.setSystemTime(tokyo(11, 56));
    renderWithIntl(
      <MobileOrderView config={{ ...slotConfig, mode: 'storefront' }} handle={HANDLE} />,
    );
    add('ブレンド');

    expect(screen.queryByLabelText(TEXT.pickup)).toBeNull();
    const href = payHref();
    expect(readCheckoutUrl(href).query).toEqual({
      to: RECEIVER,
      token: 'jpyc',
      items: item('ブレンド', 1, '500', ':10:taxable_10:'),
      fee_kind: 'storefront',
      store_handle: HANDLE,
      store: 'テスト珈琲店',
    });
    await pressPay();
    expect(postedBodies()).toEqual([{ handle: HANDLE, merchant: RECEIVER, mode: 'storefront' }]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // 受付の判定は、絞る前の候補で決まる: 欄から枠が隠れている時刻でも、「最短（指定なし）」の注文は、最後の枠の期限まで進める。
  // 最後の枠は 12:30 (ラストオーダー 12:30・準備 30 分) で、その期限は 12:00:00。ラストオーダーの無い店は、いつでも進める。
  it.each([
    { name: 'ラストオーダー 12:30・11:54:00', lastOrder: '12:30', at: tokyo(11, 54), accepting: true },
    { name: 'ラストオーダー 12:30・11:55:00 の 1 ms 後', lastOrder: '12:30', at: MARGIN_EDGE + 1, accepting: true },
    { name: 'ラストオーダー 12:30・11:59:59', lastOrder: '12:30', at: tokyo(11, 59, 59), accepting: true },
    { name: 'ラストオーダー 12:30・12:00:00 (最後の枠の期限ちょうど)', lastOrder: '12:30', at: TOKYO_NOON, accepting: true },
    { name: 'ラストオーダー 12:30・12:00:00 の 1 ms 後', lastOrder: '12:30', at: TOKYO_NOON + 1, accepting: false },
    { name: 'ラストオーダー 12:45・11:56:00 (先頭の枠が隠れている)', lastOrder: '12:45', at: tokyo(11, 56), accepting: true },
    { name: 'ラストオーダーなし・11:56:00 (先頭の枠が隠れている)', lastOrder: undefined, at: tokyo(11, 56), accepting: true },
    { name: 'ラストオーダーなし・12:00:00 の 1 ms 後', lastOrder: undefined, at: TOKYO_NOON + 1, accepting: true },
  ])('受付の判定は今までどおり ($name): 最短のままの注文は $accepting', async ({ lastOrder, at, accepting }) => {
    vi.setSystemTime(at);
    renderWithIntl(<MobileOrderView config={{ ...slotConfig, lastOrder }} handle={HANDLE} />);
    add('ブレンド');

    if (!accepting) {
      expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
      expect(cartToggle()).toBeNull();
      expect(payLink()).toBeNull();
      return;
    }
    expect(screen.queryByText(TEXT.closed)).toBeNull();
    expect(pickupSelect().value).toBe('');
    const href = payHref();
    expect(readCheckoutUrl(href).query).toEqual(ASAP_QUERY);
    await pressPay();
    expect(postedBodies()).toEqual([ASAP_BODY]);
    expect(assignSpy.mock.calls).toEqual([[href]]);
  });

  // 「最短に戻しました」の案内を出す条件は、絞る前の候補 (外した枠が候補に無い間だけ出す = 4b の最後の行と同じ)。
  // 設定が戻って、外した枠が候補に戻ると、案内は消える。その枠の期限が近ければ、欄には出ない (今の動き)。
  it('案内を出す条件は、絞る前の候補で決まる: 外した枠が候補に戻ると、欄に出ていなくても案内は消える。また候補から外れると出る (今の動き)', () => {
    vi.setSystemTime(MARGIN_EDGE);
    const view = renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    choosePickup('12:30');
    untilNoon();
    view.rerender(<MobileOrderView config={{ ...slotConfig, minLeadMinutes: 60 }} handle={HANDLE} />);
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);

    view.rerender(<MobileOrderView config={slotConfig} handle={HANDLE} />);

    expect(pickupOption('12:30')).toBeNull();
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();

    passTime();

    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4d. 受取時間の欄に出す枠を決める計算 (pickupSelectSlots)。候補は、画面と同じ pickupSlots で作る。
// ---------------------------------------------------------------------------------------------------------------------
describe('pickupSelectSlots — 受取時間の欄に出す枠', () => {
  const MIN = 60_000;

  it('期限 (枠 − 準備の時間) の 5 分前ちょうどまでは先頭の枠を出し、1 ms 過ぎると外す', () => {
    const candidates = pickupSlots(tokyo(11, 55), 30);
    expect(candidates[0]).toBe(tokyo(12, 30));
    expect(pickupSelectSlots(candidates, null, tokyo(11, 55), 30)).toEqual(candidates);
    expect(pickupSelectSlots(candidates, null, tokyo(11, 55) + 1, 30)).toEqual(candidates.slice(1));
    expect(pickupSelectSlots(candidates, null, TOKYO_NOON, 30)).toEqual(candidates.slice(1));
  });

  it.each([undefined, 0, 1, 7, 30, 44, 45, 90, 30.9, -5, Number.NaN])('準備 %s 分: どの時刻でも、出す枠は「期限まで 5 分以上」の枠で、外すのは先頭の 1 枠まで', (lead) => {
    // 候補を作る側 (earliestPickup) と同じ読み方: 整数に切り捨て・正の数でなければ 0。
    const leadMs =
      typeof lead === 'number' && Number.isFinite(lead) && lead > 0 ? Math.floor(lead) * MIN : 0;
    // 12:00:00 から 20 秒ごとに 30 分ぶん + 境目の前後 1 ms。
    const times = Array.from({ length: 90 }, (_, i) => TOKYO_NOON + i * 20_000).flatMap((time) => [
      time - 1,
      time,
      time + 1,
    ]);
    for (const now of times) {
      const candidates = pickupSlots(now, lead);
      const shown = pickupSelectSlots(candidates, null, now, lead);
      const expected = candidates.filter((ms) => ms - leadMs - now >= 5 * MIN);
      expect(shown).toEqual(expected);
      expect(candidates.length - shown.length).toBeLessThanOrEqual(1);
    }
  });

  it('選んである枠は、期限まで 5 分を切っても外さない。ほかの枠を選んでいるときは外す', () => {
    const now = tokyo(11, 58);
    const candidates = pickupSlots(now, 30);
    expect(pickupSelectSlots(candidates, tokyo(12, 30), now, 30)).toEqual(candidates);
    expect(pickupSelectSlots(candidates, tokyo(12, 45), now, 30)).toEqual(candidates.slice(1));
  });

  it('候補に無い枠を選んでいても、足さない', () => {
    const now = tokyo(11, 58);
    const candidates = pickupSlots(now, 30);
    expect(pickupSelectSlots(candidates, tokyo(12, 15), now, 30)).toEqual(candidates.slice(1));
  });

  it('残る枠が無いとき (最後の 1 枠の期限が近い) は、絞らない。2 枠あれば先頭だけ外す。候補が空なら空', () => {
    const now = tokyo(11, 58);
    expect(pickupSelectSlots(pickupSlots(now, 30, '12:30'), null, now, 30)).toEqual([tokyo(12, 30)]);
    expect(pickupSelectSlots(pickupSlots(now, 30, '12:45'), null, now, 30)).toEqual([tokyo(12, 45)]);
    expect(pickupSlots(now, 30, '12:15')).toEqual([]);
    expect(pickupSelectSlots([], null, now, 30)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4e. 画面に戻ってきた時 (裏のタブ・別のアプリ・「戻る」での復元) に、30 秒の取り直しを待たずに時刻を取り直す
//   - 30 秒の timer が後でやることを早めるだけ。timer は増やさない。
//   - 登録するのは時間の flag ON の間だけ。画面を閉じると外す。
// ---------------------------------------------------------------------------------------------------------------------
describe('MobileOrderView — 画面に戻ってきた時に、時刻を取り直す (時間の flag ON)', () => {
  beforeEach(() => {
    envHold.enablePreorderTime = true;
  });
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  const slotConfig: MobileOrderConfig = { ...config, mode: 'preorder', minLeadMinutes: 30 };
  const pickupSelect = () => screen.getByLabelText(TEXT.pickup) as HTMLSelectElement;
  const optionNames = (count: number) =>
    within(pickupSelect())
      .getAllByRole('option')
      .map((option) => option.textContent)
      .slice(0, count);
  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  /** 時計だけを進める (30 秒の timer は動かさない = 画面を離れていた間、取り直しが止まっていた)。 */
  const awayUntil = (time: number) => vi.setSystemTime(time);
  const comeBack = (how: 'visibilitychange' | 'pageshow') =>
    act(() => {
      if (how === 'pageshow') window.dispatchEvent(new Event('pageshow'));
      else {
        setVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });

  it.each(['visibilitychange', 'pageshow'] as const)('%s で戻ると、その場で時刻を取り直して、欄の候補が変わる (30 秒を待たない)', (how) => {
    // 11:54:45 に開く。12:30 の枠 (期限 12:00:00) は、まだ選べる。
    vi.setSystemTime(tokyo(11, 54, 45));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:30']);

    // 画面を離れている間に 11:57:00 になった。取り直すまでは、欄は開いたときのまま。
    awayUntil(tokyo(11, 57));
    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:30']);

    comeBack(how);

    expect(optionNames(3)).toEqual([TEXT.pickupAsap, '12:45', '13:00']);
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()).toBeNull();
  });

  it('visibilitychange でも、画面が隠れた側 (hidden) では取り直さない。見える側に戻った所で取り直す', () => {
    vi.setSystemTime(tokyo(11, 54, 45));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');

    awayUntil(tokyo(11, 57));
    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:30']);

    comeBack('visibilitychange');

    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:45']);
  });

  it('選んである枠の期限を、画面を離れている間に過ぎていたら、戻った所で最短に戻して案内を出す (4b と同じ動きが早まるだけ)', () => {
    vi.setSystemTime(tokyo(11, 55));
    renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.change(pickupSelect(), { target: { value: String(tokyo(12, 30)) } });
    expect(pickupSelect().value).toBe(String(tokyo(12, 30)));

    awayUntil(tokyo(12, 3));
    comeBack('visibilitychange');

    expect(optionNames(2)).toEqual([TEXT.pickupAsap, '12:45']);
    expect(pickupSelect().value).toBe('');
    expect(pickupReset()?.textContent).toBe(TEXT.pickupReset);
    expect(readCheckoutUrl(payHref()).query.pickup_at).toBeUndefined();
  });

  it('ラストオーダーの停止の表示も、戻った所で出る (handle の無い店頭のページでも)', () => {
    vi.setSystemTime(tokyo(12, 9, 50));
    renderWithIntl(<MobileOrderView config={{ ...config, lastOrder: '12:10' }} />);
    add('ブレンド');
    expect(payLink()).not.toBeNull();

    awayUntil(tokyo(12, 10, 5));
    expect(payLink()).not.toBeNull();
    comeBack('pageshow');

    expect(screen.getByText(TEXT.pastLastOrder)).toBeInTheDocument();
    expect(payLink()).toBeNull();
  });

  it('listener は時間の flag ON の間だけ 1 つずつ登録し、画面を閉じると同じものを外す。戻ってきても 30 秒の timer は 1 本のまま', () => {
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const ofType = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter(([eventType]) => eventType === type);

    envHold.enablePreorderTime = false;
    const off = renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    expect(ofType(documentAdd, 'visibilitychange')).toEqual([]);
    expect(ofType(windowAdd, 'pageshow')).toEqual([]);
    const withoutClock = vi.getTimerCount();
    off.unmount();
    expect(vi.getTimerCount()).toBe(0);

    envHold.enablePreorderTime = true;
    const on = renderWithIntl(<MobileOrderView config={slotConfig} handle={HANDLE} />);
    const visibility = ofType(documentAdd, 'visibilitychange');
    const pageShow = ofType(windowAdd, 'pageshow');
    expect(visibility).toHaveLength(1);
    expect(pageShow).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(withoutClock + 1);

    comeBack('visibilitychange');
    comeBack('pageshow');
    expect(vi.getTimerCount()).toBe(withoutClock + 1);
    expect(ofType(documentRemove, 'visibilitychange')).toEqual([]);
    expect(ofType(windowRemove, 'pageshow')).toEqual([]);

    on.unmount();

    expect(ofType(documentRemove, 'visibilitychange')).toEqual([visibility[0]]);
    expect(ofType(windowRemove, 'pageshow')).toEqual([pageShow[0]]);
    expect(vi.getTimerCount()).toBe(0);
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
