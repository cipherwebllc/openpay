import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const JPYC = 10n ** 18n;

const h = vi.hoisted(() => ({
  enableBilling: true,
  feeReceiverConfigured: true,
  account: { isConnected: true, chainId: 80002 as number | undefined },
  siwe: {
    isSignedIn: true,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null as Error | null,
  },
  invoice: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
  },
  pay: {
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
  switchChain: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      get enableBilling() {
        return h.enableBilling;
      },
      get enableUsageFee() {
        return h.enableBilling;
      },
      get feeReceiverConfigured() {
        return h.feeReceiverConfigured;
      },
    },
  };
});
vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useSwitchChain: () => ({ switchChain: h.switchChain, isPending: false }),
}));
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => h.siwe }));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => h.invoice,
}));
vi.mock('@/hooks/useUsageFeePayment', () => ({
  useUsageFeePayment: () => h.pay,
}));

import { OpenPayFeePanel } from '@/components/OpenPayFeePanel';

function renderPanel(locale: 'ja' | 'en' = 'ja') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <OpenPayFeePanel />
    </QueryClientProvider>,
    { locale },
  );
}

const invoiceData = (over?: Partial<Record<string, unknown>>) => ({
  feeCurrent: false,
  expiresAt: null,
  lastPaidPeriod: null,
  bypass: false,
  due: {
    period: '2026-07',
    count: 10,
    volumeWei: (10_000n * JPYC).toString(),
    rateBps: 100,
    feeWei: (100n * JPYC).toString(),
    free: false,
  },
  current: {
    period: '2026-08',
    count: 3,
    volumeWei: (3_000n * JPYC).toString(),
    rateBps: 100,
    feeWei: (30n * JPYC).toString(),
    free: false,
  },
  owed: [], // 既定は単一 due フロー (owed 一覧を出さない)
  ...over,
});

// 未払い行のヘルパ (owed 一覧テスト用)。
const owedLine = (period: string, jpyc: bigint) => ({
  period,
  count: 5,
  volumeWei: (jpyc * 100n * JPYC).toString(), // feeWei = jpyc になるよう逆算 (1%)
  rateBps: 100,
  feeWei: (jpyc * JPYC).toString(),
  free: false,
});

beforeEach(() => {
  h.enableBilling = true;
  h.feeReceiverConfigured = true;
  h.account = { isConnected: true, chainId: 80002 };
  h.siwe = {
    isSignedIn: true,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null,
  };
  h.invoice = { data: invoiceData(), isLoading: false, isError: false };
  h.pay = { mutateAsync: vi.fn(), isPending: false, isError: false, error: null };
});

