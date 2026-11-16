// 受注の画面 (OrderFeedPanel = SIWE でサインインした店主) が、届いた注文をこの端末の取引履歴に書く。
//   - 書くのは OrderFeedPanel だけ。閲覧トークンの画面 (受注ボード・呼び出しモニター) は書かない。
//   - 書き込み・receipt の読み取りがどう失敗しても、受注の画面 (表示・操作・polling) は変わらない。
// 画面・hook・書き手・履歴 (localStorage) は実物。差し替えるのは fetch と receipt の読み取りだけ。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { recoverReceipt } from '../_helpers/orderSaleReceipt';

const ADDR: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const FORWARDER: Address = '0x1111111111111111111111111111111111111111';

const h = vi.hoisted(() => ({
  isSignedIn: true,
  orders: [] as unknown[],
  token: null as string | null,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    sessionAddress: h.isSignedIn ? '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    mismatch: false,
    isLoading: false,
  }),
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
const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orderFeedReceipt', () => ({ ORDER_RECEIPT_TIMEOUT_MS: 6_000, readOrderReceipt: read }));
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
import { loadHistory } from '@/lib/history';
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

const okReceipt = () =>
  recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant: ADDR,
    merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 10n * ONE,
  });

const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
const feedGets: Record<string, string>[] = [];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  h.isSignedIn = true;
  h.orders = [];
  h.token = null;
  envHold.enableOrderRelay = true;
  envHold.enableOrderToken = false;
  historyHold.failAppend = false;
  historyHold.appends = 0;
  read.mockReset();
  read.mockImplementation(async () => okReceipt());
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
  return renderWithIntl(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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
    h.isSignedIn = false;
    const first = renderPanel();
    await settle();
    first.unmount();
    h.isSignedIn = true;
    envHold.enableOrderRelay = false;
    renderPanel();
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(loadHistory()).toHaveLength(0);
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
    h.isSignedIn = false;
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
