import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Pro hook (useProSubscribe) の返り値 mock。Pro は **ガスありのみ** なので gasless 系フィールドは
// 持たない (EntitlementPaywall は supportsGasless=false でそれらを参照しない)。
const sub = vi.hoisted(() => ({
  start: vi.fn(),
  retrySubscribe: vi.fn(),
  isPaying: false,
  isSubscribing: false,
  isSuccess: false,
  isPayError: false,
  isSubscribeError: false,
  expiresAt: null as number | null,
  error: null as Error | null,
}));

// SIWE / env は test ごとに差し替えられるよう mutable な hoisted オブジェクトにする。
const siwe = vi.hoisted(() => ({
  isSignedIn: true,
  signIn: vi.fn(),
  isSigningIn: false,
  mismatch: false,
  signInError: null as string | null,
}));
const envMock = vi.hoisted(() => ({ feeReceiverConfigured: true }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, chainId: 137 }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => siwe,
}));
vi.mock('@/hooks/useProSubscribe', () => ({
  useProSubscribe: () => sub,
}));
vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/tokens', () => {
  const deployment = { chainId: 137, name: 'Polygon', address: '0x1' };
  return {
    resolveDeployment: () => deployment,
    defaultDeploymentForSymbol: () => deployment,
  };
});

import { ProPaywall } from '@/components/ProPaywall';

beforeEach(() => {
  sub.start.mockClear();
  sub.retrySubscribe.mockClear();
  sub.isPaying = false;
  sub.isSubscribing = false;
  sub.isSuccess = false;
  sub.isPayError = false;
  sub.isSubscribeError = false;
  sub.expiresAt = null;
  sub.error = null;
  siwe.isSignedIn = true;
  siwe.signIn = vi.fn();
  siwe.isSigningIn = false;
  siwe.mismatch = false;
  siwe.signInError = null;
  envMock.feeReceiverConfigured = true;
});

describe('ProPaywall', () => {
  it('FEE_RECEIVER 未設定なら準備中を出し、購入フローを一切描画しない', () => {
    envMock.feeReceiverConfigured = false;
    render(<ProPaywall />);
    expect(screen.getByText('misconfigured')).toBeInTheDocument();
    // 確認/支払い CTA は出ない (未設定の宛先へ送らせない)。
    expect(screen.queryByRole('button', { name: 'reviewCta' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'payCta' })).toBeNull();
  });

  it('SIWE 未ログインなら sign-in ボタンを出し、確認 UL は描画しない', () => {
    siwe.isSignedIn = false;
    render(<ProPaywall />);
    expect(screen.getByRole('button', { name: 'signIn' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'reviewCta' })).toBeNull();
    expect(screen.queryByText('confirmPrice')).toBeNull();
  });

  it('sign-in ボタン押下で署名文言を渡して signIn を呼ぶ', () => {
    siwe.isSignedIn = false;
    siwe.signIn = vi.fn().mockResolvedValue(undefined);
    render(<ProPaywall />);
    fireEvent.click(screen.getByRole('button', { name: 'signIn' }));
    expect(siwe.signIn).toHaveBeenCalledTimes(1);
    expect(siwe.signIn).toHaveBeenCalledWith('signInStatement');
  });

  it('署名失敗時は signInError を表示する', () => {
    siwe.isSignedIn = false;
    siwe.signInError = 'boom';
    render(<ProPaywall />);
    expect(screen.getByText('signInError')).toBeInTheDocument();
  });

  it('ログイン済は確認項目 (Pro 5 行・gasless 文言なし) を出し、reviewCta→payCta で start を呼ぶ', () => {
    render(<ProPaywall />);
    // Pro の確認 UL は 5 項目 (confirmPrice/NoAutoRenew/NoRefund/Overpay/Gas)。ガスレス文言は無い。
    expect(screen.getByText('confirmPrice')).toBeInTheDocument();
    expect(screen.getByText('confirmNoAutoRenew')).toBeInTheDocument();
    expect(screen.getByText('confirmNoRefund')).toBeInTheDocument();
    expect(screen.getByText('confirmOverpay')).toBeInTheDocument();
    expect(screen.getByText('confirmGas')).toBeInTheDocument();
    expect(screen.queryByText('confirmGasGasless')).toBeNull();
    // footer は note のみ (noteGasless/noteGasPaid は出ない)。
    expect(screen.getByText('note')).toBeInTheDocument();
    expect(screen.queryByText(/noteGas/)).toBeNull();

    // 確認前は payCta を出さない (署名前の最終確認を経てから)。
    expect(screen.queryByRole('button', { name: 'payCta' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'reviewCta' }));
    // 確認後は payCta を出し、押下で start を呼ぶ (再送金しない gasless 経路は無い)。
    const pay = screen.getByRole('button', { name: 'payCta' });
    fireEvent.click(pay);
    expect(sub.start).toHaveBeenCalledTimes(1);
  });

  it('支払い中/検証中は CTA を無効化しラベルを切り替える', () => {
    const { rerender } = render(<ProPaywall />);
    fireEvent.click(screen.getByRole('button', { name: 'reviewCta' }));

    sub.isPaying = true;
    rerender(<ProPaywall />);
    const paying = screen.getByRole('button', { name: 'paying' });
    expect(paying).toBeDisabled();

    sub.isPaying = false;
    sub.isSubscribing = true;
    rerender(<ProPaywall />);
    const verifying = screen.getByRole('button', { name: 'verifying' });
    expect(verifying).toBeDisabled();
  });

  it('成功時は granted (失効日付つき) を表示する', () => {
    sub.isSuccess = true;
    sub.expiresAt = Date.UTC(2026, 5, 30, 0, 0, 0);
    render(<ProPaywall />);
    expect(screen.getByText('granted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'payCta' })).toBeNull();
  });

  it('成功で失効時刻不明なら grantedNoDate を表示する', () => {
    sub.isSuccess = true;
    sub.expiresAt = null;
    render(<ProPaywall />);
    expect(screen.getByText('grantedNoDate')).toBeInTheDocument();
  });

  it('subscribe-error は再検証導線 (retrySubscribe) を出し、再送金 CTA は出さない', () => {
    sub.isSubscribeError = true;
    sub.error = new Error('verify_unavailable');
    render(<ProPaywall />);
    expect(screen.getByText('verifyError')).toBeInTheDocument();
    // 送金は確定済 → reviewCta/payCta は出さない (再送金させない)。
    expect(screen.queryByRole('button', { name: 'reviewCta' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'payCta' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retryVerify' }));
    expect(sub.retrySubscribe).toHaveBeenCalledTimes(1);
  });

  it('送金失敗 (pay-error) は payError を表示する', () => {
    const { rerender } = render(<ProPaywall />);
    fireEvent.click(screen.getByRole('button', { name: 'reviewCta' }));
    sub.isPayError = true;
    sub.error = new Error('insufficient_balance');
    rerender(<ProPaywall />);
    expect(screen.getByText('payError')).toBeInTheDocument();
  });
});
