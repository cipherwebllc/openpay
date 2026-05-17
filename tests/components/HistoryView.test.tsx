import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { HistoryView } from '@/components/HistoryView';
import {
  appendHistory,
  type HistoryEntry,
} from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'view-test-' + Math.random(),
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xT',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10000000000000000',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: '0xUO',
    blockNumber: '12345',
    errorMessage: null,
    storeName: '',
    note: '',
    ...overrides,
  };
}

describe('HistoryView', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('空 → empty state + NonCustodialNotice (full)', async () => {
    render(<HistoryView />);
    expect(
      await screen.findByText(/履歴はまだありません/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: '取引履歴について' }),
    ).toBeInTheDocument();
  });

  it('entries あり → filter / counts / CSV button が見える', async () => {
    appendHistory(entry({ id: 'a', asset: 'jpyc' }));
    appendHistory(entry({ id: 'b', asset: 'jpyc' }));
    appendHistory(entry({ id: 'c', asset: 'usdc' }));

    render(<HistoryView />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /全て \(3\)/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /JPYC \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /USDC \(1\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'CSV ダウンロード' }),
    ).toBeEnabled();
  });

  it('filter=JPYC を選ぶと USDC は非表示', async () => {
    const user = userEvent.setup();
    appendHistory(entry({ id: 'j1', asset: 'jpyc', merchantAmount: '5000000000000000000' })); // 5 JPYC
    appendHistory(entry({ id: 'u1', asset: 'usdc', merchantAmount: '3000000' })); // 3 USDC

    render(<HistoryView />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /JPYC \(1\)/ }),
      ).toBeInTheDocument(),
    );
    // filter=all 状態: 両方の amount が表示される
    expect(screen.getByText('5 JPYC')).toBeInTheDocument();
    expect(screen.getByText('3 USDC')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /JPYC \(1\)/ }));
    expect(screen.getByText('5 JPYC')).toBeInTheDocument();
    expect(screen.queryByText('3 USDC')).toBeNull();
  });

  it('LocalStorage を別タブ経由で書き換え → storage event で再表示', async () => {
    render(<HistoryView />);
    expect(
      await screen.findByText(/履歴はまだありません/),
    ).toBeInTheDocument();

    // 他タブ writeback の simulation
    appendHistory(entry({ id: 'after-mount' }));
    await waitFor(() =>
      expect(screen.queryByText(/履歴はまだありません/)).toBeNull(),
    );
    expect(
      screen.getByRole('button', { name: /全て \(1\)/ }),
    ).toBeInTheDocument();
  });

  it('行内 remove → 該当 entry が消える (confirm を true で固定)', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    appendHistory(entry({ id: 'rm' }));

    render(<HistoryView />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'この行を削除' }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'この行を削除' }));
    await waitFor(() =>
      expect(screen.queryByText(/バッチ送金/)).toBeNull(),
    );
    vi.restoreAllMocks();
  });

  it('NonCustodialNotice (full) が常に描画される', async () => {
    appendHistory(entry({ id: 'x' }));
    render(<HistoryView />);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 2, name: '取引履歴について' }),
      ).toBeInTheDocument(),
    );
  });

  it('browserScopeNote が hydrate 後に件数表示する', async () => {
    appendHistory(entry({ id: 'n1' }));
    appendHistory(entry({ id: 'n2' }));
    render(<HistoryView />);
    await waitFor(() =>
      expect(
        screen.getByText(/履歴はこのブラウザにのみ保存されています \(2\/1000 件/),
      ).toBeInTheDocument(),
    );
  });

  it('back link は "/" を指す', async () => {
    render(<HistoryView />);
    const back = await screen.findByRole('link', { name: '← OpenPay' });
    expect(back).toHaveAttribute('href', '/');
  });
});
