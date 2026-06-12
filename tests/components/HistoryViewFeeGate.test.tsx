import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

// a1 OpenPay 利用料の **延滞ゲート** を HistoryView 上で検証する。
// 延滞 (signed-in + enableUsageFee + invoice.delinquent=true) のとき、履歴をぼかし
// (overlay に支払い導線) + 会計CSV をロックすることを実 HistoryView で確認する。
// (delinquent 判定そのものは server 権威 = billing-integration.test で検証済。)

vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/FreeeSyncPanel', () => ({ FreeeSyncPanel: () => null }));
// CSV パスゲートは本 test では OFF (enableCsvPass 未上書き=false)。useCsvPassStatus (React Query) を
// boundary mock して passLocked=false に固定する (a1 延滞ぼかしの検証に集中)。
vi.mock('@/hooks/useCsvPassStatus', () => ({
  useCsvPassStatus: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: true, mismatch: false }),
}));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => ({
    data: {
      feeCurrent: false,
      expiresAt: null,
      lastPaidPeriod: null,
      bypass: false,
      delinquent: true, // ← 延滞
      graceEndsAt: Date.UTC(2026, 6, 8),
      due: {
        period: '2026-05',
        count: 3,
        volumeWei: (10_000n * 10n ** 18n).toString(),
        rateBps: 100,
        feeWei: (100n * 10n ** 18n).toString(),
        free: false,
      },
      current: {
        period: '2026-06',
        count: 1,
        volumeWei: (1n * 10n ** 18n).toString(),
        rateBps: 100,
        feeWei: '0',
        free: false,
      },
    },
  }),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableUsageFee() {
        return true;
      },
      get enableFreeeSync() {
        return false;
      },
    },
  };
});

import type { HistoryEntry } from '@/lib/history';

const entryHold = vi.hoisted(() => ({ entries: [] as HistoryEntry[] }));
vi.mock('@/hooks/useHistory', () => ({
  useHistory: () => ({ entries: entryHold.entries, hydrated: true }),
}));
vi.mock('@/hooks/usePayerReceipts', () => ({
  usePayerReceipts: () => ({ receipts: [], hydrated: true }),
}));

import { HistoryView } from '@/components/HistoryView';

function makeEntry(): HistoryEntry {
  return {
    schemaVersion: 1,
    id: 'feegate-1',
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xT',
    txHash: '0xTx',
    userOpHash: null,
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10000000000000000',
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
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
  };
}

describe('HistoryView — a1 延滞ゲート', () => {
  beforeEach(() => {
    window.localStorage.clear();
    entryHold.entries = [makeEntry()];
  });

  it('延滞時: 支払い誘導オーバーレイ + 会計CSV ロックが出る', async () => {
    render(<HistoryView />);

    // ぼかしオーバーレイの見出し + 本文 + /billing への支払い導線。
    expect(
      await screen.findByText(/OpenPay 利用料のお支払いで表示されます/),
    ).toBeInTheDocument();
    const payLink = screen.getByRole('link', { name: /利用料を支払う/ });
    expect(payLink).toHaveAttribute('href', '/ja/billing');

    // CSV はロック (toolbar に csvLockedNote)。
    expect(
      screen.getByText(/会計CSVのダウンロードを一時的に制限/),
    ).toBeInTheDocument();
  });
});
