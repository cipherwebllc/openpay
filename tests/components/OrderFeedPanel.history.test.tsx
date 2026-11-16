// 受注の画面 (OrderFeedPanel = SIWE でサインインした店主) が、届いた注文をこの端末の取引履歴に書く。
//   - 書くのは OrderFeedPanel だけ。閲覧トークンの画面 (受注ボード・呼び出しモニター) は書かない。
//   - 書くのは、receipt に session の受取先への入金がある注文だけ (別のタブで別の店主にサインインした後・ウォレットの切り替え)。
//   - 書いた行を消しても、開き直した画面は書き戻さない。2 つのタブが同じ注文を待っても 1 行。
//   - 書き込み・receipt の読み取りがどう失敗しても、受注の画面 (表示・操作・polling) は変わらない。
// 画面・hook・書き手・履歴 (localStorage) は実物。差し替えるのは fetch・receipt の読み取り・ウォレットと SIWE の session だけ。

import { cloneElement } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { recoverReceipt } from '../_helpers/orderSaleReceipt';

const ADDR: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER_SHOP: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const FORWARDER: Address = '0x1111111111111111111111111111111111111111';

// wallet = 接続中のウォレット・session = この画面が持つ SIWE の session のアドレス (/api/auth/me の結果)。
// 実物の useSiweSession と同じく、両方が同じときだけサインイン済み・違えば mismatch (session のアドレスは残る)。
const h = vi.hoisted(() => ({
  wallet: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as string | null,
  session: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as string | null,
  orders: [] as unknown[],
  token: null as string | null,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.wallet !== null, address: h.wallet ?? undefined }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => {
    const same = !!h.session && !!h.wallet && h.session.toLowerCase() === h.wallet.toLowerCase();
    return {
      isSignedIn: same,
      sessionAddress: h.session,
      signIn: vi.fn(),
      isSigningIn: false,
      signInError: null,
      signOut: vi.fn(),
      mismatch: !!h.session && !!h.wallet && !same,
      isLoading: false,
    };
  },
}));
const envHold = vi.hoisted(() => ({ enableOrderRelay: true, enableOrderToken: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableMobileOrderFee: true,
      enableOrderFulfillment: false,
      enableShopLive: false,
      enableHandles: false,
      enableOrderCall: false,
      get enableOrderRelay() {
        return envHold.enableOrderRelay;
      },
      get enableOrderToken() {
        return envHold.enableOrderToken;
      },
    },
  };
});
vi.mock('@/lib/orderTokenClient', () => ({
  getStoredOrderToken: () => h.token,
  setStoredOrderToken: (t: string) => {
    h.token = t;
  },
  clearStoredOrderToken: () => {
    h.token = null;
  },
}));
vi.mock('@/lib/successChime', () => ({ playNewOrderChime: vi.fn(), primeChimeAudio: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, configuredJpycForwarderFor: vi.fn(() => '0x1111111111111111111111111111111111111111') };
});
// receipt の読み取りだけを差し替える (既定の「読めない」スタブ = tests/setup.ts を、この file では読める形に)。
// 待ち時間は 0 (書き手の待ち時間 = 0 + 1 秒): 遅れて返る receipt を、実時間 1 秒で確かめる。
const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orderFeedReceipt', () => ({ ORDER_RECEIPT_TIMEOUT_MS: 0, readOrderReceipt: read }));
// 履歴は実物。保存の失敗を差し込めるようにだけする。
const historyHold = vi.hoisted(() => ({ failAppend: false, appends: 0 }));
vi.mock('@/lib/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/history')>();
  return {
    ...actual,
    appendHistory: (entry: Parameters<typeof actual.appendHistory>[0]) => {
      historyHold.appends += 1;
      if (historyHold.failAppend) throw new Error('storage_broken');
      actual.appendHistory(entry);
    },
  };
});

