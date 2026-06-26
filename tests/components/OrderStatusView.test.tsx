// 顧客向け「注文状況」ビュー (お渡し準備完了通知) を実描画で検証。useOrderStatus / successChime は
// mock し、状態ごとの描画 + ready 遷移時のチャイム発火 (1回・初回ロードは抑止) を直接確認する。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { OrderStatusData } from '@/hooks/useOrderStatus';

const chime = vi.hoisted(() => ({ play: vi.fn(), prime: vi.fn() }));
vi.mock('@/lib/successChime', () => ({
  playNewOrderChime: () => chime.play(),
  primeChimeAudio: () => chime.prime(),
}));

const hold = vi.hoisted(() => ({
  data: undefined as OrderStatusData | undefined,
  isError: false,
  error: null as Error | null,
}));
const refetch = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useOrderStatus', () => ({
  useOrderStatus: () => ({ data: hold.data, isError: hold.isError, error: hold.error, refetch }),
}));

import { OrderStatusView } from '@/components/OrderStatusView';

function status(over: Partial<OrderStatusData> = {}): OrderStatusData {
  return { state: 'received', orderId: 'A12', updatedAt: 111, ...over };
}

beforeEach(() => {
  hold.data = undefined;
  hold.isError = false;
  hold.error = null;
  chime.play.mockClear();
  chime.prime.mockClear();
  refetch.mockClear();
});

describe('OrderStatusView', () => {
  it('token 無し → リンク不正の案内', () => {
    renderWithIntl(<OrderStatusView token={null} />);
    expect(screen.getByText('リンクが正しくありません')).toBeInTheDocument();
  });

  it('received → 受付メッセージ + keep-open + 受付番号', () => {
    hold.data = status();
    renderWithIntl(<OrderStatusView token="t" />);
    expect(screen.getByText('ご注文を受け付けました')).toBeInTheDocument();
    expect(screen.getByText(/この画面を開いたまま/)).toBeInTheDocument();
    expect(screen.getByText('#A12')).toBeInTheDocument();
  });

  it('preparing → 準備中メッセージ', () => {
    hold.data = status({ state: 'preparing' });
    renderWithIntl(<OrderStatusView token="t" />);
    expect(screen.getByText('ただいま準備中です')).toBeInTheDocument();
  });

  it('ready (初回ロード) → 準備完了 + 受付番号 + readyAt・チャイムは鳴らさない', () => {
    hold.data = status({ state: 'ready', readyAt: 1_700_000_000_000 });
    renderWithIntl(<OrderStatusView token="t" />);
    expect(screen.getByText('お渡しの準備ができました')).toBeInTheDocument();
    expect(screen.getByText('#A12')).toBeInTheDocument();
    expect(screen.getByText(/準備完了/)).toBeInTheDocument();
    // 初回ロードで既に ready は顧客が画面を見ている前提ゆえ鳴らさない。
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('received → ready 遷移でチャイムを 1 回鳴らす', () => {
    hold.data = status({ state: 'received' });
    const { rerender } = renderWithIntl(<OrderStatusView token="t" />);
    expect(chime.play).not.toHaveBeenCalled();
    hold.data = status({ state: 'ready' });
    rerender(<OrderStatusView token="t" />);
    expect(chime.play).toHaveBeenCalledTimes(1);
  });

  it('done → 受け渡し完了メッセージ', () => {
    hold.data = status({ state: 'done' });
    renderWithIntl(<OrderStatusView token="t" />);
    expect(screen.getByText('お受け取りありがとうございました')).toBeInTheDocument();
  });

  it('not_found エラー (データ無し) → 見つからない案内', () => {
    hold.isError = true;
    hold.error = new Error('not_found');
    renderWithIntl(<OrderStatusView token="t" />);
    expect(screen.getByText('注文が見つかりません')).toBeInTheDocument();
  });

  it('その他エラー (データ無し) → 取得失敗案内 (自動再試行)', () => {
    hold.isError = true;
    hold.error = new Error('kv_error');
    renderWithIntl(<OrderStatusView token="t" />);
    expect(screen.getByText('状況を取得できませんでした')).toBeInTheDocument();
  });
});
