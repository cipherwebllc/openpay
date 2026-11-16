import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LandingProfileDemo, type LandingProfileDemoCopy, type LandingProfileDemoCta } from '@/components/LandingProfileDemo';
import { LandingSellables } from '@/components/LandingSellables';
import { handlePageTheme, handleViewTheme } from '@/lib/handleTheme';
import { normalizeHandle, validateHandle } from '@/lib/handle';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

// 販売の節 (server) を ja / en で描いて、見本の下の入口の行の文言と行き先の土台が server から渡ることを見る。
const intl = vi.hoisted(() => ({ locale: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', async () => {
  const messages = { ja: (await import('../../messages/ja.json')).default, en: (await import('../../messages/en.json')).default };
  return {
    getLocale: async () => intl.locale,
    getTranslations: async (namespace: 'Landing' | 'StoreCatalog') =>
      createTranslator({ locale: intl.locale, messages: messages[intl.locale], namespace }),
  };
});
// 販売の節は Store の UI の flag が ON のときだけ描く (本番は ON)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStoreUi: true } };
});

const c: LandingProfileDemoCopy = {
  title: 'Make the page yours',
  hint: 'Pick one to preview it.',
  themeLabel: 'Theme',
  colorLabel: 'Color',
  colorNames: { blue: 'Blue', green: 'Green', rose: 'Rose', amber: 'Amber', violet: 'Violet' },
  sample: { tag: 'Sample', initial: 'K', name: 'Komorebi', handle: '@your_name', bio: 'Illustrations.', featured: 'Wallpaper set', link: 'See my work' },
};
const cta: LandingProfileDemoCta = { sellHref: '/en/create?tab=profile', sellLabel: 'Start selling', guideHref: '/en/guide/store', guideLabel: 'Selling guide' };

describe('LandingProfileDemo', () => {
  it('previews the public-profile look for the chosen theme and color (same tokens as the real page)', () => {
    render(<LandingProfileDemo c={c} cta={cta} />);
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
    const { container } = render(<LandingProfileDemo c={c} cta={cta} />);
    for (const name of ['Clean', 'Gradient', 'Bold', 'Outline', 'Night', 'Soft', 'Blue', 'Green', 'Rose', 'Amber', 'Violet']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(container.querySelector('[aria-label]')).toBeNull();
    expect(screen.getByText('Komorebi').closest('[aria-hidden]')).not.toBeNull();
  });
  it('スマホではテーマと色の選択肢の押せる高さが 40px 以上・sm 以上は今までの 36px (jsdom は CSS を当てないので class で見る)', () => {
    render(<LandingProfileDemo c={c} cta={cta} />);
    const options = ['Clean', 'Gradient', 'Bold', 'Outline', 'Night', 'Soft', 'Blue', 'Green', 'Rose', 'Amber', 'Violet'].map((name) =>
      screen.getByRole('button', { name }),
    );
    for (const option of options) {
      const tokens = option.className.split(/\s+/);
      // 高さの指定 (どの幅・どの条件でも) は、スマホの最小の高さと sm 以上の最小の高さの 2 つだけ (h-* で固定しない)。
      const heights = tokens.filter((token) => /(?:^|:)(?:min-h|max-h|h)-/.test(token));
      expect(heights.sort()).toEqual(['min-h-10', 'sm:min-h-9']);
      // min-h-10 = 2.5rem = 40px。字の高さ (12px の字・行 16px) + 上下の余白 12px = 28px なので、高さを決めるのは最小の高さ。
      expect(Number(heights[0].match(/^min-h-(\d+)$/)![1]) * 4).toBeGreaterThanOrEqual(40);
      // 中身は縦の中央 (高くした分、字が上に寄らない)。横に流す行で縮まない。
      expect(tokens).toEqual(expect.arrayContaining(['inline-flex', 'items-center', 'shrink-0']));
    }
  });
  it('uses a reserved handle for the sample, so no one can claim the page the top page shows', () => {
    // 見本のハンドルを第三者が取ると「トップで紹介されたページ」に見せかけられる。予約語で塞ぐ。
    for (const messages of [ja, en]) {
      const handle = normalizeHandle(messages.Landing.profileDemoSampleHandle);
      expect(validateHandle(handle)).toEqual({ ok: false, reason: 'reserved' });
    }
  });
});

describe('LandingProfileDemo: 見本で選んだテーマと色を「出品をはじめる」の行き先に付ける (P6)', () => {
  const sell = () => screen.getByRole('link', { name: 'Start selling' });

  it('触っていない人の行き先は今のまま (作成画面は既定の見た目で始まる)。販売ガイドの行き先は変えない', () => {
    render(<LandingProfileDemo c={c} cta={cta} />);
    expect(sell()).toHaveAttribute('href', '/en/create?tab=profile');
    expect(screen.getByRole('link', { name: 'Selling guide' })).toHaveAttribute('href', '/en/guide/store');
  });

  it('テーマか色を選んだら、選んだテーマと色の名前を付ける (片方だけ選んでも両方)', () => {
    render(<LandingProfileDemo c={c} cta={cta} />);
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    expect(sell()).toHaveAttribute('href', '/en/create?tab=profile&theme=night&color=blue');
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }));
    expect(sell()).toHaveAttribute('href', '/en/create?tab=profile&theme=night&color=violet');
    expect(screen.getByRole('link', { name: 'Selling guide' })).toHaveAttribute('href', '/en/guide/store');
  });

  it('色だけ選んでも付ける・選んだ後に既定 (Gradient × 青) へ戻しても、選んだ値として付けたまま', () => {
    render(<LandingProfileDemo c={c} cta={cta} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rose' }));
    expect(sell()).toHaveAttribute('href', '/en/create?tab=profile&theme=gradient&color=rose');
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    expect(sell()).toHaveAttribute('href', '/en/create?tab=profile&theme=gradient&color=blue');
  });

  it.each([
    ['ja', ja, '紫'],
    ['en', en, 'Violet'],
  ] as const)('販売の節 (%s): 文言と行き先の土台は server から。入口の行は見本のすぐ後 (DOM の順は今のまま)', async (locale, messages, violet) => {
    intl.locale = locale;
    const { container } = render(await LandingSellables());
    const section = container.querySelector('section#lp-sell') as HTMLElement;
    const link = within(section).getByRole('link', { name: messages.Landing.sellablesCtaSell });
    const guide = within(section).getByRole('link', { name: messages.Landing.sellablesCtaGuide });
    expect(link).toHaveAttribute('href', `/${locale}/create?tab=profile`);
    expect(guide).toHaveAttribute('href', `/${locale}/guide/store`);
    // 入口の行は見本のカードのすぐ後 (DOM の順は今のまま)。
    const card = within(section).getByRole('heading', { level: 3, name: messages.Landing.profileDemoTitle }).parentElement!.parentElement!;
    expect(card.nextElementSibling).toBe(link.parentElement);
    expect(link.parentElement!.lastElementChild).toBe(guide);
    fireEvent.click(within(section).getByRole('button', { name: 'Bold' }));
    fireEvent.click(within(section).getByRole('button', { name: violet }));
    expect(link).toHaveAttribute('href', `/${locale}/create?tab=profile&theme=bold&color=violet`);
    expect(guide).toHaveAttribute('href', `/${locale}/guide/store`);
  });
});
