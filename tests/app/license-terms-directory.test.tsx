import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setRequestLocale } from 'next-intl/server';
import DirectoryLicenseTermsPage, { generateMetadata } from '@/app/[locale]/license-terms/directory-v1/page';
import { DIRECTORY_LICENSE, directoryLicenseContentFor } from '@/lib/directory/licenseTerms';
import sitemap from '@/app/sitemap';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('public directory-v1 license terms', () => {
  it.each(['ja', 'en'])('%s renders all 8 clauses and indexable metadata', async (locale) => {
    const params = Promise.resolve({ locale });
    render(await DirectoryLicenseTermsPage({ params }));
    const c = directoryLicenseContentFor(locale);
    expect(screen.getByRole('heading', { level: 1, name: c.title })).toBeVisible();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    c.items.forEach((item, i) => {
      expect(within(items[i]).getByRole('heading', { level: 2, name: item.title })).toBeVisible();
      expect(within(items[i]).getByText(item.body)).toBeVisible();
    });
    expect(screen.getByRole('link', { name: c.termsLink })).toHaveAttribute('href', `/${locale}/terms`);
    expect(setRequestLocale).toHaveBeenCalledWith(locale);
    expect(await generateMetadata({ params })).toMatchObject({
      title: `${c.title} | OpenPay`, description: c.description,
      alternates: { canonical: DIRECTORY_LICENSE.urlFor(locale) }, robots: { index: true, follow: true },
    });
    expect(sitemap()).toContainEqual(expect.objectContaining({ url: DIRECTORY_LICENSE.urlFor(locale) }));
  });
});
