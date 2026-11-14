// モバイル注文の画面 (MobileOrderView) の、注文を送る流れ・時間の経過・カートの境目を、今の動きのまま固定する。
//
// 見るのは画面 (role と name)・「支払いへ進む」の行き先の URL・受付の確認 (POST /api/order/admission) の本文・
// window.location.assign・localStorage だけで、部品の中の state や関数の名前には触れない。
// mock は境界 (env の flag・origin・fetch・window.location・乱数・時計) だけに置く。作りは MobileOrderView.test.tsx と同じ。
//
// 行き先の URL は「origin と path」と「query の全部の key と値」を比べる (key の並びには依らない)。
// 題に「(今の動き)」と付けた行は、こうあるべきという主張ではなく、今こう動いているという記録。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
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
import { calcCheckoutPayable, parseCheckoutParams } from '@/lib/url';
import type { MobileOrderConfig } from '@/lib/mobileOrder';
import type { ShopLiveState } from '@/lib/shopLive';

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

const payLink = () => screen.queryByRole('link', { name: TEXT.pay });
const payButton = () => screen.queryByRole('button', { name: TEXT.pay });
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

  it('fetch が例外で落ちたら移らない。受付停止の案内が出て支払い欄が消え、数量を変えても戻らない。開き直すと戻る (今の動き)', async () => {
    const gate = gatedFetch();
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');
    fireEvent.click(payLink()!);

    await gate.fail();

    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(payButton()).toBeNull();
    expect(cartToggle()).toBeNull();
    // 通信の失敗でも「受け付けていません」のまま。もう一度押す場所は無く、品を足しても・時間が進んでも戻らない。
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

  it.each([429, 503])('応答が %i でも 409 と同じ扱い: 移らず、受付停止の案内が出て支払い欄が消える (今の動き)', async (status) => {
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ ok: false, error: 'x' }), { status }),
    );
    renderWithIntl(<MobileOrderView config={config} handle={HANDLE} />);
    add('ブレンド');

    await pressPay();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.closed)).toBeInTheDocument();
    expect(payLink()).toBeNull();
    expect(cartToggle()).toBeNull();
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

  // ここで見るのは保存の中身だけ。保存に残った品が実際に「前回と同じ注文」でカートへ戻るのは、その注文が
  // 支払い済みと判定され、次に開いたときに売り切れが解除されている場合 (復元のときにも売り切れは除く)。
  it('売り切れで URL から落ちた品も、「前回の注文」の保存には数量ごと残る (今の動き・支払い済みと判定され、次回に売り切れが解除されていれば、前回と同じ注文に入る)', async () => {
    const view = renderWithIntl(<MobileOrderView config={config} handle={HANDLE} live={live([])} />);
    add('ブレンド', 2);
    add('水');
    view.rerender(<MobileOrderView config={config} handle={HANDLE} live={live(['a'], 2)} />);
    expect(readCheckoutUrl(payHref()).query.items).toBe(item('水', 1, '100', ':8:taxable_8:'));

    await pressPay();

    expect(
      JSON.parse(window.localStorage.getItem(`openpay:last-order:v1:h:${HANDLE}`) ?? 'null').cart,
    ).toEqual([
      { id: 'a', qty: 2 },
      { id: 'c', qty: 1 },
    ]);
  });
});
