import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const sub = vi.hoisted(() => ({
  start: vi.fn(),
  startGasPaid: vi.fn(),
  retrySubscribe: vi.fn(),
  retryRelay: vi.fn(),
  gasless: true,
  gaslessUnavailable: false,
  canRetryRelay: false,
  isPaying: false,
  isSubscribing: false,
  isSuccess: false,
  isPayError: false,
  isSubscribeError: false,
  expiresAt: null as number | null,
  error: null as Error | null,
}));

const wording = vi.hoisted(() => ({ locale: null as 'ja' | 'en' | null }));
vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  return {
    useTranslations: (namespace: 'Pro' | 'CsvPass') => wording.locale
      ? actual.createTranslator({
          locale: wording.locale,
          messages: wording.locale === 'ja' ? ja : en,
          namespace,
        })
      : (key: string) => key,
  };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, chainId: 137 }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true,
    signIn: vi.fn(),
    isSigningIn: false,
    mismatch: false,
    signInError: null,
  }),
}));
vi.mock('@/hooks/useCsvPassSubscribe', () => ({
  useCsvPassSubscribe: () => sub,
}));
vi.mock('@/lib/env', () => ({
  env: { feeReceiverConfigured: true },
}));
vi.mock('@/lib/tokens', () => {
  const deployment = { chainId: 137, name: 'Polygon', address: '0x1' };
  return {
    resolveDeployment: () => deployment,
    defaultDeploymentForSymbol: () => deployment,
  };
});

import { CsvPassPaywall } from '@/components/CsvPassPaywall';

beforeEach(() => {
  wording.locale = null;
  sub.start.mockClear();
  sub.startGasPaid.mockClear();
  sub.retrySubscribe.mockClear();
  sub.retryRelay.mockClear();
  sub.gasless = true;
  sub.gaslessUnavailable = false;
  sub.canRetryRelay = false;
  sub.isPaying = false;
  sub.isSubscribing = false;
  sub.isSuccess = false;
  sub.isPayError = false;
  sub.isSubscribeError = false;
  sub.expiresAt = null;
  sub.error = null;
});

describe('CsvPassPaywall gas-paid fallback consent', () => {
  it('503 後はガスレス同意を流用せず、ガス代負担表示で再確認してから fallback を実行する', () => {
    const view = render(<CsvPassPaywall />);
    expect(screen.getByText('confirmGasGasless')).toBeInTheDocument();
    expect(screen.getByText(/noteGasless/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'reviewCta' }));
    expect(screen.getByRole('button', { name: 'payCtaGasless' })).toBeInTheDocument();

    sub.gaslessUnavailable = true;
    view.rerender(<CsvPassPaywall />);
    expect(screen.getByText('confirmGas')).toBeInTheDocument();
    expect(screen.getByText(/noteGasPaid/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'fallbackGasPaid' })).toBeNull();
    expect(screen.getByRole('button', { name: 'reviewCta' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'reviewCta' }));
    fireEvent.click(screen.getByRole('button', { name: 'fallbackGasPaid' }));
    expect(sub.startGasPaid).toHaveBeenCalledTimes(1);
    expect(sub.start).not.toHaveBeenCalled();
  });

  it('ガスあり fallback の送金失敗を payError として表示する', () => {
    sub.gaslessUnavailable = true;
    const view = render(<CsvPassPaywall />);
    fireEvent.click(screen.getByRole('button', { name: 'reviewCta' }));

    sub.isPayError = true;
    sub.error = new Error('insufficient_balance');
    view.rerender(<CsvPassPaywall />);
    expect(screen.getByText('payError')).toBeInTheDocument();
  });
});

// 実際の ICU 翻訳で価格も検証し、key だけ返す mock が placeholder 未供給を隠すのを防ぐ。
describe('CsvPassPaywall 厳密額の公開文言', () => {
  it.each([
    ['ja', '100 JPYC ちょうどを送金してください。異なる金額では CSV パスを付与できません。'],
    ['en', 'Send exactly 100 JPYC. A CSV pass cannot be granted for any other amount.'],
  ] as const)('%s で価格を埋めた確認文を支払い前に表示', (locale, text) => {
    wording.locale = locale;
    render(<CsvPassPaywall />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(sub.start).not.toHaveBeenCalled();
  });
});
