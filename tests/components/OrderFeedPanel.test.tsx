// OrderFeedPanel を実描画で検証: 未サインイン=サインイン導線 / サインイン後=受注描画 (テーブル/
// 明細/実着金額) / 空 / KV エラー / 「対応済み」で POST。useSiweSession と fetch をモック・QueryClient 注入。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({
  isSignedIn: true,
  feedOk: true,
  orders: [] as unknown[],
  feedStatus: 200,
  handles: [] as unknown[], // GET /api/handle (営業中の操作 用所有 handle)
  calls: [] as unknown[],
  isConnected: true,
}));

// サインインの入口 (SignInGate) は接続状態で出し分ける: 未接続 = 接続ボタン / 接続済み = サインインボタン。
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected, address: h.isConnected ? ADDR : undefined }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    sessionAddress: h.isSignedIn ? ADDR : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    mismatch: false,
    isLoading: false,
  }),
}));

// 受注の導線/営業中の操作は flag 裏。既定 OFF=従来挙動 (既存テスト不変)。
const envHold = vi.hoisted(() => ({
  enableOrderRelay: true, // 受注フィード本体 (既定 ON=既存テストはフィードを描画)
  enableOrderFulfillment: false,
  enableShopLive: false,
  enableHandles: false,
  enableOrderToken: false, // 受注閲覧トークン (ON で店員リンクパネル・厨房/ホール直リンクは抑止)
  enableOrderCall: false,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return envHold.enableOrderRelay;
      },
      get enableOrderFulfillment() {
        return envHold.enableOrderFulfillment;
      },
      get enableShopLive() {
        return envHold.enableShopLive;
      },
      get enableHandles() {
        return envHold.enableHandles;
      },
      get enableOrderToken() {
        return envHold.enableOrderToken;
      },
      get enableOrderCall() {
        return envHold.enableOrderCall;
      },
    },
  };
});

import { OrderFeedPanel } from '@/components/OrderFeedPanel';

const postSpy = vi.fn();

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  h.isSignedIn = true;
  h.isConnected = true;
  h.feedOk = true;
  h.orders = [];
  h.feedStatus = 200;
  h.handles = [];
  h.calls = [];
  envHold.enableOrderFulfillment = false;
  envHold.enableShopLive = false;
  envHold.enableHandles = false;
  envHold.enableOrderToken = false;
  envHold.enableOrderCall = false;
  postSpy.mockClear();
  global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      postSpy(init);
      return jsonRes({ ok: true, removed: 1 });
    }
    const u = String(url);
    if (u.includes('/api/handle')) return jsonRes({ ok: true, handles: h.handles, max: 3 });
    if (u.includes('/api/shop/live'))
      return jsonRes({ ok: true, live: { soldOut: [], paused: false, updatedAt: 0 } });
    if (u.includes('/api/order/calls')) return jsonRes({ ok: true, calls: h.calls });
    return jsonRes(
      h.feedOk ? { ok: true, orders: h.orders } : { ok: false, error: 'kv_error' },
      h.feedStatus,
    );
  }) as unknown as typeof fetch;
});

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <OrderFeedPanel />
    </QueryClientProvider>,
  );
}

const order = {
  orderId: '7K3Q',
  items: [{ name: '水', qty: 2, price: '100' }],
  table: 'テーブル 3',
  amount: '1000000000000000000', // 1 JPYC
  txHash: `0x${'b'.repeat(64)}`,
  chainId: 137,
  from: ADDR,
  ts: Date.now(),
  fulfilled: false,
};

