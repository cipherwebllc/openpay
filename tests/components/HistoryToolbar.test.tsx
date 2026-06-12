import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
    ...overrides,
  };
}

function renderToolbar(
  props: Partial<{
    entries: HistoryEntry[];
    filters: HistoryFilters;
    counts: { all: number; jpyc: number; usdc: number };
    directionCounts: { all: number; in: number; out: number };
    usdcJpy: number | undefined;
    csvLocked: boolean;
    csvLockReason: 'fee' | 'pass';
  }> = {},
) {
  const onFiltersChange = vi.fn();
  render(
    <HistoryToolbar
      entries={props.entries ?? []}
      filters={props.filters ?? EMPTY_HISTORY_FILTERS}
      onFiltersChange={onFiltersChange}
      counts={props.counts ?? { all: 0, jpyc: 0, usdc: 0 }}
      directionCounts={props.directionCounts ?? { all: 0, in: 0, out: 0 }}
      usdcJpy={props.usdcJpy}
      csvLocked={props.csvLocked ?? false}
      csvLockReason={props.csvLockReason}
    />,
  );
  return { onFiltersChange };
}

describe('HistoryToolbar', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('各フィルタ行の左に可視の軸ラベル 種別：/通貨：/状態： を描画する', () => {
    renderToolbar();
    // aria-hidden だが DOM には存在し画面に出る (機能の核 = 何の軸か即時伝達)。
    expect(screen.getByText('種別：')).toBeInTheDocument();
    expect(screen.getByText('通貨：')).toBeInTheDocument();
    expect(screen.getByText('状態：')).toBeInTheDocument();
  });

  it('csvLocked=true (既定 reason=fee) → CSV系3ボタンを無効化 + 利用料未払いノートを表示', () => {
    renderToolbar({ entries: [entry()], csvLocked: true });
    expect(
      (screen.getByRole('button', { name: 'CSV ダウンロード' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '会計CSVを書き出し' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '会計明細CSV' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // a1 延滞専用の文言 (cause-aware の既定 'fee')。
    expect(screen.getByText(/会計CSVのダウンロードを一時的に制限/)).toBeInTheDocument();
  });

  it('csvLocked=true・reason=pass → CSV パス購入を促す cause-aware ノート (延滞文言ではない)', () => {
    renderToolbar({ entries: [entry()], csvLocked: true, csvLockReason: 'pass' });
    expect(
      (screen.getByRole('button', { name: 'CSV ダウンロード' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // パスゲートの文言: CSV 24時間パスの購入導線。a1 延滞専用文言は出ない (出し分けの核)。
    expect(
      screen.getByText(/CSV 24時間パスが必要です/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/会計CSVのダウンロードを一時的に制限/)).toBeNull();
  });

  it('csvLocked=false (取引あり) → CSV系ボタン有効 + ノート非表示', () => {
    renderToolbar({ entries: [entry()], csvLocked: false });
    expect(
      (screen.getByRole('button', { name: 'CSV ダウンロード' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText(/会計CSVのダウンロードを一時的に制限/)).toBeNull();
  });

  it('状態フィルタの「差し戻し」pill は専門用語補足の title ツールチップを持つ', () => {
    renderToolbar();
    const statusGroup = within(
      screen.getByRole('group', { name: '状態で絞り込み' }),
    );
    expect(
      statusGroup.getByRole('button', { name: '差し戻し' }),
    ).toHaveAttribute('title', 'チェーン上で処理が巻き戻された取引');
    // 専門用語でない他の pill には title を付けない (過剰表示を避ける)。
    expect(
      statusGroup.getByRole('button', { name: '成功' }),
    ).not.toHaveAttribute('title');
  });

  it('通貨フィルタ: active は aria-pressed=true・クリックで onFiltersChange(asset)', async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderToolbar({ counts: { all: 3, jpyc: 2, usdc: 1 } });
    // 通貨「すべて(3)」は方向「すべて(3)」と同テキストなので通貨グループにスコープ。
    const assetGroup = within(screen.getByRole('group', { name: 'フィルタ' }));
    expect(
      assetGroup.getByRole('button', { name: /すべて \(3\)/ }),
    ).toHaveAttribute('aria-pressed', 'true');
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
    // v5: 生 CSV は税額(円)算出用に usdcJpy を渡す (renderToolbar 既定は undefined)。
    expect(toCsvSpy).toHaveBeenCalledWith(entries, { usdcJpy: undefined });
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
