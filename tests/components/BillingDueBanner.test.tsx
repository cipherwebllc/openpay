import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

const JPYC = 10n ** 18n;

const h = vi.hoisted(() => ({
  enableUsageFee: true,
  isSignedIn: true,
  invoice: undefined as unknown,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableUsageFee() {
        return h.enableUsageFee;
      },
    },
  };
});
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: h.isSignedIn, mismatch: false }),
}));
vi.mock('@/hooks/useBillingInvoice', () => ({
  useBillingInvoice: () => ({ data: h.invoice }),
}));

import { BillingDueBanner } from '@/components/BillingDueBanner';

// 猶予中の延滞前インボイス (前月請求あり・未払い・delinquent=false)。
function graceInvoice(over?: Record<string, unknown>) {
  return {
    feeCurrent: false,
    expiresAt: null,
    lastPaidPeriod: null,
    bypass: false,
    delinquent: false,
    graceEndsAt: Date.UTC(2026, 6, 8), // 2026-07-08
    due: {
      period: '2026-06',
      count: 5,
      volumeWei: (10_000n * JPYC).toString(),
      rateBps: 100,
      feeWei: (100n * JPYC).toString(),
      free: false,
    },
    current: {
      period: '2026-07',
      count: 0,
      volumeWei: '0',
      rateBps: 100,
      feeWei: '0',
      free: true,
    },
    ...over,
  };
}

beforeEach(() => {
  h.enableUsageFee = true;
  h.isSignedIn = true;
  h.invoice = graceInvoice();
});

describe('BillingDueBanner', () => {
  it('猶予中・未払い → 予告バナー (金額 + /billing 導線) を表示', () => {
    renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(
      screen.getByText(/OpenPay 利用料のお支払い時期です/),
    ).toBeInTheDocument();
    expect(screen.getByText(/100 JPYC が未払い/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /今すぐ支払う/ }),
    ).toHaveAttribute('href', '/ja/billing');
  });

  it('延滞後 (delinquent=true) → 出さない (ゲートが引き継ぐ)', () => {
    h.invoice = graceInvoice({ delinquent: true });
    const { container } = renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(container).toBeEmptyDOMElement();
  });

  it('支払い済み (feeCurrent=true) → 出さない', () => {
    h.invoice = graceInvoice({ feeCurrent: true });
    const { container } = renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(container).toBeEmptyDOMElement();
  });

  it('bypass (アルファ) → 出さない', () => {
    h.invoice = graceInvoice({ bypass: true });
    const { container } = renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(container).toBeEmptyDOMElement();
  });

  it('前月請求なし (due=0) → 出さない', () => {
    h.invoice = graceInvoice({
      due: {
        period: '2026-06',
        count: 0,
        volumeWei: '0',
        rateBps: 100,
        feeWei: '0',
        free: true,
      },
    });
    const { container } = renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(container).toBeEmptyDOMElement();
  });

  it('未ログイン → 出さない', () => {
    h.isSignedIn = false;
    h.invoice = undefined; // enabled=false で hook は data を返さない
    const { container } = renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(container).toBeEmptyDOMElement();
  });

  it('a1 OFF → 出さない', () => {
    h.enableUsageFee = false;
    h.invoice = undefined;
    const { container } = renderWithIntl(<BillingDueBanner />, { locale: 'ja' });
    expect(container).toBeEmptyDOMElement();
  });
});
