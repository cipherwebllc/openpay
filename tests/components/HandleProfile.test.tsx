import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { HandleProfileView } from '@/components/HandleProfile';
import {
  ReceiveMethodPicker,
  methodLabel,
} from '@/components/ReceiveMethodPicker';
import type { HandleTipConfig } from '@/lib/handle';

// TipForm は wagmi/relay 依存で重いのでスタブ化 (選択された method の token:chain を出すだけ)。
vi.mock('@/components/TipForm', () => ({
  TipForm: ({ params }: { params: { token: string; chain?: string } }) => (
    <div data-testid="tipform">
      {params.token}:{params.chain}
    </div>
  ),
}));

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const EXPECTED_CLEAN_LINK_CLASS =
  'flex w-full items-center justify-center rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-[0.95rem] font-semibold text-slate-800 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_10px_24px_-8px_rgba(15,23,42,0.2)] active:translate-y-0 active:shadow-sm';
const EXPECTED_EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-presentation';

const multiConfig: HandleTipConfig = {
  to: ADDR,
  name: 'Alice',
  color: '#2563eb',
  methods: [
    { token: 'jpyc', chain: 'polygon' },
    { token: 'jpyc', chain: 'kaia' },
    { token: 'usdc', chain: 'base', crossChain: true },
  ],
  presets: { jpyc: ['300'], usdc: ['5'] },
};

describe('methodLabel', () => {
  it('formats token + chain, and cross-chain for USDC', () => {
    expect(methodLabel({ token: 'jpyc', chain: 'polygon' }, 'cross-chain')).toBe(
      'JPYC (Polygon)',
    );
    expect(methodLabel({ token: 'jpyc', chain: 'kaia' }, 'cross-chain')).toBe(
      'JPYC (Kaia)',
    );
    expect(
      methodLabel({ token: 'usdc', chain: 'base', crossChain: true }, 'cross-chain'),
    ).toBe('USDC (cross-chain)');
  });
});

