import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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
  // switchChain の呼び出しと、押したときの失敗 (tests/_helpers/switchChainStub.ts)。
  switch: { switchChain: vi.fn(), error: null as Error | null, hold: false, release: () => {} },
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
vi.mock('wagmi', async () => {
  const { useSwitchChainStub } = await import('../_helpers/switchChainStub');
  return {
    useAccount: () => h.account,
    useSwitchChain: () => useSwitchChainStub(h.switch),
  };
});
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => h.siwe }));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => h.invoice,
}));
vi.mock('@/hooks/useUsageFeePayment', () => ({
  useUsageFeePayment: () => h.pay,
}));

import { OpenPayFeePanel } from '@/components/OpenPayFeePanel';
import { logger } from '@/lib/logger';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

function renderPanel(locale: 'ja' | 'en' = 'ja') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <OpenPayFeePanel />
    </QueryClientProvider>
  );
  const r = renderWithIntl(ui(), { locale });
  // 同じ QueryClient のまま描き直す (パネルの状態を保ったまま、接続などの変化を見る)。
  return { ...r, rerender: () => r.rerender(ui()) };
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
  h.switch.switchChain.mockReset();
  h.switch.error = null;
  h.switch.hold = false;
  h.switch.release = () => {};
});

describe('OpenPayFeePanel', () => {
  it('billing OFF → per-tx 1% 表示・月次請求 UI を出さない', () => {
    h.enableBilling = false;
    renderPanel();
    expect(screen.getByText(/決済額の 1%・最低 2 JPYC を決済時に申し受け/)).toBeInTheDocument();
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

// 第 9 回レビュー F-03: 「… に切り替える」が失敗したら (ウォレットでの取り消しを除く)、ボタンの下に知らせ、
// 記録 (logger.warn wallet.switch_chain_failed) に残す (#992 の支払い画面と同じ)。
describe('OpenPayFeePanel チェーンの切り替えの失敗', () => {
  const jpyc = defaultDeploymentForSymbol('jpyc');
  const notice = `${jpyc.name} に切り替えられませんでした。ウォレットのアプリで ${jpyc.name} を選んでから、もう一度お試しください。`;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    h.account = { isConnected: true, chainId: 1 }; // Ethereum mainnet (JPYC 非対応)
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('切り替えが失敗したら、ボタンの下に知らせを出し、どの画面か・目的のチェーンを記録する', async () => {
    const error = new Error('Unrecognized chain ID "0x13882".');
    h.switch.error = error;
    renderPanel();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /切り替え/ }));
    expect(h.switch.switchChain).toHaveBeenCalledWith({ chainId: jpyc.chainId });
    expect(await screen.findByRole('alert')).toHaveTextContent(notice);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'wallet.switch_chain_failed',
      expect.objectContaining({ surface: 'fee-panel', chainId: jpyc.chainId, error }),
    );
  });

  it('en でも同じ知らせを出す (UsageFee にキーがある)', async () => {
    h.switch.error = new Error('Unrecognized chain ID "0x13882".');
    renderPanel('en');
    fireEvent.click(screen.getByRole('button', { name: /Switch to/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Couldn’t switch to ${jpyc.name}. Select ${jpyc.name} in your wallet app, then try again.`,
    );
  });

  it('ウォレットで取り消した (user rejected) なら、知らせず記録もしない', async () => {
    h.switch.error = new Error('User rejected the request.');
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /切り替え/ }));
    // fireEvent は act の中で走る = 失敗の描画と記録の effect はここまでに済んでいる。
    expect(h.switch.switchChain).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('owed が複数で「… に切り替える」が期間ごとに並んでも、知らせは 1 つだけ', async () => {
    h.invoice = {
      data: invoiceData({
        feeCurrent: false,
        owed: [owedLine('2026-07', 100n), owedLine('2026-05', 50n)],
      }),
      isLoading: false,
      isError: false,
    };
    h.switch.error = new Error('Unrecognized chain ID "0x13882".');
    renderPanel();
    const buttons = screen.getAllByRole('button', { name: /切り替え/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent(notice);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('切り替えの待ちの間はボタンを押せない・失敗の後に押し直したら、前の知らせを消す', () => {
    const button = () => screen.getByRole('button', { name: /切り替え/ });
    h.switch.error = new Error('Unrecognized chain ID "0x13882".');
    renderPanel();
    fireEvent.click(button());
    expect(screen.getByRole('alert')).toHaveTextContent(notice);
    // 押し直す: ウォレットの応答を待つ間 (pending) は押せず、前の失敗の知らせは出さない。
    h.switch.hold = true;
    h.switch.error = null;
    fireEvent.click(button());
    expect(button()).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    // 今度は失敗しなかった → 押せるように戻り、知らせも出ない。記録は最初の失敗の 1 回だけ。
    act(() => h.switch.release());
    expect(button()).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('失敗の後に接続を切ったら、知らせを消す', () => {
    h.switch.error = new Error('Unrecognized chain ID "0x13882".');
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /切り替え/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(notice);
    h.account = { isConnected: false, chainId: undefined };
    rerender();
    expect(screen.getByText('ウォレットを接続してください。')).toBeInTheDocument();
    // 切断中も「… に切り替える」は残る (チェーンが分からない) が、失敗の知らせは出さない。
    expect(screen.getByRole('button', { name: /切り替え/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
