import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { AlphaNotice } from '@/components/AlphaNotice';

describe('AlphaNotice', () => {
  it('ja: "Alpha" バッジと注意本文と /disclaimer link を露出', () => {
    renderWithIntl(<AlphaNotice />, { locale: 'ja' });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/Alpha/);
    expect(banner.textContent).toMatch(/アルファ版/);
    expect(banner.textContent).toMatch(/取消できません/);
    const link = screen.getByRole('link', { name: '詳細' });
    expect(link.getAttribute('href')).toBe('/disclaimer');
  });

  it('en: 同じ構成で英訳 + /disclaimer link', () => {
    renderWithIntl(<AlphaNotice />, { locale: 'en' });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/Alpha/);
    expect(banner.textContent).toMatch(/alpha/);
    expect(banner.textContent).toMatch(/irreversible/);
    const link = screen.getByRole('link', { name: 'Details' });
    expect(link.getAttribute('href')).toBe('/disclaimer');
  });

  it('print:hidden が banner 要素に付与されている (QR ポスター印刷時非表示)', () => {
    renderWithIntl(<AlphaNotice />, { locale: 'ja' });
    const banner = screen.getByRole('status');
    expect(banner.className).toContain('print:hidden');
  });
});
