import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
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

// owner 一覧 (GET /api/facilitator/resources)。url/description はカタログの ITEM と被らせない
// (両方描画されるので getByText が一意になるように)。
const OWNED = {
  id: 'res-1',
  url: 'https://api.example.jp/paid/owned',
  description: '自分の有料 API',
  priceJpyc: '1000',
  category: 'api',
  payTo: '0x1111111111111111111111111111111111111111',
};

// URL+method でルーティングする fetch モック (編集/削除の呼び出しを検証)。
function installRoutingFetch(owned: Array<typeof OWNED>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u === '/api/discovery') {
      return { ok: true, json: async () => ({ x402Version: 1, items: [ITEM] }) };
    }
    if (u === '/api/facilitator/resources' && method === 'GET') {
      return { ok: true, json: async () => ({ resources: owned }) };
    }
    if (u.startsWith('/api/facilitator/resources/') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, json: async () => ({ resource: body }) };
    }
    if (u.startsWith('/api/facilitator/resources/') && method === 'DELETE') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u === '/api/facilitator/resources' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, json: async () => ({ resource: body, paywallSnippet: 'snippet' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  state.connected = false;
  state.address = undefined;
  state.signedIn = false;
  // onEdit は window.scrollTo を呼ぶ (jsdom 未実装) → no-op で stub。
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ x402Version: 1, items: [ITEM] }),
  })) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// owner サインイン状態で描画する共通ヘルパ。
function renderAsOwner(owned: Array<typeof OWNED> = [OWNED]): ReturnType<typeof vi.fn> {
  state.connected = true;
  state.address = OWNED.payTo;
  state.signedIn = true;
  const fetchFn = installRoutingFetch(owned);
  renderWithIntl(<X402DiscoveryView />);
  return fetchFn;
}

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

  it('owner: 自分の登録一覧 (あなたの登録) を編集/削除ボタン付きで表示', async () => {
    renderAsOwner();
    expect(await screen.findByText('あなたの登録')).toBeInTheDocument();
    expect(screen.getByText('自分の有料 API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
  });

  it('編集: 編集ボタンでフォームに値が入り PATCH /resources/:id を呼ぶ', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    // フォームが編集モードになり、対象の値が入る。
    await waitFor(() => expect(screen.getByDisplayValue(OWNED.url)).toBeInTheDocument());
    expect(screen.getByText('掲載を編集')).toBeInTheDocument();
    // 価格を書き換えて更新。
    const price = screen.getByPlaceholderText('価格 (JPYC・整数)');
    fireEvent.change(price, { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${OWNED.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    expect(await screen.findByText('更新しました。')).toBeInTheDocument();
  });

  it('編集キャンセル: キャンセルでフォームが登録モードに戻る', async () => {
    renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await waitFor(() => expect(screen.getByText('掲載を編集')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: '更新する' })).not.toBeInTheDocument();
  });

  it('削除: 確認 → 削除する で DELETE /resources/:id を呼び「削除しました」', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    expect(await screen.findByText('この掲載を削除しますか？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${OWNED.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(await screen.findByText('削除しました。')).toBeInTheDocument();
  });

  it('削除キャンセル: やめる で DELETE を呼ばない', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument(),
    );
    expect(screen.queryByText('この掲載を削除しますか？')).not.toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining(`/api/facilitator/resources/${OWNED.id}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
