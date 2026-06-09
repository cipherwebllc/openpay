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
});

describe('ReceiveMethodPicker', () => {
  it('renders a button per method and switches the TipForm on select', () => {
    renderWithIntl(<ReceiveMethodPicker config={multiConfig} />);
    // 3 つの方法ボタン
    expect(
      screen.getByRole('button', { name: 'JPYC (Polygon) で応援' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'JPYC (Kaia) で応援' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'USDC (cross-chain) で応援' }),
    ).toBeInTheDocument();
    // 既定は最初の方法
    expect(screen.getByTestId('tipform')).toHaveTextContent('jpyc:polygon');
    // 2 つ目を選ぶと TipForm が切り替わる
    fireEvent.click(screen.getByRole('button', { name: 'JPYC (Kaia) で応援' }));
    expect(screen.getByTestId('tipform')).toHaveTextContent('jpyc:kaia');
  });

  it('renders the TipForm directly (no buttons) for a single-method handle', () => {
    const single: HandleTipConfig = {
      to: ADDR,
      methods: [{ token: 'usdc', chain: 'base', crossChain: true }],
    };
    renderWithIntl(<ReceiveMethodPicker config={single} />);
    expect(screen.getByTestId('tipform')).toHaveTextContent('usdc:base');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
