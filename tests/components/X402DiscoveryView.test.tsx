import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// wagmi / SIWE を最小モック (実 wallet グラフを描画せず OOM を避ける)。
const state = vi.hoisted(() => ({
  connected: false,
  address: undefined as string | undefined,
  signedIn: false,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address, isConnected: state.connected }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.signedIn,
    signIn: vi.fn(async () => {}),
    isSigningIn: false,
  }),
}));

import { X402DiscoveryView } from '@/components/X402DiscoveryView';

const ITEM = {
  resource: 'https://api.example.jp/paid/translate',
  description: 'JP→EN 翻訳 API です',
  category: 'api',
  priceJpyc: '1000',
  accepts: [{ extra: { openpay: { feeValue: (10n * 10n ** 18n).toString() } } }],
};

beforeEach(() => {
  state.connected = false;
  state.address = undefined;
  state.signedIn = false;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ x402Version: 1, items: [ITEM] }),
  })) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('X402DiscoveryView', () => {
  it('未接続: connectPrompt を表示し、カタログを /api/discovery から列挙', async () => {
    renderWithIntl(<X402DiscoveryView />);
    // カタログ (公開・wallet 不要) が描画される。
    expect(await screen.findByText('JP→EN 翻訳 API です')).toBeInTheDocument();
    expect(screen.getByText(ITEM.resource)).toBeInTheDocument();
    // fee 注記 (手数料 10 JPYC)。
    expect(screen.getByText(/手数料 10 JPYC/)).toBeInTheDocument();
    // 未接続 → 登録には接続を促す。
    expect(
      screen.getByText('登録するにはウォレットを接続してください (画面上部)。'),
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/discovery', { cache: 'no-store' });
  });

  it('サインイン済: 登録フォーム (URL/価格 入力) を表示', async () => {
    state.connected = true;
    state.address = '0x1111111111111111111111111111111111111111';
    state.signedIn = true;
    renderWithIntl(<X402DiscoveryView />);
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/リソース URL/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText('価格 (JPYC・整数)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument();
  });
});