import { OrderFeedPanel } from '@/components/OrderFeedPanel';
import { OrderFulfillmentBoard } from '@/components/OrderFulfillmentBoard';
import { OrderPickupMonitor } from '@/components/OrderPickupMonitor';
import { env } from '@/lib/env';
import { loadHistory, removeHistoryEntry } from '@/lib/history';
import { deploymentForSlug } from '@/lib/tokens';

const JPYC = deploymentForSlug('jpyc', 'polygon');
const ONE = 10n ** 18n;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const T0 = Date.now();

function order(n: number, over: Record<string, unknown> = {}) {
  return {
    orderId: `N${n}`,
    items: [{ name: '水', qty: 2, price: '500' }],
    table: 'テーブル 3',
    amount: (990n * ONE).toString(),
    txHash: tx(n),
    chainId: JPYC.chainId,
    from: ADDR,
    ts: T0 - (10 - n) * 1_000, // 番号が大きいほど新しい・どれも 1 分以内 (経過の表示が出ない)
    fulfilled: false,
    ...over,
  };
}

/** この tx の receipt (お客様 → forwarder → 受取先・利用料 10)。受取先は既定でこの店 (ADDR)。 */
const okReceipt = (hash: string, merchant: Address = ADDR) =>
  recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant,
    merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 10n * ONE, txHash: hash,
  });
/** tx ごとの受取先 (書いていない tx はこの店)。 */
const payee = new Map<string, Address>();

const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
const feedGets: Record<string, string>[] = [];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  h.wallet = ADDR;
  h.session = ADDR;
  h.orders = [];
  h.token = null;
  envHold.enableOrderRelay = true;
  envHold.enableOrderToken = false;
  historyHold.failAppend = false;
  historyHold.appends = 0;
  read.mockReset();
  payee.clear();
  read.mockImplementation(async (_chainId: number, hash: string) => okReceipt(hash, payee.get(hash) ?? ADDR));
  posts.length = 0;
  feedGets.length = 0;
  global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: u, body: String(init.body), headers: init.headers ?? {} });
      return jsonRes({ ok: true });
    }
    if (u.includes('/api/order/calls')) return jsonRes({ ok: true, calls: [] });
    if (u.includes('/api/order/feed')) {
      feedGets.push(init?.headers ?? {});
      return jsonRes({ ok: true, orders: h.orders });
    }
    return jsonRes({ ok: true });
  }) as unknown as typeof fetch;
});

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderWithIntl(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  // 同じ QueryClient のまま描き直す (session・ウォレットの切り替え)。同じ element のままだと React が描き直さないので複製する。
  const redraw = () => view.rerender(<QueryClientProvider client={qc}>{cloneElement(ui)}</QueryClientProvider>);
  return { ...view, redraw };
}
const renderPanel = () => withQuery(<OrderFeedPanel />);

