// /guide/order-link の描画: 利用料の率と最低額は開示の値 (LANDING_PAYMENT_FEE_VALUES) で埋まり、差し込み口が残らない。
// 「注文リンクを作る」は /create の注文リンクのタブへ行く。

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import { orderLinkGuideContentFor } from '@/lib/orderLinkGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

type Page = (props: { params: Promise<{ locale: string }> }) => Promise<React.ReactElement>;

describe('/guide/order-link', () => {
  it.each(['ja', 'en'] as const)('%s: 利用料は開示の値で埋まり、作るボタンは注文リンクのタブへ行く', async (locale) => {
    const Page = (await import('@/app/[locale]/guide/order-link/page')).default as Page;
    const { container } = render(await Page({ params: Promise.resolve({ locale }) }));
    const text = container.textContent ?? '';
    const { recoverPercent, recoverFloor } = LANDING_PAYMENT_FEE_VALUES;
    expect(text).toContain(`${recoverPercent}%`);
    expect(text).toContain(locale === 'ja' ? `最低 ${recoverFloor} JPYC` : `at least ${recoverFloor} JPYC`);
    expect(text).not.toContain('{recoverPercent}');
    expect(text).not.toContain('{recoverFloor}');

    const c = orderLinkGuideContentFor(locale);
    const create = [...container.querySelectorAll('a')].filter((a) => a.textContent?.includes(c.ctaCreate));
    expect(create.length).toBeGreaterThan(0);
    for (const a of create) expect(a.getAttribute('href')).toBe(`/${locale}/create?tab=orderLink`);
    // お店の責任の文を出す。
    expect(text).toContain(c.sellerDuty);
  });
});
