// 店頭呼出モニターを実描画で検証。SIWE / feed / token storage は mock し、
// お客様向け表示の振り分け・順序・完了除外・空表示と、既存ボード同等の token/polling を担保する。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { StoredOrder } from '@/lib/orderRelay';

const envHold = vi.hoisted(() => ({ enableOrderToken: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderToken() {
        return envHold.enableOrderToken;
      },
    },
  };
});

const tokenHold = vi.hoisted(() => ({ stored: null as string | null }));
vi.mock('@/lib/orderTokenClient', () => ({
  getStoredOrderToken: () => tokenHold.stored,
  setStoredOrderToken: (token: string) => {
    tokenHold.stored = token;
  },
  clearStoredOrderToken: () => {
    tokenHold.stored = null;
  },
}));

const siwe = vi.hoisted(() => ({
  isSignedIn: true,
  sessionAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as string | null,
  signIn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: siwe.isSignedIn,
    sessionAddress: siwe.sessionAddress,
    signIn: siwe.signIn,
    isSigningIn: false,
    signInError: null,
  }),
}));

const feedHold = vi.hoisted(() => ({
  data: [] as StoredOrder[],
  isLoading: false,
  isError: false,
  error: null as Error | null,
  interval: 0,
  token: undefined as string | null | undefined,
}));
vi.mock('@/hooks/useOrderFeed', () => ({
  useOrderFeed: (
    _sessionAddress: string | null | undefined,
    _isSignedIn: boolean,
    interval: number,
    token?: string | null,
  ) => {
    feedHold.interval = interval;
    feedHold.token = token;
    return {
      feed: {
        data: feedHold.data,
        isLoading: feedHold.isLoading,
        isError: feedHold.isError,
        error: feedHold.error,
      },
    };
  },
}));

import { OrderPickupMonitor } from '@/components/OrderPickupMonitor';

function order(orderId: string, over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId,
    items: [{ name: '非公開の商品', qty: 1, price: '500' }],
    table: '非公開テーブル',
    amount: '500000000000000000000',
    txHash: `0x${orderId}`,
    chainId: 137,
    from: '',
    ts: 100,
    fulfilled: false,
    customerMemo: '非公開メモ',
    ...over,
  };
}

beforeEach(() => {
  envHold.enableOrderToken = false;
  tokenHold.stored = null;
  siwe.isSignedIn = true;
  siwe.sessionAddress = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
  siwe.signIn.mockClear();
  feedHold.data = [];
  feedHold.isLoading = false;
  feedHold.isError = false;
  feedHold.error = null;
  feedHold.interval = 0;
  feedHold.token = undefined;
  window.history.replaceState(null, '', '/ja/orders/pickup');
});

describe('OrderPickupMonitor', () => {
  it('ready 有無で準備中/呼出中へ振り分け、受付順/ready 順に受付番号だけを表示する', () => {
    feedHold.data = [
      order('WAIT02', { ts: 200 }),
      order('CALL02', { ts: 50, ready: true, readyAt: 400 }),
      order('WAIT01', { ts: 100, ready: false }),
      order('CALL01', { ts: 300, ready: true, readyAt: 250 }),
    ];
    renderWithIntl(<OrderPickupMonitor />);

    const preparing = screen.getByRole('region', { name: '準備中' });
    const calling = screen.getByRole('region', { name: '呼出中' });
    expect(within(preparing).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'WAIT01',
      'WAIT02',
    ]);
    expect(within(calling).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'CALL01',
      'CALL02',
    ]);
    expect(screen.queryByText('非公開の商品')).toBeNull();
    expect(screen.queryByText('非公開テーブル')).toBeNull();
    expect(screen.queryByText('非公開メモ')).toBeNull();
  });

  it('配膳済み (fulfilled) は準備中/呼出中のどちらにも表示しない', () => {
    feedHold.data = [
      order('DONE01', { fulfilled: true }),
      order('DONE02', { fulfilled: true, ready: true, readyAt: 200 }),
      order('ACTIVE', { ready: true, readyAt: 300 }),
    ];
    renderWithIntl(<OrderPickupMonitor />);
    expect(screen.queryByText('DONE01')).toBeNull();
    expect(screen.queryByText('DONE02')).toBeNull();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('0 件時は準備中/呼出中それぞれの空メッセージを表示する', () => {
    renderWithIntl(<OrderPickupMonitor />);
    expect(screen.getByText('準備中の受付番号はありません。')).toBeInTheDocument();
    expect(screen.getByText('現在呼び出し中の受付番号はありません。')).toBeInTheDocument();
  });

  it('受注閲覧 token を保存して既存ボードと同じ 8 秒 polling で feed に渡す', async () => {
    const token = 'a'.repeat(43);
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false;
    siwe.sessionAddress = null;
    window.history.replaceState(null, '', `/ja/orders/pickup?t=${token}`);
    renderWithIntl(<OrderPickupMonitor initialToken={token} />);

    await waitFor(() => expect(feedHold.token).toBe(token));
    expect(tokenHold.stored).toBe(token);
    expect(feedHold.interval).toBe(8_000);
    expect(window.location.search).toBe('');
    expect(screen.getByRole('heading', { name: '呼出モニター' })).toBeInTheDocument();
  });

  it('未認可時はサインイン要求、feed 障害時は空表示と区別したエラーを表示する', () => {
    siwe.isSignedIn = false;
    siwe.sessionAddress = null;
    const view = renderWithIntl(<OrderPickupMonitor />);
    expect(
      screen.getByText('受取ウォレットでサインインすると受注を進捗管理できます。'),
    ).toBeInTheDocument();

    siwe.isSignedIn = true;
    siwe.sessionAddress = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    feedHold.isError = true;
    feedHold.error = new Error('kv_error');
    view.rerender(<OrderPickupMonitor />);
    expect(
      screen.getByText('受注を取得できませんでした。時間をおいて再試行してください。'),
    ).toBeInTheDocument();
  });
});
