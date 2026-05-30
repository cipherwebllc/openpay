import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { HistoryToolbar } from '@/components/HistoryToolbar';
import * as historyModule from '@/lib/history';
import * as csvModule from '@/lib/historyCsv';
import * as downloadModule from '@/lib/download';
import type { HistoryEntry } from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
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
    merchantAmount: '1000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10',
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
    ...overrides,
  };
}

describe('HistoryToolbar', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('3 種の filter button が表示され、active な button は aria-pressed=true', async () => {
    const onFilterChange = vi.fn();
    render(
      <HistoryToolbar
        entries={[]}
        filter="all"
        onFilterChange={onFilterChange}
        counts={{ all: 0, jpyc: 0, usdc: 0 }}
      />,
    );
    expect(
      screen.getByRole('button', { name: /全て \(0\)/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: /JPYC \(0\)/ }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('button', { name: /USDC \(0\)/ }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('filter button クリックで onFilterChange が呼ばれる', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(
      <HistoryToolbar
        entries={[]}
        filter="all"
        onFilterChange={onFilterChange}
        counts={{ all: 3, jpyc: 2, usdc: 1 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /JPYC \(2\)/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith('jpyc');
    await user.click(screen.getByRole('button', { name: /USDC \(1\)/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith('usdc');
  });

  it('entries 空 → CSV / Clear ボタンが disabled', () => {
    render(
      <HistoryToolbar
        entries={[]}
        filter="all"
        onFilterChange={() => undefined}
        counts={{ all: 0, jpyc: 0, usdc: 0 }}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'CSV ダウンロード' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: '全て削除' })).toBeDisabled();
  });

  it('CSV button → toCsv + downloadBlob を呼ぶ', async () => {
    const user = userEvent.setup();
    const toCsvSpy = vi
      .spyOn(csvModule, 'toCsv')
      .mockReturnValue('csv-string');
    const downloadSpy = vi
      .spyOn(downloadModule, 'downloadBlob')
      .mockImplementation(() => undefined);

    const entries = [entry({ id: '1' }), entry({ id: '2' })];
    render(
      <HistoryToolbar
        entries={entries}
        filter="all"
        onFilterChange={() => undefined}
        counts={{ all: 2, jpyc: 2, usdc: 0 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'CSV ダウンロード' }));

    expect(toCsvSpy).toHaveBeenCalledWith(entries);
    expect(downloadSpy).toHaveBeenCalledOnce();
    const [blob, filename] = downloadSpy.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toMatch(/^openpay-history-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('Clear button → confirm true で clearHistory が呼ばれる', async () => {
    const user = userEvent.setup();
    const clearSpy = vi
      .spyOn(historyModule, 'clearHistory')
      .mockImplementation(() => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <HistoryToolbar
        entries={[entry()]}
        filter="all"
        onFilterChange={() => undefined}
        counts={{ all: 1, jpyc: 1, usdc: 0 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '全て削除' }));
    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it('Clear button → confirm false で clearHistory は呼ばれない', async () => {
    const user = userEvent.setup();
    const clearSpy = vi
      .spyOn(historyModule, 'clearHistory')
      .mockImplementation(() => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <HistoryToolbar
        entries={[entry()]}
        filter="all"
        onFilterChange={() => undefined}
        counts={{ all: 1, jpyc: 1, usdc: 0 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '全て削除' }));
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
