// SignInGate: 未接続 = 「ウォレットを接続」1 つ (押すと一覧・focus は一覧の先頭へ) / 接続済み = サインイン 1 つ
// (署名の文面は呼び出し側のまま渡す) / 失敗 = 赤の 1 行。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { SignInGate } from '@/components/SignInGate';

const h = vi.hoisted(() => ({
  isConnected: false,
  signIn: vi.fn(() => Promise.resolve()),
  isSigningIn: false,
  signInError: null as string | null,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({
    isConnected: h.isConnected,
    address: h.isConnected ? '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' : undefined,
  }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ signIn: h.signIn, isSigningIn: h.isSigningIn, signInError: h.signInError }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => (
    <div>
      <button type="button">MetaMask</button>
      <button type="button">WalletConnect</button>
    </div>
  ),
}));

beforeEach(() => {
  h.isConnected = false;
  h.signIn.mockClear();
  h.isSigningIn = false;
  h.signInError = null;
});

describe('SignInGate', () => {
  it('未接続はボタン 1 つ。押すとウォレットの一覧を出し、focus を一覧の先頭へ移す (body に落とさない)', () => {
    renderWithIntl(<SignInGate statement="署名の文面" cta="サインインして公開" />);
    expect(screen.queryByRole('button', { name: 'MetaMask' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'ウォレットを接続' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'MetaMask' })).toHaveFocus();
  });

  it('接続済みは何ができるかを言うボタン 1 つ。押すと呼び出し側の文面で署名する', () => {
    h.isConnected = true;
    renderWithIntl(<SignInGate statement="署名の文面" cta="サインインして公開" />);
    fireEvent.click(screen.getByRole('button', { name: 'サインインして公開' }));
    expect(h.signIn).toHaveBeenCalledWith('署名の文面');
  });

  it('失敗したら赤の 1 行', () => {
    h.isConnected = true;
    h.signInError = 'rejected';
    renderWithIntl(<SignInGate statement="署名の文面" cta="サインインして公開" />);
    expect(
      screen.getByText('サインインできませんでした。ウォレットで署名を承認して、もう一度お試しください。'),
    ).toBeInTheDocument();
  });
});
