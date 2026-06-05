import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

// wagmi / siwe / entitlement / billing-payment は外部境界。hoisted ホルダで状態を差し替える。
const h = vi.hoisted(() => ({
  account: { isConnected: false, chainId: undefined as number | undefined },
  siwe: {
    isSignedIn: false,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
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
  h.siwe = { isSignedIn: false, isSigningIn: false, mismatch: false, signIn: vi.fn(async () => undefined) };
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
  it('tier カード (ベーシック / 会計連携) と価格を表示', () => {
    renderPaywall();
    expect(screen.getByText('ベーシック')).toBeInTheDocument();
    expect(screen.getByText('会計連携')).toBeInTheDocument();
    expect(screen.getByText('¥300/月')).toBeInTheDocument();
    expect(screen.getByText('¥3000/月')).toBeInTheDocument();
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

  it('pro gate: requiredTier=pro なら basic カードは選択不可・支払いは pro 額 (過少支払い防止)', () => {
    h.account = { isConnected: true, chainId: AMOY };
    h.siwe = { ...h.siwe, isSignedIn: true };
    h.entitlement = {
      data: { entitled: false, tier: null, expiresAt: null, bypass: false },
    };
    renderPaywall('pro');
    // basic カードは disabled (pro gate で ¥300 を選ばせない)。"¥300/月" は basic カード固有
    // (pro は "¥3000/月"・支払いボタンは "¥3000 を…")。
    expect(
      (screen.getByRole('button', { name: /¥300\/月/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // 既定選択 = requiredTier(pro) → ¥3000 を支払う
    expect(
      screen.getByRole('button', { name: /¥3000 を JPYC で支払う/ }),
    ).toBeInTheDocument();
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
});
