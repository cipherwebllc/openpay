import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { HistoryToolbar } from '@/components/HistoryToolbar';
import * as historyModule from '@/lib/history';
import * as csvModule from '@/lib/historyCsv';
import * as downloadModule from '@/lib/download';
import { EMPTY_HISTORY_FILTERS, type HistoryFilters } from '@/lib/historyFilters';
import type { HistoryEntry } from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: 'id-' + Math.random(),
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: '0xTx',
    userOpHash: '0xUO',
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: '1000000000000000000000',
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    ...overrides,
  };
}

function renderToolbar(
  props: Partial<{
    entries: HistoryEntry[];
    filters: HistoryFilters;
    counts: { all: number; jpyc: number; usdc: number };
    usdcJpy: number | undefined;
  }> = {},
) {
  const onFiltersChange = vi.fn();
  render(
    <HistoryToolbar
      entries={props.entries ?? []}
      filters={props.filters ?? EMPTY_HISTORY_FILTERS}
      onFiltersChange={onFiltersChange}
      counts={props.counts ?? { all: 0, jpyc: 0, usdc: 0 }}
      usdcJpy={props.usdcJpy}
    />,
  );
  return { onFiltersChange };
}

describe('HistoryToolbar', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('通貨フィルタ: active は aria-pressed=true・クリックで onFiltersChange(asset)', async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderToolbar({ counts: { all: 3, jpyc: 2, usdc: 1 } });
    expect(screen.getByRole('button', { name: /全て \(3\)/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: /JPYC \(2\)/ }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ asset: 'jpyc' }),
    );
  });

  it('状態フィルタ: 成功 クリックで onFiltersChange(status=success)', async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderToolbar({ counts: { all: 1, jpyc: 1, usdc: 0 } });
    await user.click(screen.getByRole('button', { name: '成功' }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('検索入力で onFiltersChange(search)', async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderToolbar();
    await user.type(screen.getByRole('searchbox'), 'x');
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'x' }),
    );
  });

  it('期間プリセット「今月」で fromTs/toTs が設定される', async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderToolbar();
    await user.selectOptions(screen.getByLabelText('期間'), 'this');
    const last = onFiltersChange.mock.calls.at(-1)![0] as HistoryFilters;
    expect(typeof last.fromTs).toBe('number');
    expect(typeof last.toTs).toBe('number');
    expect(last.toTs! > last.fromTs!).toBe(true);
  });

  it('entries 空 → 生CSV / 会計CSV / 全消去 が disabled', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'CSV ダウンロード' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '会計CSVを書き出し' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '全て削除' })).toBeDisabled();
  });

  it('生 CSV → toCsv + downloadBlob', async () => {
    const user = userEvent.setup();
    const toCsvSpy = vi.spyOn(csvModule, 'toCsv').mockReturnValue('csv');
    const downloadSpy = vi
      .spyOn(downloadModule, 'downloadBlob')
      .mockImplementation(() => undefined);
    const entries = [entry({ id: '1' }), entry({ id: '2' })];
    renderToolbar({ entries, counts: { all: 2, jpyc: 2, usdc: 0 } });
    await user.click(screen.getByRole('button', { name: 'CSV ダウンロード' }));
    expect(toCsvSpy).toHaveBeenCalledWith(entries);
    expect(downloadSpy).toHaveBeenCalledOnce();
    expect(downloadSpy.mock.calls[0]![1]).toMatch(/^openpay-history-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('会計CSV (freee・JPYC) → downloadBlob (openpay-freee-*.csv)', async () => {
    const user = userEvent.setup();
    const downloadSpy = vi
      .spyOn(downloadModule, 'downloadBlob')
      .mockImplementation(() => undefined);
    renderToolbar({
      entries: [entry({ asset: 'jpyc' })],
      counts: { all: 1, jpyc: 1, usdc: 0 },
      usdcJpy: 150,
    });
    await user.click(screen.getByRole('button', { name: '会計CSVを書き出し' }));
    expect(downloadSpy).toHaveBeenCalledOnce();
    expect(downloadSpy.mock.calls[0]![1]).toMatch(/^openpay-freee-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('会計CSV (MF 仕訳帳・JPYC) → downloadBlob (openpay-mf-*.csv)', async () => {
    const user = userEvent.setup();
    const downloadSpy = vi
      .spyOn(downloadModule, 'downloadBlob')
      .mockImplementation(() => undefined);
    renderToolbar({
      entries: [entry({ asset: 'jpyc' })],
      counts: { all: 1, jpyc: 1, usdc: 0 },
      usdcJpy: 150,
    });
    await user.selectOptions(screen.getByLabelText('会計ソフト形式'), 'mf');
    await user.click(screen.getByRole('button', { name: '会計CSVを書き出し' }));
    expect(downloadSpy).toHaveBeenCalledOnce();
    expect(downloadSpy.mock.calls[0]![1]).toMatch(/^openpay-mf-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('会計CSV (弥生ネイティブ) → Shift_JIS encode 後に downloadBlob (openpay-yayoi-native-*.csv)', async () => {
    const user = userEvent.setup();
    const downloadSpy = vi
      .spyOn(downloadModule, 'downloadBlob')
      .mockImplementation(() => undefined);
    renderToolbar({
      entries: [entry({ asset: 'jpyc' })],
      counts: { all: 1, jpyc: 1, usdc: 0 },
      usdcJpy: 150,
    });
    await user.selectOptions(screen.getByLabelText('会計ソフト形式'), 'yayoi-native');
    await user.click(screen.getByRole('button', { name: '会計CSVを書き出し' }));
    // encodeShiftJis は encoding-japanese を動的 import するため非同期で完了する。
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledOnce());
    expect(downloadSpy.mock.calls[0]![1]).toMatch(
      /^openpay-yayoi-native-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });

  it('会計CSV: USDC無anchor + レート無 → alert・downloadBlob は呼ばれない', async () => {
    const user = userEvent.setup();
    const downloadSpy = vi
      .spyOn(downloadModule, 'downloadBlob')
      .mockImplementation(() => undefined);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    renderToolbar({
      entries: [entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null })],
      counts: { all: 1, jpyc: 0, usdc: 1 },
      usdcJpy: undefined,
    });
    await user.click(screen.getByRole('button', { name: '会計CSVを書き出し' }));
    expect(alertSpy).toHaveBeenCalledOnce();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('全消去: confirm true で clearHistory・false で呼ばれない', async () => {
    const user = userEvent.setup();
    const clearSpy = vi
      .spyOn(historyModule, 'clearHistory')
      .mockImplementation(() => undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderToolbar({ entries: [entry()], counts: { all: 1, jpyc: 1, usdc: 0 } });
    await user.click(screen.getByRole('button', { name: '全て削除' }));
    expect(clearSpy).toHaveBeenCalledOnce();

    confirmSpy.mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: '全て削除' }));
    expect(clearSpy).toHaveBeenCalledOnce(); // 増えない
  });
});
