import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

// wagmi / siwe / entitlement / billing-payment は外部境界。hoisted ホルダで状態を差し替える。
const h = vi.hoisted(() => ({
  account: { isConnected: false, chainId: undefined as number | undefined },
  feeReceiverConfigured: true,
  siwe: {
    isSignedIn: false,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null as Error | null,
  },
  entitlement: { data: undefined as unknown },
  pay: {
    pay: vi.fn(),
    reset: vi.fn(),
    phase: 'idle' as string,
    txHash: undefined as string | undefined,
    isSending: false,
    isMining: false,
    isConfirmed: false,
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
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => h.entitlement }));
vi.mock('@/hooks/useBillingPayment', () => ({ useBillingPayment: () => h.pay }));

import { BillingPaywall } from '@/components/BillingPaywall';

const AMOY = 80002; // testnet env の JPYC 対応 chain (resolveDeployment が解決)

function renderPaywall(requiredTier: 'basic' | 'pro' = 'basic') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <BillingPaywall requiredTier={requiredTier} />
    </QueryClientProvider>,
    { locale: 'ja' },
  );
}

beforeEach(() => {
  h.account = { isConnected: false, chainId: undefined };
  h.feeReceiverConfigured = true;
  h.siwe = {
    isSignedIn: false,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null,
  };
  h.entitlement = { data: undefined };
  h.pay = {
    pay: vi.fn(),
    reset: vi.fn(),
    phase: 'idle',
    txHash: undefined,
    isSending: false,
    isMining: false,
    isConfirmed: false,
    isError: false,
    error: null,
  };
  h.switchChain = vi.fn();
});

describe('BillingPaywall', () => {
  it('販売中の tier は basic のみ表示 (pro/会計連携 は販売せず非表示)', () => {
    renderPaywall();
    expect(screen.getByText('ベーシック')).toBeInTheDocument();
    expect(screen.getByText('¥300/月')).toBeInTheDocument();
    // freee は無料機能に変更したため pro(会計連携) カードは出さない。
    expect(screen.queryByText('会計連携')).toBeNull();
    expect(screen.queryByText('¥3000/月')).toBeNull();
  });

  it('未接続 → 接続案内を表示 (支払いボタンなし)', () => {
    renderPaywall();
    expect(screen.getByText(/ウォレットの接続が必要/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /で支払う/ })).toBeNull();
  });

  it('接続済・未ログイン → ログインボタン', () => {
    h.account = { isConnected: true, chainId: AMOY };
    renderPaywall();
    expect(
      screen.getByRole('button', { name: /ウォレットでログイン/ }),
    ).toBeInTheDocument();
  });

  it('FEE_RECEIVER 未設定 → 支払い/ログインを出さず設定不備の案内 (burn 送金防止)', () => {
    h.feeReceiverConfigured = false;
    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };
    renderPaywall();
    expect(screen.getByText(/お支払いを受け付けられません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /で支払う/ })).toBeNull();
  });

  it('ログイン失敗 (signInError) → エラー文言を表示 (silent にしない)', () => {
    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: false, signInError: new Error('user rejected') };
    renderPaywall();
    // ログインボタンは出しつつ、失敗を表示
    expect(
      screen.getByRole('button', { name: /ウォレットでログイン/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ログインに失敗しました/)).toBeInTheDocument();
  });

  it('ログイン済・JPYC チェーン → 支払いボタン (選択中 tier の額)', () => {
    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };
    renderPaywall('basic');
    // 既定選択 = requiredTier(basic) → ¥300 を JPYC で支払う
    expect(
      screen.getByRole('button', { name: /¥300 を JPYC で支払う/ }),
    ).toBeInTheDocument();
  });

  it('ログイン済だが非 JPYC チェーン → チェーン切替を促す', () => {
    h.account = { isConnected: true, chainId: 84532 }; // baseSepolia (USDC)
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };
    renderPaywall();
    expect(
      screen.getByRole('button', { name: /に切り替える/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /で支払う/ })).toBeNull();
  });

  it('支払い確定後は再送金ボタンを出さず再検証導線 (二重支払い防止)', () => {
    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };
    h.pay = { ...h.pay, isConfirmed: true, txHash: `0x${'a'.repeat(64)}` };
    renderPaywall('basic');
    // 「…で支払う」= 再送金ボタンは出ない
    expect(screen.queryByRole('button', { name: /で支払う/ })).toBeNull();
    // 代わりに既存 tx を再検証するボタン
    expect(screen.getByRole('button', { name: /再検証/ })).toBeInTheDocument();
  });

  it('支払いボタン押下で useBillingPayment.pay を呼ぶ', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };
    renderPaywall('basic');
    await user.click(screen.getByRole('button', { name: /¥300 を JPYC で支払う/ }));
    expect(h.pay.pay).toHaveBeenCalledOnce();
    const arg = h.pay.pay.mock.calls[0][0] as { amount: bigint; chainId: number };
    expect(arg.amount).toBe(300n * 10n ** 18n);
    expect(arg.chainId).toBe(AMOY);
  });

  it('統合: 支払い→確定で /api/fee/verify を locked tier/chain で叩き granted 表示', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, tier: 'basic', expiresAt: 1_900_000_000_000 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 毎回 fresh な element を返す (同一 element 参照だと React が再描画を bail out する)。
    const makeUi = () => (
      <QueryClientProvider client={qc}>
        <BillingPaywall requiredTier="basic" />
      </QueryClientProvider>
    );
    const { rerender } = renderWithIntl(makeUi(), { locale: 'ja' });

    // 1) 支払いボタン押下 → startPay が tier/chain を payCtxRef に固定
    await user.click(screen.getByRole('button', { name: /¥300 を JPYC で支払う/ }));

    // 2) 送金確定をシミュレート → 自動 verify (固定した tier/chain を使用)
    h.pay = { ...h.pay, isConfirmed: true, txHash: `0x${'a'.repeat(64)}` };
    rerender(makeUi());
    // 確定状態が伝播し、再送金ボタンは消えている (検証フェーズへ)
    expect(screen.queryByRole('button', { name: /で支払う/ })).toBeNull();

    // 3) 実 fetch が /api/fee/verify を叩き、本文に locked tier/chain/txHash
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('/api/fee/verify');
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({
      txHash: `0x${'a'.repeat(64)}`,
      chainId: AMOY,
      tier: 'basic',
    });

    // 4) 付与結果が表示される (実際の出力を検査)
    expect(await screen.findByText(/利用権を付与しました/)).toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
