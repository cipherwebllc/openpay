import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HistoryEntry } from '@/lib/history';

// useSiweSession / useFreee は wagmi + React Query 境界。hoisted な可変ホルダで mock し、
// 各 test で状態を差し替える。連携の実通信は route/lib test (freee/freeeSync) で担保。
const h = vi.hoisted(() => ({
  siwe: { isSignedIn: false } as { isSignedIn: boolean },
  status: {} as Record<string, unknown>,
  mappingOpts: {} as Record<string, unknown>,
  sync: {} as Record<string, unknown>,
  save: {} as Record<string, unknown>,
  entitlement: {} as Record<string, unknown>,
}));

vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => h.siwe }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => h.entitlement }));
vi.mock('@/hooks/useFreee', () => ({
  useFreeeStatus: () => h.status,
  useFreeeMappingOptions: () => h.mappingOpts,
  useFreeeMutations: () => ({ saveMapping: h.save, sync: h.sync }),
}));

import { FreeeSyncPanel } from '@/components/FreeeSyncPanel';

function income(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: 'i-' + Math.random().toString(36).slice(2),
    ts: Date.now(),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xT',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xM',
    merchantAmount: '1000000000000000000000',
    customer: '0xC',
    feeReceiver: '0xF',
    feeAmount: '0',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
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

beforeEach(() => {
  h.siwe = { isSignedIn: false };
  h.status = { isLoading: false, isError: false, data: null };
  h.mappingOpts = { isLoading: false, isError: false, data: null };
  h.sync = {
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    data: undefined,
  };
  h.save = {
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
  };
  // 既定 entitled (アルファ bypass 相当)。
  h.entitlement = { data: { entitled: true, expiresAt: null, bypass: true } };
});

describe('FreeeSyncPanel', () => {
  it('未ログイン → ウォレットログイン案内', () => {
    h.siwe = { isSignedIn: false };
    renderWithIntl(<FreeeSyncPanel entries={[]} usdcJpy={150} />);
    expect(screen.getByText(/ウォレットでのログインが必要/)).toBeInTheDocument();
  });

  it('ログイン済・未連携 → 「freee と連携する」ボタン', () => {
    h.siwe = { isSignedIn: true };
    h.status = { isLoading: false, isError: false, data: { connected: false } };
    renderWithIntl(<FreeeSyncPanel entries={[]} usdcJpy={150} />);
    expect(
      screen.getByRole('button', { name: 'freee と連携する' }),
    ).toBeInTheDocument();
  });

  it('連携済・未マッピング → 勘定科目/税区分 の編集 UI + 保存', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: false, companyName: 'テスト商店' },
    };
    h.mappingOpts = {
      isLoading: false,
      isError: false,
      data: {
        accountItems: [{ id: 1, name: '売上高' }],
        taxCodes: [{ code: 21, name: '課税売上10%' }],
        mapping: null,
      },
    };
    renderWithIntl(<FreeeSyncPanel entries={[]} usdcJpy={150} />);
    expect(screen.getByText('テスト商店', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('売上の勘定科目')).toBeInTheDocument();
    expect(screen.getByText('税区分')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '設定を保存' })).toBeInTheDocument();
  });

  it('連携済・未マッピング → 売上高/課税売上10% を名前一致で自動推定 (初期選択)', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: false, companyName: 'X' },
    };
    h.mappingOpts = {
      isLoading: false,
      isError: false,
      data: {
        accountItems: [
          { id: 1, name: '現金' },
          { id: 2, name: '売上高' },
          { id: 3, name: '雑収入' },
        ],
        taxCodes: [
          { code: 1, name: '対象外' },
          { code: 21, name: '課税売上10%' },
        ],
        mapping: null,
      },
    };
    renderWithIntl(<FreeeSyncPanel entries={[]} usdcJpy={150} />);
    // select の初期値が推定値 (売上高=2 / 課税売上10%=21) になっている
    expect(
      (screen.getByRole('combobox', { name: '売上の勘定科目' }) as HTMLSelectElement).value,
    ).toBe('2');
    expect(
      (screen.getByRole('combobox', { name: '税区分' }) as HTMLSelectElement).value,
    ).toBe('21');
  });

  it('マッピング保存が失敗 → エラー文言を表示 (silent にしない)', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: false, companyName: 'X' },
    };
    h.mappingOpts = {
      isLoading: false,
      isError: false,
      data: {
        accountItems: [{ id: 1, name: '売上高' }],
        taxCodes: [{ code: 21, name: '課税売上10%' }],
        mapping: null,
      },
    };
    h.save = { mutateAsync: vi.fn(), isPending: false, isError: true };
    renderWithIntl(<FreeeSyncPanel entries={[]} usdcJpy={150} />);
    expect(screen.getByText(/エラーが発生しました/)).toBeInTheDocument();
  });

  it('連携済・マッピング済 → 「freee に同期 (N 件)」click で sync.mutateAsync', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: true, companyName: 'X' },
    };
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    h.sync = { mutateAsync, isPending: false, isError: false, error: null, data: undefined };
    const entries = [income({ id: 'a' }), income({ id: 'b' })];
    renderWithIntl(<FreeeSyncPanel entries={entries} usdcJpy={150} />);
    const btn = screen.getByRole('button', { name: /freee に同期 \(2 件\)/ });
    fireEvent.click(btn);
    expect(mutateAsync).toHaveBeenCalledWith({ entries, usdcJpy: 150 });
  });

  it('同期結果 → 件数サマリを表示', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: true, companyName: 'X' },
    };
    h.sync = {
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
      data: { synced: 3, skipped: 1, errored: 0, rateUnavailable: 0, items: [] },
    };
    renderWithIntl(<FreeeSyncPanel entries={[income()]} usdcJpy={150} />);
    expect(screen.getByText(/同期 3 件・スキップ済 1 件・失敗 0 件/)).toBeInTheDocument();
  });

  it('利用権なし (bypass off) → 同期ボタンを出さず利用権案内', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: true, companyName: 'X' },
    };
    h.entitlement = { data: { entitled: false, expiresAt: null, bypass: false } };
    renderWithIntl(<FreeeSyncPanel entries={[income()]} usdcJpy={150} />);
    expect(screen.getByText(/利用権が必要/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /freee に同期/ })).toBeNull();
  });

  it('income が無い → 同期ボタン disabled + noIncome 注記', () => {
    h.siwe = { isSignedIn: true };
    h.status = {
      isLoading: false,
      isError: false,
      data: { connected: true, mappingSet: true, companyName: 'X' },
    };
    // revert のみ (income-sale でない)
    renderWithIntl(
      <FreeeSyncPanel entries={[income({ status: 'reverted' })]} usdcJpy={150} />,
    );
    expect(
      (screen.getByRole('button', { name: /freee に同期 \(0 件\)/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/同期できる売上/)).toBeInTheDocument();
  });
});
