import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import SellerDisclosurePage from '@/app/[locale]/store/seller/[address]/page';

const state = vi.hoisted(() => ({
  locale: 'ja' as 'ja' | 'en',
  disclosure: {
    name: 'Test seller',
    contact: 'seller@example.com',
    disclosure: 'Test disclosure',
    updatedAt: '2026-09-22T23:30:00Z',
  },
}));

vi.mock('@/lib/env', () => ({
  env: { enableCreatorStoreUi: true, enableCreatorStore: true },
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  getSellerDisclosure: async () => state.disclosure,
}));
vi.mock('next-intl/server', () => ({
  setRequestLocale: (locale: 'ja' | 'en') => { state.locale = locale; },
  getTranslations: async () => {
    const messages = { ja, en }[state.locale].CreatorStoreSellerDisclosure;
    return (key: keyof typeof messages) => messages[key];
  },
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

// TZ は起動プロセスから引き継ぐ (CI の JST date regressions step は非 JST を明示)。
// locale は日付の表記だけを変え、JST の暦日は変えない。
describe.each(['ja', 'en'] as const)('JST regression: seller disclosure (%s)', (locale) => {
  it.each([
    ['2026-09-22T14:59:59.999Z', '2026年9月22日', 'September 22, 2026'],
    ['2026-09-22T15:00:00.000Z', '2026年9月23日', 'September 23, 2026'],
    ['2026-09-22T23:30:00.000Z', '2026年9月23日', 'September 23, 2026'],
    ['2026-12-31T15:00:00.000Z', '2027年1月1日', 'January 1, 2027'],
  ])('%s の最終更新日', async (instant, japanese, english) => {
    state.disclosure.updatedAt = instant;
    const original = structuredClone(state.disclosure);
    render(await SellerDisclosurePage({
      params: Promise.resolve({ locale, address: '0x1111111111111111111111111111111111111111' }),
    }));

    const label = { ja, en }[locale].CreatorStoreSellerDisclosure.updatedAtLabel;
    expect(screen.getByText(label).nextElementSibling).toHaveTextContent(
      locale === 'ja' ? japanese : english,
    );
    expect(state.disclosure).toEqual(original);
  });
});
