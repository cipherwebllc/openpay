import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

// CSV 24時間パスの CSV ゲートを HistoryView 上で検証する (Codex 不変条件 #8・旧 HistoryViewProGate を移行)。
//   csvLocked = a1Locked || passLocked (独立合成)
//   passLocked = enableCsvPass && !resolving && active!==true  (**未サインインもロック** = 購入導線を出す)
// 各状態 (両 off / a1 のみ / パスのみ / 保持済 / 両方 / 未サインイン / 読込中) で CSV ロックを確認し、
// パスゲートでは履歴閲覧を **ぼかさない** (a1 の blur とは別系統) ことを実 HistoryView で確認する。

vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/FreeeSyncPanel', () => ({ FreeeSyncPanel: () => null }));
// CsvPassPaywall は wagmi/React Query を引くので boundary mock (描画有無のみ assert する)。
vi.mock('@/components/CsvPassPaywall', () => ({
  CsvPassPaywall: () => <div data-testid="csvpass-paywall">CSVPASS_PAYWALL</div>,
}));

const flags = vi.hoisted(() => ({ enableUsageFee: false, enableCsvPass: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableUsageFee() {
        return flags.enableUsageFee;
      },
      get enableCsvPass() {
        return flags.enableCsvPass;
      },
      get enableFreeeSync() {
        return false;
      },
    },
  };
});

const siweHold = vi.hoisted(() => ({ isSignedIn: true, isLoading: false }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: siweHold.isSignedIn,
    isLoading: siweHold.isLoading,
    mismatch: false,
  }),
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

const passHold = vi.hoisted(() => ({
  active: false as boolean | undefined,
  isLoading: false,
  // 実 react-query は query を disable しても前回 data をキャッシュに残す。retainWhenDisabled で
  // 「サインアウト後も旧 wallet の {active:true} が残る」状態を再現し、ゲートが leak しないか検証する。
  retainWhenDisabled: false,
}));
vi.mock('@/hooks/useCsvPassStatus', () => ({
  useCsvPassStatus: (enabled: boolean) => ({
    data:
      enabled || passHold.retainWhenDisabled
        ? { active: passHold.active, expiresAt: null, bypass: false }
        : undefined,
    isLoading: passHold.isLoading,
  }),
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
    id: 'csvpass-gate-1',
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
  flags.enableCsvPass = false;
  invoiceHold.delinquent = false;
  passHold.active = false;
  passHold.isLoading = false;
  passHold.retainWhenDisabled = false;
  siweHold.isSignedIn = true;
  siweHold.isLoading = false;
  entryHold.entries = [makeEntry()];
});

describe('HistoryView CSV パスゲート (4 状態 × 閲覧非ぼかし)', () => {
  it('両 off → CSV 無料 (ボタン有効)・CsvPassPaywall 非表示・閲覧ぼかしなし', () => {
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByTestId('csvpass-paywall')).toBeNull();
    // 集計 (HistorySummary) が aria-hidden の blur ラッパに入っていない (閲覧フル開放)。
    expect(document.querySelector('.blur-sm')).toBeNull();
  });

  it('a1 のみ (延滞) → CSV ロック + 閲覧ぼかし (従来挙動)・CsvPassPaywall は出ない', () => {
    flags.enableUsageFee = true;
    invoiceHold.delinquent = true;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    // a1 延滞は履歴をぼかす (blur ラッパ存在)。
    expect(document.querySelector('.blur-sm')).not.toBeNull();
    // a1 優先なので CSV パス paywall は出さない。
    expect(screen.queryByTestId('csvpass-paywall')).toBeNull();
  });

  it('パスのみ (未保持) → CSV ロック + CsvPassPaywall 表示・閲覧は非ぼかし', () => {
    flags.enableCsvPass = true;
    passHold.active = false;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByTestId('csvpass-paywall')).toBeInTheDocument();
    // パスゲートは閲覧をぼかさない (blur ラッパなし)。
    expect(document.querySelector('.blur-sm')).toBeNull();
  });

  it('パス保持済 → CSV 無料 (ボタン有効)・CsvPassPaywall 非表示', () => {
    flags.enableCsvPass = true;
    passHold.active = true;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByTestId('csvpass-paywall')).toBeNull();
  });

  it('パスのみ・未サインイン → CSV ロック + CsvPassPaywall 表示 (購入導線が出る)', () => {
    // 回帰防止: 旧実装は passLocked に isSignedIn を要求し、サインイン入口がパネル内にしか
    // 無いため未サインインだとゲートが永久に不到達だった。未サインインでもロックして導線を出す。
    flags.enableCsvPass = true;
    siweHold.isSignedIn = false;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByTestId('csvpass-paywall')).toBeInTheDocument();
    // パスゲートは閲覧をぼかさない。
    expect(document.querySelector('.blur-sm')).toBeNull();
  });

  it('サインアウト後に旧 wallet の active=true がキャッシュに残っていてもロックする (Codex 回帰)', () => {
    // react-query は disable 後も前回 data を残す。`data?.active !== true` だけだと保持者がサインアウト
    // しても CSV が開いたままになる。`!isSignedIn` で signed-out を明示ロックしているか検証する。
    flags.enableCsvPass = true;
    siweHold.isSignedIn = false;
    passHold.retainWhenDisabled = true; // disabled でも data 残存
    passHold.active = true; // 旧 wallet の active=true が残る
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByTestId('csvpass-paywall')).toBeInTheDocument();
  });

  it('パス on・status 読込中 (サインイン済) → ロック保留で CSV 据え置き (点滅防止)', () => {
    flags.enableCsvPass = true;
    passHold.isLoading = true;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByTestId('csvpass-paywall')).toBeNull();
  });

  it('パス on・セッション確認中 → ロック保留 (点滅防止)', () => {
    flags.enableCsvPass = true;
    siweHold.isLoading = true;
    siweHold.isSignedIn = false;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByTestId('csvpass-paywall')).toBeNull();
  });

  it('両方 (a1 延滞 + パス未保持) → CSV ロック + a1 ぼかし・a1 優先で CsvPassPaywall は出ない', () => {
    flags.enableUsageFee = true;
    invoiceHold.delinquent = true;
    flags.enableCsvPass = true;
    passHold.active = false;
    render(<HistoryView />);
    expect(exportButton().disabled).toBe(true);
    expect(document.querySelector('.blur-sm')).not.toBeNull(); // a1 ぼかし
    expect(screen.queryByTestId('csvpass-paywall')).toBeNull(); // a1 優先
  });
});
