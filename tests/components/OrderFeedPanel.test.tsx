// OrderFeedPanel を実描画で検証: 未サインイン=サインイン導線 / サインイン後=受注描画 (テーブル/
// 明細/実着金額) / 空 / KV エラー / 「対応済み」で POST。useSiweSession と fetch をモック・QueryClient 注入。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({
  isSignedIn: true,
  feedOk: true,
  orders: [] as unknown[],
  feedStatus: 200,
  handles: [] as unknown[], // GET /api/handle (営業中の操作 用所有 handle)
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
  h.feedOk = true;
  h.orders = [];
  h.feedStatus = 200;
  h.handles = [];
  envHold.enableOrderFulfillment = false;
  envHold.enableShopLive = false;
  envHold.enableHandles = false;
  envHold.enableOrderToken = false;
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
    expect(screen.getByText('受取ウォレットでサインイン')).toBeInTheDocument();
  });

  it('サインイン後 + 受注あり → テーブル・明細・実着金額を描画', async () => {
    h.orders = [order];
    render();
    expect(await screen.findByText('テーブル 3')).toBeInTheDocument();
    expect(screen.getByText('水 × 2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // 実着金 1 JPYC (formatUnits)
    expect(screen.getByRole('button', { name: '対応済みにする' })).toBeInTheDocument();
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

  it('受注番号 (受け渡し照合用) を表示', async () => {
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
