import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { SiteFooter } from '@/components/SiteFooter';
import { LEGAL_ENTITY } from '@/lib/legal';

describe('SiteFooter', () => {
  it('ja: 4 legal link (利用規約/プライバシーポリシー/免責事項/特商法表記) を露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const terms = screen.getByRole('link', { name: '利用規約' });
    const privacy = screen.getByRole('link', { name: 'プライバシーポリシー' });
    const disclaimer = screen.getByRole('link', { name: '免責事項' });
    const tokutei = screen.getByRole('link', { name: '特商法表記' });
    expect(terms.getAttribute('href')).toBe('/terms');
    expect(privacy.getAttribute('href')).toBe('/privacy');
    expect(disclaimer.getAttribute('href')).toBe('/disclaimer');
    expect(tokutei.getAttribute('href')).toBe('/tokutei');
  });

  it('en: 同じ link を英訳 (Terms of Service / Privacy Policy / Disclaimer / Business Disclosure) で露出', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    expect(
      screen.getByRole('link', { name: 'Terms of Service' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Privacy Policy' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Disclaimer' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Business Disclosure' }),
    ).toBeInTheDocument();
  });

  it('事業者名と copyright を表示する', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    // copyright 行に LEGAL_ENTITY.companyName が含まれる
    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(LEGAL_ENTITY.companyName);
  });

  it('GitHub source link が新規 tab で開く形 + noopener で表示される', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', { name: 'ソースコード (GitHub)' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/cipherwebllc/openpay',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で source link が "Source on GitHub" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'Source on GitHub' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/cipherwebllc/openpay',
    );
  });

  it('X (旧 Twitter) 公式アカウントへのリンクが aria-label 付きで露出 (ja)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const link = screen.getByRole('link', {
      name: 'OpenPay の X (旧 Twitter)',
    });
    expect(link.getAttribute('href')).toBe('https://x.com/openpay_jp');
    expect(link.getAttribute('target')).toBe('_blank');
    // tabnabbing 防御 (window.opener 経由) — 既存 GitHub link と同方針
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('en locale で X link aria-label が "OpenPay on X" として render', () => {
    renderWithIntl(<SiteFooter />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'OpenPay on X' });
    expect(link.getAttribute('href')).toBe('https://x.com/openpay_jp');
  });

  it('print:hidden が footer 要素に付与されている (QR ポスター印刷時非表示)', () => {
    renderWithIntl(<SiteFooter />, { locale: 'ja' });
    const footer = screen.getByRole('contentinfo');
    // tailwind class が含まれていれば OK (実 CSS は別途検証不要)
    expect(footer.className).toContain('print:hidden');
  });

  it('現在年 = copyrightStartYear なら単年表示', () => {
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(
      LEGAL_ENTITY.copyrightStartYear,
    );
    try {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      const footer = screen.getByRole('contentinfo');
      expect(footer.textContent).toContain(
        String(LEGAL_ENTITY.copyrightStartYear),
      );
      expect(footer.textContent).not.toMatch(
        new RegExp(`${LEGAL_ENTITY.copyrightStartYear}-\\d{4}`),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('現在年 > copyrightStartYear ならレンジ表示 (start-current)', () => {
    const futureYear = LEGAL_ENTITY.copyrightStartYear + 3;
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(futureYear);
    try {
      renderWithIntl(<SiteFooter />, { locale: 'ja' });
      const footer = screen.getByRole('contentinfo');
      expect(footer.textContent).toMatch(
        new RegExp(`${LEGAL_ENTITY.copyrightStartYear}-${futureYear}`),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
