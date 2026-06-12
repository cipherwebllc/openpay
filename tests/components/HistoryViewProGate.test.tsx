import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

// OpenPay Pro の CSV ゲートを HistoryView 上で検証する (Codex 不変条件 #8)。
//   csvLocked = a1Locked || proLocked (独立合成)
//   proLocked = enablePro && isSignedIn && !pro
// 4 状態 (両 off / a1 のみ / Pro のみ / 両方) で CSV ロックを確認し、Pro ゲートでは履歴閲覧を
// **ぼかさない** (a1 の blur とは別系統) ことを実 HistoryView で確認する。

vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/FreeeSyncPanel', () => ({ FreeeSyncPanel: () => null }));
// ProPaywall は wagmi/React Query を引くので boundary mock (描画有無のみ assert する)。
vi.mock('@/components/ProPaywall', () => ({
  ProPaywall: () => <div data-testid="pro-paywall">PRO_PAYWALL</div>,
}));

const flags = vi.hoisted(() => ({ enableUsageFee: false, enablePro: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableUsageFee() {
        return flags.enableUsageFee;
      },
      get enablePro() {
        return flags.enablePro;
      },
      get enableFreeeSync() {
        return false;
      },
    },
  };
});

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: true, mismatch: false }),
}));

const invoiceHold = vi.hoisted(() => ({ delinquent: false }));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => ({
    data: {
      feeCurrent: false,
      expiresAt: null,
      lastPaidPeriod: null,
      bypass: false,
      delinquent: invoiceHold.delinquent,
      graceEndsAt: Date.UTC(2026, 6, 8),
      due: {
        period: '2026-05',
        count: 3,
        volumeWei: '0',
        rateBps: 100,
        feeWei: '0',
        free: true,
      },
      current: {
        period: '2026-06',
        count: 1,
        volumeWei: '0',
        rateBps: 100,
        feeWei: '0',
        free: true,
      },
    },
  }),
}));

const proHold = vi.hoisted(() => ({ pro: false as boolean | undefined }));
vi.mock('@/hooks/useProStatus', () => ({
  useProStatus: () => ({ data: { pro: proHold.pro, expiresAt: null, bypass: false } }),
}));

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
    id: 'pro-gate-1',
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xT',
    txHash: '0xTx',
    userOpHash: null,
    blockNumber: '1',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
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

// CSV 系ボタン (履歴 CSV ダウンロード) を取得する。csvLocked のとき disabled になる。
function exportButton(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: 'CSV ダウンロード',
  }) as HTMLButtonElement;
}

beforeEach(() => {
  flags.enableUsageFee = false;
  flags.enablePro = false;
  invoiceHold.delinquent = false;
  proHold.pro = false;
  entryHold.entries = [makeEntry()];
});

describe('HistoryView Pro CSV ゲート (4 状態 × 閲覧非ぼかし)', () => {
  it('両 off → CSV 無料 (ボタン有効)・ProPaywall 非表示・閲覧ぼかしなし', () => {
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByTestId('pro-paywall')).toBeNull();
    // 集計 (HistorySummary) が aria-hidden の blur ラッパに入っていない (閲覧フル開放)。
    expect(document.querySelector('.blur-sm')).toBeNull();
  });

  it('a1 のみ (延滞) → CSV ロック + 閲覧ぼかし (従来挙動)・ProPaywall は出ない', () => {
    flags.enableUsageFee = true;
    invoiceHold.delinquent = true;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    // a1 延滞は履歴をぼかす (blur ラッパ存在)。
    expect(document.querySelector('.blur-sm')).not.toBeNull();
    // a1 優先なので Pro paywall は出さない。
    expect(screen.queryByTestId('pro-paywall')).toBeNull();
  });

  it('Pro のみ (未加入) → CSV ロック + ProPaywall 表示・閲覧は非ぼかし', () => {
    flags.enablePro = true;
    proHold.pro = false;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByTestId('pro-paywall')).toBeInTheDocument();
    // Pro ゲートは閲覧をぼかさない (blur ラッパなし)。
    expect(document.querySelector('.blur-sm')).toBeNull();
  });

  it('Pro 加入済 → CSV 無料 (ボタン有効)・ProPaywall 非表示', () => {
    flags.enablePro = true;
    proHold.pro = true;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByTestId('pro-paywall')).toBeNull();
  });

  it('両方 (a1 延滞 + Pro 未加入) → CSV ロック + a1 ぼかし・a1 優先で ProPaywall は出ない', () => {
    flags.enableUsageFee = true;
    invoiceHold.delinquent = true;
    flags.enablePro = true;
    proHold.pro = false;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    expect(document.querySelector('.blur-sm')).not.toBeNull(); // a1 ぼかし
    expect(screen.queryByTestId('pro-paywall')).toBeNull(); // a1 優先
  });
});