/** 書き手が動く時間を置く (dynamic import → 履歴の確認 → receipt の読み取り → 保存)。 */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('OrderFeedPanel — 届いた注文を取引履歴に書く', () => {
  it('新しい注文で 1 行 (受取先 = サインインしたウォレット・お客様と利用料は receipt から)', async () => {
    h.orders = [order(1)];
    renderPanel();
    await screen.findByText('テーブル 3');
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    expect(loadHistory()[0]).toMatchObject({
      id: `batch-${tx(1)}`, flow: 'batch', status: 'success', merchant: ADDR, customer: CUSTOMER,
      merchantAmount: (990n * ONE).toString(), feeAmount: (10n * ONE).toString(), saleAmount: (1_000n * ONE).toString(),
      gasMode: 'merchant', receiptNo: 'N1', memo: 'テーブル 3', productName: '水',
    });
    // お客様は注文の from (未検証の申告 = ここでは店のアドレス) ではなく、Settled の from。
    expect(loadHistory()[0].customer).not.toBe(ADDR);
    expect(loadHistory()[0].lineItems).toEqual([expect.objectContaining({ name: '水', quantity: 2, unitPrice: '500', amount: '1000' })]);
  });

  it('次の polling でも 1 行のまま (receipt を読み直さない)。受注フィードを余計に取りに行かない', async () => {
    h.orders = [order(1)];
    renderPanel();
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    await settle();
    // 書き込みは、受注フィードの取得を増やさない (最初の 1 回だけ)。
    expect(feedGets).toHaveLength(1);
    for (let i = 2; i <= 3; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: '更新' }));
      await waitFor(() => expect(feedGets).toHaveLength(i));
      await settle();
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(historyHold.appends).toBe(1);
    expect(loadHistory()).toHaveLength(1);
  });

  it('receipt を読めなかった注文は、中身が同じ次の polling で読み直して書く', async () => {
    read.mockRejectedValueOnce(new Error('rpc down'));
    h.orders = [order(1)];
    renderPanel();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await settle();
    expect(loadHistory()).toHaveLength(0);
    // 受注フィードの中身は同じ (react-query は同じ配列を返し続ける)。取得の時刻だけが進む。
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    expect(read).toHaveBeenCalledTimes(2);
    expect(loadHistory()[0]).toMatchObject({ customer: CUSTOMER, feeAmount: (10n * ONE).toString() });
  });

  it('polling で新しい注文が届いたら、その 1 件だけを足す', async () => {
    h.orders = [order(1)];
    renderPanel();
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    h.orders = [order(2), order(1)];
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(loadHistory()).toHaveLength(2));
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2', 'N1']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('まとめて届いた注文は、件数ぶん 1 行ずつ・新しい注文が上 (対応済みの注文も売上)', async () => {
    h.orders = [order(5), order(4, { fulfilled: true }), order(3), order(2, { unboundPayment: true }), order(1)];
    renderPanel();
    await waitFor(() => expect(loadHistory()).toHaveLength(5));
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N5', 'N4', 'N3', 'N2', 'N1']);
    expect(loadHistory().map((e) => e.flow)).toEqual(['batch', 'batch', 'batch', 'standard-merchant', 'batch']);
  });

  it('txHash の無い注文は書かない (画面には出る)', async () => {
    h.orders = [order(1, { txHash: undefined }), order(2)];
    renderPanel();
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    await settle();
    expect(screen.getAllByText('テーブル 3')).toHaveLength(2);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('サインインしていない間・受注リレーが OFF の間は書かない', async () => {
    h.orders = [order(1)];
    h.session = null;
    const first = renderPanel();
    await settle();
    first.unmount();
    h.session = ADDR;
    envHold.enableOrderRelay = false;
    renderPanel();
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(loadHistory()).toHaveLength(0);
  });
});