describe('HandleProfileView', () => {
  it('renders name + bio + initial fallback (no avatar)', () => {
    renderWithIntl(
      <HandleProfileView config={multiConfig} profile={{ bio: 'Web3 creator' }} />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Web3 creator')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument(); // initial of "Alice"
  });

  it('renders avatar img when provided', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{ avatar: 'https://cdn.example.com/a.png' }}
      />,
    );
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/a.png');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('renders links with safe rel/target', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{ links: [{ label: 'My X', url: 'https://x.com/alice' }] }}
      />,
    );
    const link = screen.getByRole('link', { name: 'My X' });
    expect(link).toHaveAttribute('href', 'https://x.com/alice');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('clean (default) renders links with the exact current className and no inline style (pixel parity)', () => {
    const links = [{ label: 'My X', url: 'https://x.com/alice' }];
    const { unmount } = renderWithIntl(
      <HandleProfileView config={multiConfig} profile={{ links }} />,
    );
    const noTheme = screen.getByRole('link', { name: 'My X' });
    // class を実装から自己参照せずハードコードし、旧レコードの DOM 階層・属性も固定する。
    expect(noTheme.getAttribute('class')).toBe(EXPECTED_CLEAN_LINK_CLASS);
    expect(noTheme.getAttribute('style')).toBeNull();
    expect(noTheme.closest('ul')?.className).toBe(
      'mt-7 flex w-full flex-col gap-2.5',
    );
    expect(noTheme.closest('ul')?.innerHTML).toBe(
      `<li><a href="https://x.com/alice" target="_blank" rel="noopener noreferrer nofollow" class="${EXPECTED_CLEAN_LINK_CLASS}">My X</a></li>`,
    );
    unmount();
    // 明示 theme:'clean' でも同一 className + inline style 無し。
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{ links, theme: 'clean' }}
      />,
    );
    const cleanExplicit = screen.getByRole('link', { name: 'My X' });
    expect(cleanExplicit.getAttribute('class')).toBe(EXPECTED_CLEAN_LINK_CLASS);
    expect(cleanExplicit.getAttribute('style')).toBeNull();
  });

  it('renders a link emoji as aria-hidden text (accessible name stays the label)', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{ links: [{ label: 'Site', url: 'https://x.com/a', emoji: '🌐' }] }}
      />,
    );
    // a11y 名は label のみ (絵文字は混ざらない)。
    const link = screen.getByRole('link', { name: 'Site' });
    expect(link).toHaveTextContent('🌐');
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe('🌐');
  });

  it('renders a decorative link image and falls back to emoji / nothing on error', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            {
              label: 'With emoji',
              url: 'https://example.com/with',
              emoji: '🌐',
              imageUrl: 'https://cdn.example.com/link.png',
            },
            {
              label: 'Without emoji',
              url: 'https://example.com/without',
              imageUrl: 'https://cdn.example.com/plain.png',
            },
          ],
        }}
      />,
    );

    const withEmoji = screen.getByRole('link', { name: 'With emoji' });
    const image = withEmoji.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute('src', 'https://cdn.example.com/link.png');
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('aria-hidden', 'true');
    expect(image).toHaveAttribute('width', '20');
    expect(image).toHaveAttribute('height', '20');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveClass('h-5', 'w-5', 'rounded', 'object-cover');
    expect(withEmoji).not.toHaveTextContent('🌐');

    fireEvent.error(image!);
    expect(withEmoji.querySelector('img')).not.toBeInTheDocument();
    expect(withEmoji.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      '🌐',
    );
    expect(screen.getByRole('link', { name: 'With emoji' })).toBe(withEmoji);

    const withoutEmoji = screen.getByRole('link', { name: 'Without emoji' });
    fireEvent.error(withoutEmoji.querySelector('img')!);
    expect(withoutEmoji.querySelector('img')).not.toBeInTheDocument();
    expect(
      withoutEmoji.querySelector('[aria-hidden="true"]'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Without emoji' })).toBe(
      withoutEmoji,
    );
  });

  it('retries a link image when the builder changes its URL after an error', () => {
    const { rerender } = renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            {
              label: 'Site',
              url: 'https://example.com',
              emoji: '🌐',
              imageUrl: 'https://cdn.example.com/broken.png',
            },
          ],
        }}
      />,
    );

    const link = screen.getByRole('link', { name: 'Site' });
    fireEvent.error(link.querySelector('img')!);
    expect(link.querySelector('img')).not.toBeInTheDocument();
    expect(link).toHaveTextContent('🌐');

    rerender(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            {
              label: 'Site',
              url: 'https://example.com',
              emoji: '🌐',
              imageUrl: 'https://cdn.example.com/fixed.png',
            },
          ],
        }}
      />,
    );
    expect(link.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.example.com/fixed.png',
    );
    expect(link).not.toHaveTextContent('🌐');
  });

  it('renders a YouTube embed from the constructed nocookie URL with exact security attributes', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            {
              label: 'Video',
              url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              embed: true,
            },
          ],
        }}
      />,
    );

    const labelLink = screen.getByRole('link', { name: 'Video' });
    expect(labelLink).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(labelLink).toHaveAttribute('target', '_blank');
    expect(labelLink).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    const iframe = screen.getByTitle('Video');
    expect(iframe).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(iframe).toHaveAttribute('sandbox', EXPECTED_EMBED_SANDBOX);
    expect(iframe).toHaveAttribute('loading', 'lazy');
    // YouTube は Referer (origin) 無しだと error 153 で再生拒否 (2026-08-01 実機確認)。
    expect(iframe).toHaveAttribute(
      'referrerpolicy',
      'strict-origin-when-cross-origin',
    );
    expect(iframe).toHaveAttribute('scrolling', 'no');
    expect(iframe).toHaveClass('aspect-video', 'w-full');
    expect(labelLink.parentElement).toContainElement(iframe);
  });

  it.each([
    [
      'Niconico video',
      'https://www.nicovideo.jp/watch/sm9?from=share',
      'https://embed.nicovideo.jp/watch/sm9',
    ],
    [
      'Vimeo video',
      'https://vimeo.com/123456789',
      'https://player.vimeo.com/video/123456789',
    ],
  ] as const)(
    'renders the %s aspect-video embed with a rebuilt URL and no referrer',
    (label, url, src) => {
      renderWithIntl(
        <HandleProfileView
          config={multiConfig}
          profile={{ links: [{ label, url, embed: true }] }}
        />,
      );

      const iframe = screen.getByTitle(label);
      expect(iframe).toHaveAttribute('src', src);
      expect(iframe).not.toHaveAttribute('height');
      expect(iframe).toHaveAttribute('sandbox', EXPECTED_EMBED_SANDBOX);
      expect(iframe).toHaveAttribute('loading', 'lazy');
      expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(iframe).toHaveAttribute('scrolling', 'no');
      expect(iframe).toHaveClass('aspect-video', 'w-full');
    },
  );

  it.each([
    ['track', 152],
    ['album', 352],
  ] as const)(
    'renders a Spotify %s embed with its exact constructed URL and height',
    (type, height) => {
      const id = '4uLU6hMCjMI75M1A2tKUQC';
      renderWithIntl(
        <HandleProfileView
          config={multiConfig}
          profile={{
            links: [
              {
                label: `Spotify ${type}`,
                url: `https://open.spotify.com/${type}/${id}`,
                embed: true,
              },
            ],
          }}
        />,
      );

      const iframe = screen.getByTitle(`Spotify ${type}`);
      expect(iframe).toHaveAttribute(
        'src',
        `https://open.spotify.com/embed/${type}/${id}`,
      );
      expect(iframe).toHaveAttribute('height', String(height));
      expect(iframe).toHaveAttribute('sandbox', EXPECTED_EMBED_SANDBOX);
      expect(iframe).toHaveAttribute('loading', 'lazy');
      expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(iframe).toHaveAttribute('scrolling', 'no');
      expect(iframe).toHaveClass('w-full');
    },
  );

  it('renders an Audius compact track from embedResolved with exact height and security attributes', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            {
              label: 'Audius track',
              url: 'https://audius.co/openpay/slug-without-id',
              embed: true,
              embedResolved: {
                provider: 'audius',
                kind: 'track',
                id: 'AbC123xYz',
              },
            },
          ],
        }}
      />,
    );

    const iframe = screen.getByTitle('Audius track');
    expect(iframe).toHaveAttribute(
      'src',
      'https://audius.co/embed/track/AbC123xYz?flavor=compact',
    );
    expect(iframe).toHaveAttribute('height', '152');
    expect(iframe).toHaveAttribute('sandbox', EXPECTED_EMBED_SANDBOX);
    expect(iframe).toHaveAttribute('loading', 'lazy');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(iframe).toHaveAttribute('scrolling', 'no');
    expect(iframe).toHaveClass('w-full');
  });

  it.each([
    [
      'Apple Music album',
      'https://music.apple.com/jp/album/%E6%9D%B1%E4%BA%AC%20hits/123456789',
      'https://embed.music.apple.com/jp/album/%E6%9D%B1%E4%BA%AC%20hits/123456789',
      450,
      false,
    ],
    [
      'Apple Music song',
      'https://music.apple.com/us/album/song-name/123456789?i=987654321',
      'https://embed.music.apple.com/us/album/song-name/123456789?i=987654321',
      175,
      false,
    ],
    [
      'TikTok video',
      'https://tiktok.com/@alice/video/1234567890',
      'https://www.tiktok.com/embed/v2/1234567890',
      580,
      true,
    ],
    [
      'Suno song',
      'https://suno.com/song/123e4567-e89b-42d3-a456-426614174000',
      'https://suno.com/embed/123e4567-e89b-42d3-a456-426614174000',
      152,
      false,
    ],
    [
      'SoundCloud track',
      'https://soundcloud.com/artist_name/track-slug?utm_source=share',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist_name%2Ftrack-slug',
      166,
      false,
    ],
  ] as const)(
    'renders the %s fixed-height embed with exact provider dimensions',
    (label, url, src, height, isTikTok) => {
      renderWithIntl(
        <HandleProfileView
          config={multiConfig}
          profile={{ links: [{ label, url, embed: true }] }}
        />,
      );

      const iframe = screen.getByTitle(label);
      expect(iframe).toHaveAttribute('src', src);
      expect(iframe).toHaveAttribute('height', String(height));
      expect(iframe).toHaveAttribute('sandbox', EXPECTED_EMBED_SANDBOX);
      expect(iframe).toHaveAttribute('loading', 'lazy');
      expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(iframe).toHaveAttribute('scrolling', 'no');
      expect(iframe).toHaveClass('w-full');
      if (isTikTok) {
        expect(iframe).toHaveClass('mx-auto', 'max-w-[325px]');
      } else {
        expect(iframe).not.toHaveClass('mx-auto', 'max-w-[325px]');
      }
    },
  );

  it.each([
    ['clean', null],
    ['gradient', '0 3px 10px -3px'],
    ['bold', '0 4px 12px -4px'],
    ['outline', '1.5px'],
    ['night', 'rgba(255, 255, 255, 0.08)'],
    ['soft', 'border-radius: 22px'],
  ] as const)(
    'applies the normal %s linkStyle token to an embed card even when featured',
    (theme, styleMarker) => {
      renderWithIntl(
        <HandleProfileView
          config={multiConfig}
          profile={{
            theme,
            links: [
              {
                label: `Featured ${theme}`,
                url: 'https://youtu.be/dQw4w9WgXcQ',
                embed: true,
                featured: true,
              },
            ],
          }}
        />,
      );

      const cardStyle = screen
        .getByTitle(`Featured ${theme}`)
        .parentElement?.getAttribute('style');
      if (styleMarker === null) {
        expect(cardStyle).toBeNull();
      } else {
        expect(cardStyle).toContain(styleMarker);
      }
    },
  );

  it('falls back to the exact regular button path when embed extraction is unsupported', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            {
              label: 'Unsupported',
              url: 'https://example.com/video',
              embed: true,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByTitle('Unsupported')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Unsupported' });
    expect(link.getAttribute('class')).toBe(EXPECTED_CLEAN_LINK_CLASS);
    expect(link.getAttribute('style')).toBeNull();
    expect(link).toHaveAttribute('href', 'https://example.com/video');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('renders a heading as a semantic, non-interactive list row', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            { kind: 'heading', label: 'Highlights', emoji: '✨' },
            { label: 'Site', url: 'https://example.com' },
          ],
        }}
      />,
    );
    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'Highlights',
    });
    const row = heading.closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).queryByRole('link')).not.toBeInTheDocument();
    expect(heading.querySelector('[aria-hidden="true"]')?.textContent).toBe('✨');
    expect(heading.className).toBe(
      'w-full px-2 pb-1 pt-4 text-left text-xs font-semibold tracking-wide text-slate-500',
    );
    expect(heading.getAttribute('style')).toBeNull();
    expect(screen.getByRole('link', { name: 'Site' })).toBeInTheDocument();
  });

  it('renders a heading-only profile and keeps night headings readable', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [{ kind: 'heading', label: 'About' }],
          theme: 'night',
        }}
      />,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'About' });
    expect(heading.closest('ul')).toHaveClass(
      'mt-7',
      'flex',
      'w-full',
      'flex-col',
      'gap-2.5',
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(heading.className).toBe(
      'w-full px-2 pb-1 pt-4 text-left text-xs font-semibold tracking-wide',
    );
    expect(heading.getAttribute('style')).toContain('rgb(203, 213, 225)');
  });

  it('featured link gets an inline style even under the clean theme (emphasis)', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          links: [
            { label: 'Plain', url: 'https://x.com/a' },
            { label: 'Star', url: 'https://x.com/b', featured: true },
          ],
        }}
      />,
    );
    const plain = screen.getByRole('link', { name: 'Plain' });
    const star = screen.getByRole('link', { name: 'Star' });
    // 通常リンクは clean の class-only、featured は inline style で強調。
    expect(plain.getAttribute('style')).toBeNull();
    expect(star.getAttribute('style')).toContain('outline');
  });

  it('night theme uses light ink for the name (readability on dark bg)', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{ bio: 'hi', theme: 'night' }}
        handle="alice"
      />,
    );
    const name = screen.getByText('Alice');
    // ダーク背景で可読な明色 (#f8fafc)。text-slate-900 は付かない。
    expect(name.getAttribute('style')).toContain('rgb(248, 250, 252)');
    expect(name.className).not.toContain('text-slate-900');
  });

  it('renders social icon links (brand label for known, hostname for unknown)', () => {
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{
          socials: [
            'https://x.com/alice',
            'https://line.me/R/ti/p/@alice',
            'https://example.com/me',
          ],
        }}
      />,
    );
    const x = screen.getByRole('link', { name: 'X' });
    expect(x).toHaveAttribute('href', 'https://x.com/alice');
    expect(x).toHaveAttribute('target', '_blank');
    expect(x).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getByRole('link', { name: 'LINE' })).toHaveAttribute(
      'href',
      'https://line.me/R/ti/p/@alice',
    );
    // 未知ドメインは hostname がラベルになり globe アイコンで描画される
    expect(screen.getByRole('link', { name: 'example.com' })).toBeInTheDocument();
  });
});

