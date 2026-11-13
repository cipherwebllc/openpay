// 伏せる前の版が localStorage に残した error の文 (key つきの URL・送った request の本文の先頭) が、履歴の画面と、
// 画面の「CSV ダウンロード」の中身に出ないこと。HistoryView を本物の読み込み (useHistory → loadHistory) で描く。
// mock は境界だけ (HistoryView.test.tsx と同じ・履歴の読み込みと HistoryRow と toCsv は本物)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/FreeeSyncPanel', () => ({
  FreeeSyncPanel: () => null,
}));
vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () => ({ isConnected: false }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: false, mismatch: false }),
}));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useCsvPassStatus', () => ({
  useCsvPassStatus: () => ({ data: undefined }),
}));

import { HistoryView } from '@/components/HistoryView';
import * as downloadModule from '@/lib/download';
import {
  buildHistoryEntry,
  HISTORY_ERROR_MESSAGE_MAX_LENGTH,
  HISTORY_STORAGE_KEY,
  type HistoryEntry,
} from '@/lib/history';
import { BUNDLER_ORIGIN, leakedMarkers, VIEM_ERROR_CASES } from '../helpers/viemRequestErrors';

// jsdom の Blob には .text() が無いため FileReader で実内容を読み出す。
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** 伏せる前の版が保存した形 (errorMessage は元の文の先頭 500 字そのまま)。 */
function storedByOldBuild(message: string): HistoryEntry {
  return {
    ...buildHistoryEntry({
      flow: 'batch',
      status: 'error',
      chainId: 137,
      chainSlug: 'polygon',
      asset: 'jpyc',
      tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
      payMode: 'gasless',
      gasMode: 'customer',
      merchant: '0xMerchant',
      merchantAmount: 1_000_000_000_000_000_000n,
      customer: '0xCustomer',
      feeReceiver: '0xFee',
      feeAmount: 10_000_000_000_000_000n,
      txHash: null,
      userOpHash: null,
      blockNumber: null,
      errorMessage: null,
      storeName: 'Test Store',
      ts: 1_700_000_000_000,
    }),
    id: 'old-build-failed-payment',
    errorMessage: message.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH),
  };
}

describe('HistoryView: 保存済みの古い履歴の error の文', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(VIEM_ERROR_CASES)('%s: 画面と CSV に、key つきの URL と Request body の中身を出さない', async (_name, make) => {
    const old = storedByOldBuild(make().message);
    expect(leakedMarkers(old.errorMessage)).not.toEqual([]);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([old]));
    const downloadSpy = vi.spyOn(downloadModule, 'downloadBlob').mockImplementation(() => undefined);

    const { container } = render(<HistoryView />);

    // error の文は出ている (origin と、伏せた印)。出なくなって緑になるテストにしない。
    expect(await screen.findByText(new RegExp(`URL: ${BUNDLER_ORIGIN}\\s+Request body: \\[redacted\\]`))).toBeInTheDocument();
    expect(leakedMarkers(container.innerHTML)).toEqual([]);

    await userEvent.setup().click(screen.getByRole('button', { name: 'CSV ダウンロード' }));
    expect(downloadSpy).toHaveBeenCalledOnce();
    const csv = await readBlobText(downloadSpy.mock.calls[0]![0]);
    expect(csv).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
    expect(leakedMarkers(csv)).toEqual([]);
  });
});