/** 外から resolve する receipt (遅れて返る・2 つのタブが同時に待つ)。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('OrderFeedPanel — receipt に、この画面の session の受取先への入金がある注文だけを書く', () => {
  it('別のタブで別の店主にサインインした後 (この画面の session は前の店主・受注フィードは cookie の新しい店主の注文を返す): 1 行も書かない', async () => {
    // 受注フィードは cookie の session で決まる。この画面の session (ADDR) のまま、別の店 (OTHER_SHOP) の注文が届く。
    h.orders = [order(1)];
    payee.set(tx(1), OTHER_SHOP);
    renderPanel();
    await screen.findByText('テーブル 3');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await settle();
    expect(loadHistory()).toHaveLength(0);
    expect(historyHold.appends).toBe(0);
  });

  it('ウォレットを切り替えた: サインインし直すまでは何も足さず、し直したら新しい店主の注文を新しい店主の名義で書く', async () => {
    h.orders = [order(1)];
    const view = renderPanel();
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    expect(loadHistory()[0].merchant).toBe(ADDR);
    // ウォレットだけを切り替えた (session は前の店主のまま = mismatch)。受注フィードは止まる。
    h.wallet = OTHER_SHOP;
    h.orders = [order(2)];
    payee.set(tx(2), OTHER_SHOP);
    view.redraw();
    await settle();
    expect(loadHistory()).toHaveLength(1);
    // 新しいウォレットでサインインし直した。
    h.session = OTHER_SHOP;
    view.redraw();
    await waitFor(() => expect(loadHistory()).toHaveLength(2));
    expect(loadHistory().map((e) => [e.txHash, e.merchant])).toEqual([[tx(2), OTHER_SHOP], [tx(1), ADDR]]);
  });

  it('receipt が別の tx の receipt を返す: 書かない', async () => {
    read.mockImplementation(async () => okReceipt(tx(0x999)));
    h.orders = [order(1)];
    renderPanel();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await settle();
    expect(loadHistory()).toHaveLength(0);
  });

  it('receipt が読めないまま (この画面で 3 回): 書かない', async () => {
    read.mockRejectedValue(new Error('rpc down'));
    h.orders = [order(1)];
    renderPanel();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    for (let i = 2; i <= 4; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: '更新' }));
      await waitFor(() => expect(feedGets).toHaveLength(i));
      await settle();
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(loadHistory()).toHaveLength(0);
  });

  it('待ち時間の後に遅れて返った receipt では書かない。次の polling で読み直して 1 行', async () => {
    const late = deferred<ReturnType<typeof okReceipt>>();
    read.mockImplementationOnce(() => late.promise);
    h.orders = [order(1)];
    renderPanel();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // この file の待ち時間は 1 秒。過ぎてから返る。
    await new Promise((r) => setTimeout(r, 1_100));
    late.resolve(okReceipt(tx(1)));
    await settle();
    expect(loadHistory()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    expect(read).toHaveBeenCalledTimes(2);
    expect(historyHold.appends).toBe(1);
  });
});

describe('OrderFeedPanel — 消した行を書き戻さない・2 つのタブでも 1 行', () => {
  it('書いた行を履歴から消してから受注の画面を開き直しても、書き戻さない', async () => {
    h.orders = [order(2), order(1)];
    const first = renderPanel();
    await waitFor(() => expect(loadHistory()).toHaveLength(2));
    first.unmount();
    removeHistoryEntry(`batch-${tx(1)}`);
    read.mockClear();
    renderPanel();
    await screen.findAllByText('テーブル 3');
    await settle();
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(read).not.toHaveBeenCalled();
  });

  it('2 つのタブ (受注の画面 2 つ) が同じ注文の receipt を同時に待っても、1 行だけ', async () => {
    const pending = deferred<ReturnType<typeof okReceipt>>();
    read.mockImplementation(() => pending.promise);
    h.orders = [order(1)];
    renderPanel();
    renderPanel();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    pending.resolve(okReceipt(tx(1)));
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    await settle();
    expect(loadHistory()).toHaveLength(1);
    expect(historyHold.appends).toBe(1);
  });
});

describe('閲覧トークンの画面 (受注ボード・呼び出しモニター) では書かない', () => {
  const TOKEN = 'staff-token';
  const screens: [string, () => React.ReactElement][] = [
    ['厨房', () => <OrderFulfillmentBoard mode="kitchen" />],
    ['ホール', () => <OrderFulfillmentBoard mode="hall" />],
    ['呼び出しモニター', () => <OrderPickupMonitor />],
  ];

  it.each(screens)('%s: 閲覧トークンで受注を読んでも、履歴に書かず receipt も読まない', async (_name, ui) => {
    envHold.enableOrderToken = true;
    h.session = null;
    h.token = TOKEN;
    h.orders = [order(1, { ready: true }), order(2)];
    withQuery(ui());
    // 閲覧トークンで受注フィードを読めている。
    await waitFor(() => expect(feedGets.some((headers) => headers['x-order-token'] === TOKEN)).toBe(true));
    await waitFor(() => expect(screen.getAllByText(/N1/).length).toBeGreaterThan(0));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(historyHold.appends).toBe(0);
    expect(loadHistory()).toHaveLength(0);
  });

  it.each(screens)('%s: SIWE でサインインした店主がこの画面を開いても書かない (書くのは受注の画面だけ)', async (_name, ui) => {
    h.orders = [order(1, { ready: true }), order(2)];
    withQuery(ui());
    await waitFor(() => expect(feedGets).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText(/N1/).length).toBeGreaterThan(0));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(loadHistory()).toHaveLength(0);
  });

  it('書き手を使うのは components/OrderFeedPanel.tsx だけ (共有の hook・ほかの画面は import しない)', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ['app', 'components', 'hooks', 'lib']) walk(join(root, dir));
    // import の指定 (静的な from・dynamic import) だけを数える (コメントの中の名前は数えない)。
    const importers = (module: string) => {
      const spec = new RegExp(`['"](?:@/(?:hooks|lib)/|\\./)${module}['"]`);
      return files.filter((f) => spec.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f)).sort();
    };
    expect(importers('useOrderFeedHistory')).toEqual(['components/OrderFeedPanel.tsx']);
    expect(importers('orderFeedHistoryRecorder')).toEqual(['hooks/useOrderFeedHistory.ts']);
    expect(importers('orderFeedReceipt')).toEqual(['lib/orderFeedHistoryRecorder.ts']);
  });
});

describe('OrderFeedPanel — 書き込みがどう失敗しても、受注の画面は変わらない', () => {
  /** 受注の画面を出し、書き手が動いた後の DOM と、「対応済みにする」の POST を返す。 */
  async function runPanel(wait: () => Promise<void>) {
    h.orders = [order(2), order(1, { fulfilled: true })];
    const view = renderPanel();
    await screen.findByRole('button', { name: '対応済みにする' });
    await wait();
    await settle();
    const html = view.container.innerHTML;
    fireEvent.click(screen.getByRole('button', { name: '対応済みにする' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(feedGets.length).toBeGreaterThanOrEqual(2));
    const result = { html, post: JSON.parse(posts[0].body) as { txHash: string; fulfilled: boolean }, feedGets: feedGets.length };
    view.unmount();
    posts.length = 0;
    feedGets.length = 0;
    window.localStorage.clear();
    return result;
  }

  async function baseline() {
    const result = await runPanel(async () => {
      await waitFor(() => expect(loadHistory()).toHaveLength(2));
    });
    expect(result.post).toEqual({ txHash: tx(2), fulfilled: true });
    read.mockClear();
    historyHold.appends = 0;
    return result;
  }

  it('receipt の読み取りが throw する (RPC の障害)', async () => {
    const ok = await baseline();
    read.mockRejectedValue(new Error('rpc down'));
    const failed = await runPanel(async () => {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    });
    expect(failed).toEqual(ok);
    // 1 回目に読めなかった注文は、まだ書かない (次の polling でもう一度読む)。
    expect(historyHold.appends).toBe(0);
  });

  it('receipt の読み取りが返らない (RPC が応答しない)', async () => {
    const ok = await baseline();
    read.mockImplementation(() => new Promise(() => {}));
    const failed = await runPanel(async () => {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    });
    expect(failed).toEqual(ok);
  });

  it('receipt が読めない形 (log が壊れている・Settled が無い)', async () => {
    const ok = await baseline();
    read.mockImplementation(async () => ({ status: 'success', blockNumber: 1n, logs: [{ address: 'x', topics: [], data: '0x' }] }));
    const failed = await runPanel(async () => {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    });
    expect(failed).toEqual(ok);
  });

  it('履歴の保存が throw する', async () => {
    const ok = await baseline();
    historyHold.failAppend = true;
    const failed = await runPanel(async () => {
      await waitFor(() => expect(historyHold.appends).toBe(2));
    });
    expect(failed).toEqual(ok);
    expect(loadHistory()).toHaveLength(0);
  });

  it('履歴の localStorage が読めない・書けない (保存領域の障害)', async () => {
    const ok = await baseline();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      const failed = await runPanel(async () => {
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      });
      expect(failed).toEqual(ok);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
