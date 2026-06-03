import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

// HistoryView は useMarketRates (React Query) で円換算 GMV を出す。QueryClientProvider を
// 張らない renderWithIntl なので hook をモックして固定レートを返す。
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

// FreeeSyncPanel は wagmi (useSiweSession) + React Query を引くため boundary mock。
// 連携 UI は FreeeSyncPanel 専用 test で検証。本 test は filter/summary/list に集中。
vi.mock('@/components/FreeeSyncPanel', () => ({
  FreeeSyncPanel: () => null,
}));

import { HistoryView } from '@/components/HistoryView';
import {
  appendHistory,
  HISTORY_STORAGE_KEY,
  type HistoryEntry,
} from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
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
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: null,
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
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
    // filter=all 状態: 両方の amount が表示される (行 + 集計サマリの合計に出るため複数可)。
    expect(screen.getAllByText('5 JPYC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3 USDC').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /JPYC \(1\)/ }));
    // JPYC のみ: 5 JPYC は残り、USDC 行は消え集計も 0 USDC になるので '3 USDC' は消える。
    expect(screen.getAllByText('5 JPYC').length).toBeGreaterThan(0);
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

  // 旧 back link assertion は AppShell.AppHeader の logo (/[locale]) に移管された
  // ため、HistoryView 内で個別 assertion は不要。

  describe('Concurrency: 多重 append + cross-tab', () => {
    it('同タブで連続 10 件 append → すべて反映される (CustomEvent batched でも欠落しない)', async () => {
      render(<HistoryView />);
      // mount 後の hydrate 待ち
      await screen.findByText(/履歴はまだありません/);
      for (let i = 0; i < 10; i += 1) {
        appendHistory(entry({ id: `burst-${i}` }));
      }
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(10\)/ }),
        ).toBeInTheDocument(),
      );
    });

    it('他タブからの storage event + 自タブ append → 両方反映', async () => {
      render(<HistoryView />);
      await screen.findByText(/履歴はまだありません/);

      // 「他タブが書いた」想定で LocalStorage 直接書込 + storage event 発火
      const fromOther = entry({ id: 'other-tab', merchantAmount: '500000000000000000000' });
      window.localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify([fromOther]),
      );
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: HISTORY_STORAGE_KEY,
          newValue: 'whatever',
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(1\)/ }),
        ).toBeInTheDocument(),
      );

      // この後、自タブで append → 2 件になる
      appendHistory(entry({ id: 'self', merchantAmount: '700000000000000000000' }));
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(2\)/ }),
        ).toBeInTheDocument(),
      );
    });

    it('LocalStorage が他タブで全消去 → storage event で空表示に遷移', async () => {
      appendHistory(entry({ id: 'a' }));
      appendHistory(entry({ id: 'b' }));
      render(<HistoryView />);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(2\)/ }),
        ).toBeInTheDocument(),
      );

      // 他タブが clear() 相当: removeItem + storage event (key=null)
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
      await waitFor(() =>
        expect(screen.getByText(/履歴はまだありません/)).toBeInTheDocument(),
      );
    });

    it('別オリジン key の storage event は無視 (他アプリの干渉に耐性)', async () => {
      appendHistory(entry({ id: 'mine' }));
      render(<HistoryView />);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(1\)/ }),
        ).toBeInTheDocument(),
      );
      // 自分の key 以外の storage event 多発 (CSS prefs / theme 等の他アプリ書込)
      for (let i = 0; i < 50; i += 1) {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: `other-app-key-${i}`,
            newValue: 'x',
          }),
        );
      }
      // state は変わらない
      expect(
        screen.getByRole('button', { name: /全て \(1\)/ }),
      ).toBeInTheDocument();
    });
  });

  describe('大量 entries の表示性能 sanity', () => {
    it('1000 件 (HISTORY_MAX_ENTRIES boundary) の entry でも render が成立する', async () => {
      for (let i = 0; i < 1000; i += 1) {
        appendHistory(
          entry({
            id: `max-${i}`,
            asset: i % 2 === 0 ? 'jpyc' : 'usdc',
          }),
        );
      }
      const t0 = performance.now();
      render(<HistoryView />);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(1000\)/ }),
        ).toBeInTheDocument(),
      );
      const dt = performance.now() - t0;
      // jsdom render は本番 DOM より大幅に遅い (10-50x)。本番 chrome では <1s 想定。
      // jsdom 上の 1000-row mount は 10s 以下を許容ライン (CI のばらつき吸収)。
      expect(dt).toBeLessThan(10_000);
      expect(
        screen.getByRole('button', { name: /JPYC \(500\)/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /USDC \(500\)/ }),
      ).toBeInTheDocument();
    });

    it('500 件の entry を持ち、filter 切替が成立する', async () => {
      const user = userEvent.setup();
      for (let i = 0; i < 500; i += 1) {
        appendHistory(
          entry({
            id: `bulk-${i}`,
            asset: i % 2 === 0 ? 'jpyc' : 'usdc',
          }),
        );
      }
      render(<HistoryView />);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /全て \(500\)/ }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByRole('button', { name: /JPYC \(250\)/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /USDC \(250\)/ }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /USDC \(250\)/ }));
      // フィルタ後も page は壊れない (描画完了)
      expect(
        screen.getByRole('button', { name: /USDC \(250\)/ }),
      ).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