describe('ReceiveMethodPicker', () => {
  // --- 初期状態: 全て折りたたみ ---

  it('renders all method buttons but no TipForm initially (multiple methods)', () => {
    renderWithIntl(<ReceiveMethodPicker config={multiConfig} />);
    // 3 つの方法ボタンが表示される
    expect(
      screen.getByRole('button', { name: 'JPYC · Polygon' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'JPYC · Kaia' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'USDC · cross-chain' }),
    ).toBeInTheDocument();
    expect(screen.getByText('通貨・チェーンを選ぶ')).toBeInTheDocument();
    // 初期状態では TipForm は描画しない
    expect(screen.queryByTestId('tipform')).not.toBeInTheDocument();
    // 全ボタンが aria-expanded=false
    const buttons = screen.getAllByRole('button');
    buttons.forEach((btn) => expect(btn).toHaveAttribute('aria-expanded', 'false'));
  });

  it('renders a button even for a single-method handle, with no TipForm initially', () => {
    // 旧実装: 単一方法は TipForm 直描画でボタン無し。
    // 新実装: 単一方法も初期スッキリ方針を統一 — ボタン 1 つ + クリックで展開。
    const single: HandleTipConfig = {
      to: ADDR,
      methods: [{ token: 'usdc', chain: 'base', crossChain: true }],
    };
    renderWithIntl(<ReceiveMethodPicker config={single} />);
    expect(
      screen.getByRole('button', { name: '♡ 応援する USDC · cross-chain' }),
    ).toBeInTheDocument();
    expect(screen.getByText('♡ 応援する')).toBeInTheDocument();
    expect(screen.getByText('USDC · cross-chain')).toBeInTheDocument();
    expect(screen.queryByText('通貨・チェーンを選ぶ')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tipform')).not.toBeInTheDocument();
  });

  // --- クリックで展開 ---

  it('expands TipForm below the clicked button (accordion open)', () => {
    renderWithIntl(<ReceiveMethodPicker config={multiConfig} />);
    const polyBtn = screen.getByRole('button', { name: 'JPYC · Polygon' });
    fireEvent.click(polyBtn);
    // TipForm が JPYC Polygon の params で mount される
    expect(screen.getByTestId('tipform')).toHaveTextContent('jpyc:polygon');
    // クリックしたボタンが aria-expanded=true
    expect(polyBtn).toHaveAttribute('aria-expanded', 'true');
    // 他のボタンは aria-expanded=false のまま
    expect(
      screen.getByRole('button', { name: 'JPYC · Kaia' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands TipForm for a single-method handle on button click', () => {
    const single: HandleTipConfig = {
      to: ADDR,
      methods: [{ token: 'usdc', chain: 'base', crossChain: true }],
    };
    renderWithIntl(<ReceiveMethodPicker config={single} />);
    fireEvent.click(screen.getByRole('button', { name: '♡ 応援する USDC · cross-chain' }));
    expect(screen.getByTestId('tipform')).toHaveTextContent('usdc:base');
  });

  // --- 同じボタン再クリックで折りたたみ ---

  it('collapses the TipForm when the same button is clicked again (toggle)', () => {
    renderWithIntl(<ReceiveMethodPicker config={multiConfig} />);
    const polyBtn = screen.getByRole('button', { name: 'JPYC · Polygon' });
    // 1 回目: 展開
    fireEvent.click(polyBtn);
    expect(screen.getByTestId('tipform')).toBeInTheDocument();
    expect(polyBtn).toHaveAttribute('aria-expanded', 'true');
    // 2 回目: 折りたたみ
    fireEvent.click(polyBtn);
    expect(screen.queryByTestId('tipform')).not.toBeInTheDocument();
    expect(polyBtn).toHaveAttribute('aria-expanded', 'false');
  });

  // --- 別ボタンで展開先が切り替わる ---

  it('switches the expanded TipForm when a different button is clicked', () => {
    renderWithIntl(<ReceiveMethodPicker config={multiConfig} />);
    // JPYC Polygon を展開
    fireEvent.click(screen.getByRole('button', { name: 'JPYC · Polygon' }));
    expect(screen.getByTestId('tipform')).toHaveTextContent('jpyc:polygon');
    // JPYC Kaia に切り替え
    fireEvent.click(screen.getByRole('button', { name: 'JPYC · Kaia' }));
    expect(screen.getByTestId('tipform')).toHaveTextContent('jpyc:kaia');
    // Polygon ボタンは折りたたまれる
    expect(
      screen.getByRole('button', { name: 'JPYC · Polygon' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('button', { name: 'JPYC · Kaia' }),
    ).toHaveAttribute('aria-expanded', 'true');
    // TipForm は 1 つだけ mount (同時 mount なし)
    expect(screen.getAllByTestId('tipform')).toHaveLength(1);
  });
});
