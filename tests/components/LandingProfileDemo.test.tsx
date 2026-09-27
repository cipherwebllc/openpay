import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LandingProfileDemo, type LandingProfileDemoCopy } from '@/components/LandingProfileDemo';
import { handlePageTheme, handleViewTheme } from '@/lib/handleTheme';
import { normalizeHandle, validateHandle } from '@/lib/handle';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

const c: LandingProfileDemoCopy = {
  title: 'Make the page yours',
  hint: 'Pick one to preview it.',
  themeLabel: 'Theme',
  colorLabel: 'Color',
  colorNames: { blue: 'Blue', green: 'Green', rose: 'Rose', amber: 'Amber', violet: 'Violet' },
  sample: { tag: 'Sample', initial: 'K', name: 'Komorebi', handle: '@your_name', bio: 'Illustrations.', featured: 'Wallpaper set', link: 'See my work' },
};

describe('LandingProfileDemo', () => {
  it('previews the public-profile look for the chosen theme and color (same tokens as the real page)', () => {
    render(<LandingProfileDemo c={c} />);
    const preview = screen.getByText('Komorebi').closest('[aria-hidden]') as HTMLElement;
    // 既定は Gradient × 青。
    expect(screen.getByRole('button', { name: 'Gradient' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    const before = preview.style.background;
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }));
    expect(screen.getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Gradient' })).toHaveAttribute('aria-pressed', 'false');
    // 見本の地色と名前の色は公開プロフィールと同じ組み立て (lib/handleTheme)。
    expect(handlePageTheme('#7c3aed', 'night').full).toBe(true);
    expect(preview.style.background).not.toBe(before);
    expect(preview.style.background).toContain('15, 23, 42'); // night の地色 #0f172a
    const name = screen.getByText('Komorebi');
    expect(name.style.color).toBe('rgb(248, 250, 252)'); // night の inkColor (#f8fafc)
    expect(handleViewTheme('#7c3aed', 'night').inkColor).toBe('#f8fafc');
  });
  it('names every option by its visible text and keeps the decorative preview out of the reading order', () => {
    const { container } = render(<LandingProfileDemo c={c} />);
    for (const name of ['Clean', 'Gradient', 'Bold', 'Outline', 'Night', 'Soft', 'Blue', 'Green', 'Rose', 'Amber', 'Violet']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(container.querySelector('[aria-label]')).toBeNull();
    expect(screen.getByText('Komorebi').closest('[aria-hidden]')).not.toBeNull();
  });
  it('uses a reserved handle for the sample, so no one can claim the page the top page shows', () => {
    // 見本のハンドルを第三者が取ると「トップで紹介されたページ」に見せかけられる。予約語で塞ぐ。
    for (const messages of [ja, en]) {
      const handle = normalizeHandle(messages.Landing.profileDemoSampleHandle);
      expect(validateHandle(handle)).toEqual({ ok: false, reason: 'reserved' });
    }
  });
});
