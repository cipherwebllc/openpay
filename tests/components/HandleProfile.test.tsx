import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
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
    const cleanClass = noTheme.getAttribute('class');
    // theme 無しのリンクは inline style を持たない (現行と一致)。
    expect(noTheme.getAttribute('style')).toBeNull();
    unmount();
    // 明示 theme:'clean' でも同一 className + inline style 無し。
    renderWithIntl(
      <HandleProfileView
        config={multiConfig}
        profile={{ links, theme: 'clean' }}
      />,
    );
    const cleanExplicit = screen.getByRole('link', { name: 'My X' });
    expect(cleanExplicit.getAttribute('class')).toBe(cleanClass);
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
