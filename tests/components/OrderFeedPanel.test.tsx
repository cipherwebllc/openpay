// OrderFeedPanel を実描画で検証: 未サインイン=サインイン導線 / サインイン後=受注描画 (テーブル/
// 明細/実着金額) / 空 / KV エラー / 「対応済み」で POST。useSiweSession と fetch をモック・QueryClient 注入。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({
  isSignedIn: true,
  feedOk: true,
  orders: [] as unknown[],
  feedStatus: 200,
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
  postSpy.mockClear();
  global.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      postSpy(init);
      return jsonRes({ ok: true, removed: 1 });
    }
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
  orderId: 'oid-1',
  items: [{ name: '水', qty: 2, price: '100' }],
  table: 'テーブル 3',
  amount: '1000000000000000000', // 1 JPYC
  txHash: `0x${'b'.repeat(64)}`,
  chainId: 137,
  from: ADDR,
  ts: 1,
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

  it('「対応済みにする」→ POST /api/order/feed (fulfill)', async () => {
    h.orders = [order];
    render();
    fireEvent.click(await screen.findByRole('button', { name: '対応済みにする' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
  });
});
