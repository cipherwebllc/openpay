import type { ReactNode } from 'react';
import { createTranslator } from 'next-intl';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { LandingBenefits } from '@/components/LandingBenefits';
import { LandingSupport } from '@/components/LandingSupport';
import { LandingCashComparison } from '@/components/LandingCashComparison';
import QrGuide from '@/app/[locale]/guide/qr/page';
import ShopGuide from '@/app/[locale]/guide/shop/page';
import StartGuide from '@/app/[locale]/guide/start/page';

const context = vi.hoisted(() => ({ locale: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => context.locale,
  setRequestLocale: vi.fn(),
  getTranslations: async () => createTranslator({
    locale: context.locale,
    messages: context.locale === 'ja' ? ja : en,
    namespace: 'Landing',
    onError: (error) => { throw error; },
  }),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/SavingsSimulator', () => ({ SavingsSimulator: () => null }));
// 値を変えても各利用箇所が同じ開示値を補間することを検証する (実際の料金は変更しない)。
vi.mock('@/lib/legal', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/legal')>(),
  LANDING_PAYMENT_FEE_VALUES: {
    recoverPercent: 1.7,
    recoverFloor: 5,
    registerPercent: 1.7,
    storefrontPercent: 2,
    preorderPercent: 4,
    // チップカードの本文 (supportFeeTipBody) もガス相当額を差し込む (2026-10-11)。
    tipFloor: 7,
  },
}));

describe.each(['ja', 'en'] as const)('%s: rendered public fee disclosure', (locale) => {
  const surfaces = [
    ['benefits', () => LandingBenefits()],
    ['support', () => LandingSupport()],
    ['comparison', () => LandingCashComparison()],
    ['QR guide', () => QrGuide({ params: Promise.resolve({ locale }) })],
    ['shop guide', () => ShopGuide({ params: Promise.resolve({ locale }) })],
    ['start guide', () => StartGuide({ params: Promise.resolve({ locale }) })],
  ] as const;

  it.each(surfaces)('%s interpolates disclosure values without missing ICU arguments', async (_, surface) => {
    context.locale = locale;
    const { container } = render(await surface());
    expect(container).toHaveTextContent('1.7%');
    expect(container).toHaveTextContent('5 JPYC');
    expect(container.textContent).not.toMatch(/\{(?:recover|register|storefront|preorder|tip)/);
  });

  // チップカードは トップ (LandingSupport) と導入前チェックリスト (start guide) に出る。本文の数字は直書きせず、
  // ガス相当額 (tipFloor) と、適用しない決済額の % (recoverPercent) を差し込む。
  it.each(surfaces.filter(([name]) => name === 'support' || name === 'start guide'))('%s: tip card body interpolates the tip floor and the recover percent', async (_, surface) => {
    context.locale = locale;
    const { container } = render(await surface());
    expect(container).toHaveTextContent(locale === 'ja' ? '約 7 JPYC' : 'about 7 JPYC');
    expect(container).toHaveTextContent(locale === 'ja' ? '決済額の 1.7% は適用しません' : 'the 1.7% does not apply');
  });
});
