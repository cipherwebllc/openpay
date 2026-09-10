import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setRequestLocale } from 'next-intl/server';
import StandardLicenseTermsPage, { generateMetadata } from '@/app/[locale]/license-terms/standard-v1/page';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';
import { licenseTermsTemplateContentFor } from '@/lib/licenseTermsTemplate';
import sitemap from '@/app/sitemap';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('public standard-v1 license terms', () => {
  it.each(['ja', 'en'])('%s renders all 11 numbered items and indexable metadata without feature flags', async (locale) => {
    const params = Promise.resolve({ locale });
    render(await StandardLicenseTermsPage({ params }));
    const c = licenseTermsTemplateContentFor(locale);
    expect(screen.getByRole('heading', { level: 1, name: c.title })).toBeVisible();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(11);
    c.items.forEach((item, i) => {
      expect(within(items[i]).getByRole('heading', { level: 2, name: item.title })).toBeVisible();
      expect(within(items[i]).getByText(item.body)).toBeVisible();
    });
    expect(screen.getByText(c.languageNote)).toBeVisible();
    if (locale === 'en') expect(screen.getByRole('link', { name: c.canonicalLink })).toHaveAttribute('href', LICENSE_STANDARD_TERMS.url);
    expect(screen.getByRole('link', { name: c.termsLink })).toHaveAttribute('href', `/${locale}/terms`);
    expect(setRequestLocale).toHaveBeenCalledWith(locale);
    expect(await generateMetadata({ params })).toMatchObject({
      title: `${c.title} | OpenPay`, description: c.description,
      alternates: { canonical: LICENSE_STANDARD_TERMS.url }, robots: { index: true, follow: true },
    });
  });
  it('binds the shared canonical URL to the page path and includes both locales in the sitemap', () => {
    expect(LICENSE_STANDARD_TERMS.path).toBe('/license-terms/standard-v1');
    expect(LICENSE_STANDARD_TERMS.url).toBe(`https://open-pay.jp/ja${LICENSE_STANDARD_TERMS.path}`);
    for (const locale of ['ja', 'en']) expect(sitemap()).toContainEqual(expect.objectContaining({ url: `https://open-pay.jp/${locale}${LICENSE_STANDARD_TERMS.path}` }));
    expect(Object.keys(licenseTermsTemplateContentFor('ja'))).toEqual(Object.keys(licenseTermsTemplateContentFor('en')));
  });
});
