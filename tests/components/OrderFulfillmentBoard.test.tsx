// 受注フルフィルメントボード (厨房/ホール) を実描画で検証。useSiweSession / useOrderFeed は mock
// (react-query/fetch を介さず、描画 + op 発火を直接検証)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { StoredOrder } from '@/lib/orderRelay';

const siwe = vi.hoisted(() => ({ isSignedIn: true }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: siwe.isSignedIn,
    sessionAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));

const mutateSpy = vi.hoisted(() => vi.fn());
const feedHold = vi.hoisted(() => ({ data: [] as StoredOrder[] }));
vi.mock('@/hooks/useOrderFeed', () => ({
  useOrderFeed: () => ({
    feed: { data: feedHold.data, isError: false, isLoading: false, refetch: vi.fn() },
    update: { mutate: mutateSpy, isPending: false },
  }),
}));

import { OrderFulfillmentBoard } from '@/components/OrderFulfillmentBoard';

const TX = `0x${'a'.repeat(64)}`;
function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'A1',
    items: [{ name: '牛丼', qty: 1, price: '500' }],
    table: 'T1',
    amount: '1000000000000000000',
    txHash: TX,
    chainId: 137,
    from: '',
    ts: 1,
    fulfilled: false,
    ...over,
  };
}

beforeEach(() => {
  siwe.isSignedIn = true;
  feedHold.data = [order()];
  mutateSpy.mockClear();
});

describe('OrderFulfillmentBoard', () => {
  it('未サインインはサインインを促す', () => {
    siwe.isSignedIn = false;
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByRole('button', { name: 'サインイン' })).toBeInTheDocument();
  });

  it('厨房: 商品タップで itemCooked op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: /牛丼/ }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'itemCooked', index: 0, value: true },
    });
  });

  it('ホール: 商品タップで itemServed op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    fireEvent.click(screen.getByRole('button', { name: /牛丼/ }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'itemServed', index: 0, value: true },
    });
  });

  it('「対応済み」で fulfill op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: '対応済み' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'fulfill', value: true } });
  });

  it('テーブル訂正: 編集→保存で setTable op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: /T1/ })); // テーブル編集を開く
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: 'B2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'setTable', table: 'B2' },
    });
  });

  it('対応済みの注文は表示しない (未対応のみ)', () => {
    feedHold.data = [order({ fulfilled: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText(/牛丼/)).toBeNull();
    expect(screen.getByText('未対応の受注はありません。')).toBeInTheDocument();
  });
});
