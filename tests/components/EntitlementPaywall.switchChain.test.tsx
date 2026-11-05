// components/EntitlementPaywall.tsx (CSV 24 時間パス・Pro の購入画面): 「… に切り替える」が失敗したら
// (ウォレットでの取り消しを除く)、ボタンの下に知らせ、記録 (logger.warn wallet.switch_chain_failed) に残す
// (#992 の支払い画面と同じ・第 9 回レビュー F-03)。文言は両 tier の namespace (CsvPass / Pro) の実際の訳で確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

const h = vi.hoisted(() => ({
  // switchChain の呼び出しと、押したときの失敗 (tests/_helpers/switchChainStub.ts)。
  switch: { switchChain: vi.fn(), error: null as Error | null },
  sub: {
    start: vi.fn(),
    retrySubscribe: vi.fn(),
    isPaying: false,
    isSubscribing: false,
    isSuccess: false,
    isPayError: false,
    isSubscribeError: false,
    expiresAt: null,
    error: null,
  },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, feeReceiverConfigured: true } };
});
vi.mock('wagmi', async () => {
  const { useSwitchChainStub } = await import('../_helpers/switchChainStub');
  return {
    // Ethereum mainnet: テストは testnet の構成なので JPYC の対応外 = 「… に切り替える」が出る。
    useAccount: () => ({ isConnected: true, chainId: 1, connector: { id: 'metaMaskSDK' } }),
    useSwitchChain: () => useSwitchChainStub(h.switch),
  };
});
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true,
    signIn: vi.fn(),
    isSigningIn: false,
    mismatch: false,
    signInError: null,
  }),
}));
vi.mock('@/hooks/useCsvPassSubscribe', () => ({ useCsvPassSubscribe: () => h.sub }));
vi.mock('@/hooks/useProSubscribe', () => ({ useProSubscribe: () => h.sub }));

import { CsvPassPaywall } from '@/components/CsvPassPaywall';
import { ProPaywall } from '@/components/ProPaywall';
import { logger } from '@/lib/logger';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const jpyc = defaultDeploymentForSymbol('jpyc');
const TIERS = [
  ['CsvPass', CsvPassPaywall],
  ['Pro', ProPaywall],
] as const;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.switch.switchChain.mockReset();
  h.switch.error = null;
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe('EntitlementPaywall チェーンの切り替えの失敗', () => {
  it.each(TIERS)('%s: 切り替えが失敗したら、ボタンの下に知らせを出し、どの画面か・目的のチェーンを記録する', (_ns, Paywall) => {
    const error = new Error('Unrecognized chain ID "0x13882".');
    h.switch.error = error;
    renderWithIntl(<Paywall />);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${jpyc.name} に切り替える` }));
    expect(h.switch.switchChain).toHaveBeenCalledWith({ chainId: jpyc.chainId });
    expect(screen.getByRole('alert')).toHaveTextContent(
      `${jpyc.name} に切り替えられませんでした。ウォレットのアプリで ${jpyc.name} を選んでから、もう一度お試しください。`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'wallet.switch_chain_failed',
      expect.objectContaining({ surface: 'entitlement-paywall', chainId: jpyc.chainId, error }),
    );
  });

  it.each(TIERS)('%s: en でも同じ知らせを出す (namespace にキーがある)', (_ns, Paywall) => {
    h.switch.error = new Error('Unrecognized chain ID "0x13882".');
    renderWithIntl(<Paywall />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: `Switch to ${jpyc.name}` }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Couldn’t switch to ${jpyc.name}. Select ${jpyc.name} in your wallet app, then try again.`,
    );
  });

  it.each(TIERS)('%s: ウォレットで取り消した (user rejected) なら、知らせず記録もしない', (_ns, Paywall) => {
    h.switch.error = new Error('User rejected the request.');
    renderWithIntl(<Paywall />);
    fireEvent.click(screen.getByRole('button', { name: `${jpyc.name} に切り替える` }));
    // fireEvent は act の中で走る = 失敗の描画と記録の effect はここまでに済んでいる。
    expect(h.switch.switchChain).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
