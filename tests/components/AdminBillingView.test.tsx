import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const JPYC = 10n ** 18n;

const h = vi.hoisted(() => ({
  account: { isConnected: true },
  siwe: {
    isSignedIn: true,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null as Error | null,
  },
}));

vi.mock('wagmi', () => ({ useAccount: () => h.account }));
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => h.siwe }));

import { AdminBillingView } from '@/components/AdminBillingView';

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <AdminBillingView />
    </QueryClientProvider>,
    { locale: 'ja' },
  );
}

const okBody = {
  ok: true,
  totalWei: (100n * JPYC).toString(),
  count: 1,
  byBilledPeriod: [{ period: '2026-06', count: 1, feeWei: (100n * JPYC).toString() }],
  reconciliation: {
    period: '2026-06',
    rows: [
      { merchant: '0x000000000000000000000000000000000000000a', billedFeeWei: (100n * JPYC).toString(), paid: true, txHash: '0xpaid', paidAtMs: Date.UTC(2026, 6, 3) },
      { merchant: '0x000000000000000000000000000000000000000b', billedFeeWei: (40n * JPYC).toString(), paid: false, txHash: null, paidAtMs: null },
    ],
  },
  payments: [
    { m: '0x000000000000000000000000000000000000000a', p: '2026-06', v: (100n * JPYC).toString(), c: 80002, t: Date.UTC(2026, 6, 3), h: '0x' + 'a'.repeat(64) },
  ],
};

beforeEach(() => {
  h.account = { isConnected: true };
  h.siwe = { isSignedIn: true, isSigningIn: false, mismatch: false, signIn: vi.fn(async () => undefined), signInError: null };
});

describe('AdminBillingView', () => {
  it('未接続 → 接続を促す', () => {
    h.account = { isConnected: false };
    render();
    expect(screen.getByText(/ウォレットを接続してください/)).toBeInTheDocument();
  });

  it('未ログイン → サインインボタン', async () => {
    h.siwe = { ...h.siwe, isSignedIn: false };
    const { default: userEvent } = await import('@testing-library/user-event');
    render();
    const btn = screen.getByRole('button', { name: /サインインして収益を確認/ });
    await userEvent.click(btn);
    expect(h.siwe.signIn).toHaveBeenCalled();
  });

  it('admin 200 → 合計・照合(入金済/未入金)・CSV リンク', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(okBody), { status: 200 }),
    );
    render();
    // ダッシュボード読込完了の signal = CSV リンク (loaded 状態でのみ描画)。
    const csv = await screen.findByRole('link', { name: /収益CSVをダウンロード/ });
    expect(csv).toHaveAttribute('href', '/api/admin/billing/revenue?format=freee');
    // 照合: 入金済み / 未入金 (単一テキストノード)。
    expect(screen.getByText('入金済み')).toBeInTheDocument();
    expect(screen.getByText('未入金')).toBeInTheDocument();
    // 合計額は "{n} JPYC" で text node が分割されるため textContent で確認。
    expect(document.body.textContent).toContain('100');
    vi.restoreAllMocks();
  });

  it('403 → 権限なし表示', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 }),
    );
    render();
    expect(
      await screen.findByText(/管理者権限がありません/),
    ).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
