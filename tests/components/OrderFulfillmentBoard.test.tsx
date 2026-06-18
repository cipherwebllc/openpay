// 受注フルフィルメントボード (厨房/ホール) を実描画で検証。useSiweSession / useOrderFeed は mock
// (react-query/fetch を介さず、描画 + op 発火を直接検証)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { StoredOrder } from '@/lib/orderRelay';

const envHold = vi.hoisted(() => ({ enablePreorderTime: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePreorderTime() {
        return envHold.enablePreorderTime;
      },
    },
  };
});

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
  envHold.enablePreorderTime = false; // Phase 4 flag 既定 OFF
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

  it('対応済み(fulfill)ボタンは出さない (受注で確定・厨房→ホール連動消失を回避)', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByRole('button', { name: '対応済み' })).toBeNull();
  });

  it('テーブル訂正: 編集→保存で setTable op を発火 (店内・table あり)', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: /T1/ })); // テーブル編集を開く
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: 'B2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'setTable', table: 'B2' },
    });
  });

  it('テイクアウト (table 空) はテーブル未設定/訂正を出さない', () => {
    feedHold.data = [order({ table: null })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText('テーブル未設定')).toBeNull();
    expect(screen.queryByText('訂正')).toBeNull();
    // 商品 (調理対象) は出る (テイクアウトでも厨房は調理する)。
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument();
  });

  it('対応済みの注文は表示しない (未対応のみ)', () => {
    feedHold.data = [order({ fulfilled: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText(/牛丼/)).toBeNull();
    expect(screen.getByText('未対応の受注はありません。')).toBeInTheDocument();
  });

  it('flag ON + pickupAt → 受取予定時刻バッジを Tokyo HH:mm で表示 (Phase 4)', () => {
    envHold.enablePreorderTime = true;
    // Date.UTC(2024,0,15,4,30) = Tokyo 13:30。tokyoHHMM は純関数 (Date.now 非依存)。
    feedHold.data = [order({ pickupAt: Date.UTC(2024, 0, 15, 4, 30) })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('受取 13:30')).toBeInTheDocument();
  });

  it('flag OFF: pickupAt があってもバッジを出さない (inert)', () => {
    // flag OFF (既定) + pickupAt 有り → 手動 pickup_at 混入でも観測上 inert。
    feedHold.data = [order({ pickupAt: Date.UTC(2024, 0, 15, 4, 30) })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText(/受取 \d/)).toBeNull();
  });

  it('pickupAt が無ければバッジを出さない', () => {
    envHold.enablePreorderTime = true;
    feedHold.data = [order()]; // pickupAt 無し
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText(/受取 \d/)).toBeNull();
  });

  it('厨房: 注文単位「調理済み」→ kitchenDone op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: '調理済み' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'kitchenDone', value: true } });
  });

  it('ホール: 注文単位「配膳済み」→ fulfill op を発火 (配膳済み=対応済み)', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    fireEvent.click(screen.getByRole('button', { name: '配膳済み' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'fulfill', value: true } });
  });

  it('厨房: kitchenDone 済みは active から消え「調理済み」折りたたみへ + 未調理に戻す', () => {
    feedHold.data = [order({ kitchenDone: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('未完了の受注はありません。')).toBeInTheDocument(); // active 空
    expect(screen.getByText(/調理済み \(1\)/)).toBeInTheDocument(); // 折りたたみセクション
    fireEvent.click(screen.getByRole('button', { name: '未調理に戻す' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'kitchenDone', value: false } });
  });

  it('ホール: fulfilled (配膳済み) は active から消え「配膳済み」折りたたみへ + 未配膳に戻す', () => {
    feedHold.data = [order({ fulfilled: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('未完了の受注はありません。')).toBeInTheDocument(); // active 空
    expect(screen.getByText(/配膳済み \(1\)/)).toBeInTheDocument(); // 折りたたみセクション
    fireEvent.click(screen.getByRole('button', { name: '未配膳に戻す' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'fulfill', value: false } });
  });

  it('厨房: fulfilled (ホール配膳済み=対応済み) は厨房から完全に消える', () => {
    feedHold.data = [order({ fulfilled: true, kitchenDone: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    // 厨房は !fulfilled のみ対象 → 対応済みは active にも折りたたみにも出ない (受注で確定済み)。
    expect(screen.getByText('未対応の受注はありません。')).toBeInTheDocument();
    expect(screen.queryByText(/牛丼/)).toBeNull();
  });

  it('独立性: kitchenDone 済みでも ホール配膳では active のまま (調理済み≠対応済み)', () => {
    feedHold.data = [order({ kitchenDone: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument(); // active カード
    expect(screen.queryByText('未完了の受注はありません。')).toBeNull();
  });

  it('ホール: 全品 調理済み (cooked) なら「配膳準備OK」バッジを表示', () => {
    feedHold.data = [order({ items: [{ name: '牛丼', qty: 1, price: '500', cooked: true }] })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('配膳準備OK')).toBeInTheDocument();
  });

  it('ホール: 一部未調理なら「配膳準備OK」バッジは出さない', () => {
    feedHold.data = [
      order({
        items: [
          { name: '牛丼', qty: 1, price: '500', cooked: true },
          { name: '味噌汁', qty: 1, price: '100' },
        ],
      }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText('配膳準備OK')).toBeNull();
  });

  it('ホール: 明細が空なら「配膳準備OK」は出さない (every() の空配列 true を items.length>0 で防ぐ)', () => {
    feedHold.data = [order({ items: [] })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText('配膳準備OK')).toBeNull();
  });
});