describe('OrderFeedPanel', () => {
  it('未サインイン → サインイン導線 (受注は取得しない)', () => {
    h.isSignedIn = false;
    render();
    expect(screen.getByRole('button', { name: '受取ウォレットでサインイン' })).toBeInTheDocument();
  });

  it('未接続なら押しても進まないサインインボタンは出さず、先に接続へ誘導する', () => {
    h.isSignedIn = false;
    h.isConnected = false;
    render();
    expect(screen.getByText('接続すると、サインインできます。')).toBeInTheDocument();
    // 未接続はボタン 1 つ (押すとウォレットの一覧を開く)。
    fireEvent.click(screen.getByRole('button', { name: 'ウォレットを接続' }));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '受取ウォレットでサインイン' })).toBeNull();
  });

  it('サインイン後 + 受注あり → テーブル・明細・実着金額を描画', async () => {
    h.orders = [order];
    render();
    expect(await screen.findByText('テーブル 3')).toBeInTheDocument();
    expect(screen.getByText('水 × 2')).toBeInTheDocument();
    // 実着金 1 JPYC (formatUnits)。先頭の要約にも件数「1」が出るので、カードの中で確かめる。
    const card = screen.getByText(/受付番号 #/).closest('li') as HTMLElement;
    expect(within(card).getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '対応済みにする' })).toBeInTheDocument();
  });

  it('先頭の要約に未対応の件数 (タブのバッジと同じ受注フィード)・顧客申告の注記は一覧に 1 回', async () => {
    h.orders = [order, { ...order, txHash: `0x${'c'.repeat(64)}`, orderId: '8L4R' }, { ...order, txHash: `0x${'d'.repeat(64)}`, orderId: '9M5S', fulfilled: true }];
    render();
    const summary = await screen.findByRole('region', { name: '未対応の注文' });
    await waitFor(() => expect(summary).toHaveTextContent('2 件'));
    expect(screen.getAllByText('商品・テーブルは顧客申告です。金額はオンチェーンで検証済み（実着金額）。')).toHaveLength(1);
  });

  it('受注が無いときはモバイル注文への導線 (親が渡したときだけ)', async () => {
    const onOpenMobileOrder = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithIntl(
      <QueryClientProvider client={qc}>
        <OrderFeedPanel onOpenMobileOrder={onOpenMobileOrder} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('まだ受注はありません。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'モバイル注文を開く' }));
    expect(onOpenMobileOrder).toHaveBeenCalledOnce();
  });

  it('呼び出しが無いときは黄色の呼び出し欄を出さない (呼び出しがあれば先頭に出す)', async () => {
    envHold.enableOrderCall = true;
    render();
    await screen.findByText('まだ受注はありません。');
    expect(screen.queryByText('🔔 スタッフ呼び出し')).toBeNull();
  });

  it('実着金額は桁区切りで表示する (表示だけ・1650 → 1,650)', async () => {
    h.orders = [{ ...order, amount: '1650000000000000000000' }];
    render();
    expect(await screen.findByText('1,650')).toBeInTheDocument();
  });

  it('呼び出しを受注一覧の先頭セクションに表示し「対応した」を POST', async () => {
    envHold.enableOrderCall = true;
    h.calls = [{ id: 'call-1', handle: 'coffee', table: '8', ts: Date.now() }];
    render();
    expect(await screen.findByText('🔔 テーブル 8')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '対応した' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const call = postSpy.mock.calls.find(([init]) =>
      String((init as { body?: string }).body).includes('call-1'),
    );
    expect(call).toBeTruthy();
  });

  it('customerMemo を申告ラベル付き amber 枠の plain text で表示', async () => {
    h.orders = [{ ...order, customerMemo: '<a href="https://evil.test">卵なし</a>' }];
    const { container } = render();
    expect(await screen.findByText('📝 お客様メモ（申告）')).toBeInTheDocument();
    const memo = screen.getByText('<a href="https://evil.test">卵なし</a>');
    expect(memo.closest('div')).toHaveClass('border-amber-200', 'bg-amber-50');
    expect(container.querySelector('a[href="https://evil.test"]')).toBeNull();
  });

  it('未対応の遅延注文は経過バッジと赤いカード面を表示', async () => {
    h.orders = [{ ...order, ts: Date.now() - (25 * 60_000 + 5_000) }];
    render();
    const card = (await screen.findByText('25分経過')).closest('li');
    expect(card).toHaveClass('border-red-400', 'bg-red-50/60');
  });

  it('amountMismatch → 警告バッジと実着金額ラベルを表示', async () => {
    h.orders = [{ ...order, amountMismatch: true }];
    render();
    expect(await screen.findByText('⚠ 金額不一致・要確認')).toBeInTheDocument();
    expect(screen.getByText('実着金額')).toBeInTheDocument();
    expect(screen.getByText('申告合計: 200 JPYC')).toBeInTheDocument();
  });

  it('standard 手数料未収の受注に明示バッジを表示', async () => {
    h.orders = [{ ...order, feeUncollected: true }];
    render();
    expect(await screen.findByText('OpenPay 手数料未収')).toHaveClass(
      'bg-amber-100',
      'text-amber-800',
    );
  });

  it('受注ゼロ → 空表示', async () => {
    h.orders = [];
    render();
    expect(await screen.findByText('まだ受注はありません。')).toBeInTheDocument();
  });

  it('KV 障害 (503) → エラー表示 (空と区別)', async () => {
    h.feedOk = false;
    h.feedStatus = 503;
    render();
    expect(
      await screen.findByText('受注を取得できませんでした。時間をおいて再試行してください。'),
    ).toBeInTheDocument();
  });

  it('受付番号 (受け渡し照合用) を表示', async () => {
    h.orders = [order];
    render();
    expect(await screen.findByText(/7K3Q/)).toBeInTheDocument();
  });

  it('「対応済みにする」→ POST {txHash, fulfilled:true}', async () => {
    h.orders = [order];
    render();
    fireEvent.click(await screen.findByRole('button', { name: '対応済みにする' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = JSON.parse((postSpy.mock.calls[0][0] as { body: string }).body);
    expect(body.txHash).toBe(order.txHash);
    expect(body.fulfilled).toBe(true);
  });

  it('対応済みの注文は「対応済み」セクション + 「未対応に戻す」(削除でなく復旧可能)', async () => {
    h.orders = [{ ...order, fulfilled: true }];
    render();
    // 未対応リストは空 → 空表示。対応済みは折りたたみセクションに入り「未対応に戻す」が出る。
    expect(await screen.findByText('まだ受注はありません。')).toBeInTheDocument();
    // 折りたたみ見出しは「対応済み (件数)」。完了ヒント文 (同じく「対応済み」を含む) と区別するため件数で照合。
    expect(screen.getByText(/対応済み \(\d+\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '未対応に戻す' })).toBeInTheDocument();
  });

  it('flag OFF (既定): 厨房/ホール導線も営業中の操作も出さない', async () => {
    render();
    await screen.findByText('まだ受注はありません。');
    expect(screen.queryByRole('link', { name: /厨房モニター/ })).toBeNull();
    expect(screen.queryByText('営業中の操作')).toBeNull();
  });

  it('enableOrderFulfillment ON → 厨房/ホールへの導線リンク', async () => {
    envHold.enableOrderFulfillment = true;
    render();
    const kitchen = await screen.findByRole('link', { name: /厨房モニター/ });
    expect(kitchen.getAttribute('href')).toContain('/orders/kitchen');
    expect(
      screen.getByRole('link', { name: /ホール配膳/ }).getAttribute('href'),
    ).toContain('/orders/hall');
  });

  it('enableOrderToken ON: 厨房/ホール直リンクは出さず店員用リンク (受注閲覧トークン) パネルに集約', async () => {
    envHold.enableOrderFulfillment = true;
    envHold.enableOrderToken = true;
    render();
    await screen.findByText('まだ受注はありません。');
    // 直リンクは出さない (店員はトークンリンクで厨房/ホールへ・オーナーもそこから開く)。
    expect(screen.queryByRole('link', { name: /厨房モニター/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /ホール配膳/ })).toBeNull();
    // 代わりに店員用リンク発行パネルを出す。
    expect(screen.getByText(/店員用リンク/)).toBeInTheDocument();
  });

  it('完了フローのヒント: fulfillment OFF=物販向け / ON=飲食(配膳済み=対応済み)', async () => {
    // OFF (物販): このページで対応済み。
    render();
    expect(await screen.findByText(/お渡ししたら「対応済み」/)).toBeInTheDocument();
    expect(screen.queryByText(/配膳済み.*対応済み/)).toBeNull();
    cleanup();
    // ON (飲食): ホールで配膳済み=対応済み の案内。
    envHold.enableOrderFulfillment = true;
    render();
    expect(await screen.findByText(/「配膳済み」にすると自動で「対応済み」/)).toBeInTheDocument();
  });

  it('enableShopLive ON + 公開店舗 → 営業中の操作 (折りたたみ) を表示', async () => {
    envHold.enableShopLive = true;
    envHold.enableHandles = true;
    h.handles = [
      {
        handle: 'shop',
        config: { to: ADDR, name: 'X' },
        storefront: {
          chain: 'polygon',
          mode: 'storefront',
          feePayer: 'merchant',
          menu: [{ id: 'a', name: '水', price: '100' }],
        },
      },
    ];
    render();
    expect(await screen.findByText('営業中の操作')).toBeInTheDocument();
  });

  it('enableOrderRelay OFF + enableShopLive ON → 受注フィードは出さず営業中の操作のみ (relay 非依存)', async () => {
    envHold.enableOrderRelay = false; // 受注リレー無し (shop-live だけ点灯)
    envHold.enableShopLive = true;
    envHold.enableHandles = true;
    h.handles = [
      {
        handle: 'shop',
        config: { to: ADDR, name: 'X' },
        storefront: {
          chain: 'polygon',
          mode: 'storefront',
          feePayer: 'merchant',
          menu: [{ id: 'a', name: '水', price: '100' }],
        },
      },
    ];
    render();
    expect(await screen.findByText('営業中の操作')).toBeInTheDocument();
    // 受注フィード (見出し/空表示) は出ない。
    expect(screen.queryByText('まだ受注はありません。')).toBeNull();
  });
});

it('A2c missing binding warning is independent of amount and fee badges', async () => {
  envHold.enableOrderRelay = true;
  h.orders = [{ ...order, bindingMissing: true }, { ...order, orderId: 'other', txHash: `0x${'cd'.repeat(32)}` }];
  render();
  expect(await screen.findByRole('alert')).toHaveTextContent('支払いと注文の結びつき未確認 — 受け渡し前に手動確認が必要');
  // 常時の技術的な開示文は出さない (結びつけられない注文には、そのカードにだけ注記が出る)。
  expect(screen.queryByText(/暗号学的/)).toBeNull();
});

it('通常の送金で届いた注文のカードにだけ「品物はお客様と確かめて」を出す (警告ではなく注記)', async () => {
  envHold.enableOrderRelay = true;
  h.orders = [{ ...order, unboundPayment: true }, { ...order, orderId: 'other', txHash: `0x${'cd'.repeat(32)}` }];
  render();
  const note = await screen.findByText('通常の送金で支払われた注文です。品物はお客様と確かめてから渡してください。');
  expect(screen.getAllByText('通常の送金で支払われた注文です。品物はお客様と確かめてから渡してください。')).toHaveLength(1);
  expect(note).not.toHaveAttribute('role', 'alert');
  expect(screen.queryByRole('alert')).toBeNull();
});