describe('OpenPayFeePanel', () => {
  it('billing OFF (アルファ) → 無料表示・請求 UI を出さない', () => {
    h.enableBilling = false;
    renderPanel();
    expect(screen.getByText(/アルファ期間中は無料/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支払う/ })).toBeNull();
  });

  it('billing ON・未接続 → ウォレット接続を促す', () => {
    h.account = { isConnected: false, chainId: undefined };
    renderPanel();
    expect(screen.getByText(/ウォレットを接続してください/)).toBeInTheDocument();
  });

  it('billing ON・ログイン済・前月請求あり → 利用料額と支払いボタン', () => {
    renderPanel();
    expect(screen.getByText(/利用料 100 JPYC/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /100 JPYC を支払う/ }),
    ).toBeInTheDocument();
  });

  it('前月請求が無い (free) → 支払い不要表示', () => {
    h.invoice = {
      data: invoiceData({
        due: {
          period: '2026-07',
          count: 0,
          volumeWei: '0',
          rateBps: 0,
          feeWei: '0',
          free: true,
        },
      }),
      isLoading: false,
      isError: false,
    };
    renderPanel();
    expect(screen.getByText(/現在お支払いいただく利用料はありません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支払う/ })).toBeNull();
  });

  it('支払い済み → 有効期限表示・支払いボタンなし', () => {
    h.invoice = {
      data: invoiceData({ feeCurrent: true, expiresAt: Date.UTC(2026, 8, 1) }),
      isLoading: false,
      isError: false,
    };
    renderPanel();
    expect(screen.getByText(/お支払い済みです/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支払う/ })).toBeNull();
  });

  it('支払いボタン押下で 送金(value のみ)→/api/billing/settle を起動', async () => {
    h.pay = {
      mutateAsync: vi.fn(async () => ({
        txHash: '0xabc',
        success: true,
        pending: false,
      })),
      isPending: false,
      isError: false,
      error: null,
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, expiresAt: 1 }), { status: 200 }),
      );
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /100 JPYC を支払う/ }));
    // 利用料支払いは value のみ (宛先 FEE_RECEIVER は hook 内固定)。
    expect(h.pay.mutateAsync).toHaveBeenCalledWith({ value: 100n * JPYC });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/billing/settle',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
  });

  it('未ログイン → サインインボタンを押すと signIn 起動', async () => {
    h.siwe = {
      isSignedIn: false,
      isSigningIn: false,
      mismatch: false,
      signIn: vi.fn(async () => undefined),
      signInError: null,
    };
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /サインイン/ }));
    expect(h.siwe.signIn).toHaveBeenCalled();
  });

  it('ウォレット不一致 (mismatch) → 警告表示・支払いボタンを出さない', () => {
    h.siwe = { ...h.siwe, isSignedIn: true, mismatch: true };
    renderPanel();
    expect(screen.getByText(/一致しません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支払う/ })).toBeNull();
  });

  it('JPYC 非対応チェーン → チェーン切替ボタン (支払い不可)', () => {
    h.account = { isConnected: true, chainId: 1 }; // Ethereum mainnet (JPYC 非対応)
    renderPanel();
    expect(screen.getByRole('button', { name: /切り替え/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支払う/ })).toBeNull();
  });

  it('インボイス読込中 → loading 表示', () => {
    h.invoice = { data: undefined, isLoading: true, isError: false };
    renderPanel();
    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it('インボイス取得失敗 → loadError 表示', () => {
    h.invoice = { data: undefined, isLoading: false, isError: true };
    renderPanel();
    expect(screen.getByText(/取得に失敗/)).toBeInTheDocument();
  });

  it('relay pending → 再送・清算せず確定待ちを表示 (二重支払い防止)', async () => {
    h.pay = {
      mutateAsync: vi.fn(async () => ({ txHash: '0xp', success: false, pending: true })),
      isPending: false,
      isError: false,
      error: null,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /100 JPYC を支払う/ }));
    await waitFor(() =>
      expect(screen.getByText(/確定待ち/)).toBeInTheDocument(),
    );
    expect(fetchSpy).not.toHaveBeenCalled(); // settle しない
    fetchSpy.mockRestore();
  });

  it('owed が複数 → 期間別の一覧 + 各月の支払いボタンを描画', () => {
    h.invoice = {
      data: invoiceData({
        feeCurrent: false,
        owed: [owedLine('2026-07', 100n), owedLine('2026-05', 50n)],
      }),
      isLoading: false,
      isError: false,
    };
    renderPanel();
    // 一覧見出し (件数入り)。
    expect(screen.getByText(/未払いの利用料が 2 件あります/)).toBeInTheDocument();
    // 各月の金額・支払いボタン。
    expect(
      screen.getByRole('button', { name: /100 JPYC を支払う/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /50 JPYC を支払う/ }),
    ).toBeInTheDocument();
    // 期間が両方表示される。
    expect(screen.getByText(/2026-07/)).toBeInTheDocument();
    expect(screen.getByText(/2026-05/)).toBeInTheDocument();
  });

  it('owed 複数: 古い月のボタン押下で その period 指定で settle が発火', async () => {
    h.pay = {
      mutateAsync: vi.fn(async () => ({
        txHash: '0xold',
        success: true,
        pending: false,
      })),
      isPending: false,
      isError: false,
      error: null,
    };
    h.invoice = {
      data: invoiceData({
        feeCurrent: false,
        owed: [owedLine('2026-07', 100n), owedLine('2026-05', 50n)],
      }),
      isLoading: false,
      isError: false,
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, expiresAt: 1 }), { status: 200 }),
      );
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPanel();
    // 古い月 (2026-05・50 JPYC) を支払う。
    await userEvent.click(screen.getByRole('button', { name: /50 JPYC を支払う/ }));
    expect(h.pay.mutateAsync).toHaveBeenCalledWith({ value: 50n * JPYC });
    // settle に period=2026-05 が渡る。
    await waitFor(() => {
      const settleCall = fetchSpy.mock.calls.find(
        (c) => c[0] === '/api/billing/settle',
      );
      expect(settleCall).toBeTruthy();
      const body = JSON.parse((settleCall![1] as RequestInit).body as string);
      expect(body.period).toBe('2026-05');
      expect(body.txHash).toBe('0xold');
    });
    fetchSpy.mockRestore();
  });

  it('settle 失敗 → 再送金せず「確認を再試行」(同 txHash で settle のみ再実行)', async () => {
    h.pay = {
      mutateAsync: vi.fn(async () => ({
        txHash: '0xabc',
        success: true,
        pending: false,
      })),
      isPending: false,
      isError: false,
      error: null,
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'verify_unavailable' }), {
          status: 503,
        }),
      );
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /100 JPYC を支払う/ }));
    // settle 失敗 → 再試行ボタンが出る。
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /確認を再試行/ })).toBeInTheDocument(),
    );
    expect(h.pay.mutateAsync).toHaveBeenCalledTimes(1); // 送金は 1 回
    // 再試行は settle のみ (再送金しない)。
    await userEvent.click(screen.getByRole('button', { name: /確認を再試行/ }));
    expect(h.pay.mutateAsync).toHaveBeenCalledTimes(1); // 送金は増えない
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/billing/settle').length).toBe(2);
    fetchSpy.mockRestore();
  });
});
