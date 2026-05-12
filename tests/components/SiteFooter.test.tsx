import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { SiteFooter } from '@/components/SiteFooter';
import { LEGAL_ENTITY } from '@/lib/legal';

describe('SiteFooter', () => {
  it('ja: 3 legal link (利用規約/プライバシーポリシー/免責事項) を露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const terms = screen.getByRole('link', { name: '利用規約' });
    const privacy = screen.getByRole('link', { name: 'プライバシーポリシー' });
    const disclaimer = screen.getByRole('link', { name: '免責事項' });
    expect(terms.getAttribute('href')).toBe('/terms');
    expect(privacy.getAttribute('href')).toBe('/privacy');
    expect(disclaimer.getAttribute('href')).toBe('/disclaimer');
  });

  it('en: 同じ link を英訳 (Terms of Service / Privacy Policy / Disclaimer) で露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    expect(
      screen.getByRole('link', { name: 'Terms of Service' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Privacy Policy' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Disclaimer' })).toBeInTheDocument();
  });

  it('事業者名と copyright を表示する', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    // copyright 行に LEGAL_ENTITY.companyName が含まれる
    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(LEGAL_ENTITY.companyName);
  });

  it('print:hidden が footer 要素に付与されている (QR ポスター印刷時非表示)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const footer = screen.getByRole('contentinfo');
    // tailwind class が含まれていれば OK (実 CSS は別途検証不要)
    expect(footer.className).toContain('print:hidden');
  });
});
