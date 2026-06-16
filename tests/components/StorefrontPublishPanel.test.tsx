// StorefrontPublishPanel を実描画で検証: SIWE 状態 / 所有 handle 取得 / 公開 POST の body /
// 固定URL 表示 / 公開済み表示 / メニュー未充足の無効化。env/useSiweSession/useOrigin/fetch をモック。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import type { StorefrontParts } from '@/lib/mobileOrder';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({ isSignedIn: true }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableHandles() { return true; } } };
});
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://open-pay.jp' }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    sessionAddress: h.isSignedIn ? ADDR : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    mismatch: false,
    isLoading: false,
  }),
}));

import { StorefrontPublishPanel } from '@/components/StorefrontPublishPanel';

const STORE: StorefrontParts = {
  chain: 'polygon',
  mode: 'storefront',
  feePayer: 'merchant',
  menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
};
const CFG = { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }] };

function renderPanel(
  props: Partial<{ storefront: StorefrontParts | null; onGetHandle: () => void }> = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <StorefrontPublishPanel
        storefront={props.storefront === undefined ? STORE : props.storefront}
        onGetHandle={props.onGetHandle}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.isSignedIn = true;
  vi.unstubAllGlobals();
});

describe('StorefrontPublishPanel', () => {
  it('未サインインはサインインボタンを出す (handle 取得しない)', () => {
    h.isSignedIn = false;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    expect(screen.getByText('サインインして公開')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled(); // mine query は未サインインで無効
  });

  it('handle 0件は @handle 取得導線を出す (onGetHandle 発火)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ handles: [] }) }),
    );
    const onGetHandle = vi.fn();
    renderPanel({ onGetHandle });
    expect(await screen.findByText(/先に @handle/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('プロフィールで @handle を取得'));
    expect(onGetHandle).toHaveBeenCalled();
  });

  it('handle を公開 → POST に config+storefront を送り固定URLを表示', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : { ok: true, status: 200, json: async () => ({ handles: [{ handle: 'shop', config: CFG }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE });
    const btn = await screen.findByRole('button', { name: 'この @handle に公開' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    // POST body: handle + 既存 config 再送 + storefront。
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeTruthy();
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body.handle).toBe('shop');
    expect(body.config).toEqual(CFG);
    expect(body.storefront).toEqual(STORE);
    // 固定店舗 URL。
    expect(screen.getByText('https://open-pay.jp/@shop')).toBeInTheDocument();
  });

  it('公開済み handle は「公開を更新」+ (公開済み) を出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG, storefront: STORE }] }),
      }),
    );
    renderPanel({ storefront: STORE });
    expect(await screen.findByRole('button', { name: '公開を更新' })).toBeInTheDocument();
    expect(screen.getByText(/公開済み/)).toBeInTheDocument();
  });

  it('メニュー未充足 (storefront=null) は公開ボタンを無効化し注記', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG }] }),
      }),
    );
    renderPanel({ storefront: null });
    const btn = await screen.findByRole('button', { name: 'この @handle に公開' });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/公開するには有効な JPYC 商品/)).toBeInTheDocument();
  });

  it('HandleClaim が先に埋めた {handles,max} 形の共有 cache を読んでも落ちない (キー共有・回帰)', async () => {
    // profile タブで HandleClaimPanel が先に ['handle-mine', addr] を {handles,max} で埋めた状態を再現。
    // 修正前は handles がオブジェクトのまま handles.find が呼ばれてクラッシュしていた。
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['handle-mine', ADDR], { handles: [{ handle: 'shop', config: CFG }], max: 3 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG }], max: 3 }),
      }),
    );
    renderWithIntl(
      <QueryClientProvider client={qc}>
        <StorefrontPublishPanel storefront={STORE} />
      </QueryClientProvider>,
    );
    // クラッシュせず公開ボタンが出る (handles は配列として読まれる)。
    expect(await screen.findByRole('button', { name: 'この @handle に公開' })).toBeInTheDocument();
  });

  it('handle 読み込みエラー (502) は正直にエラー表示 (0件と偽装しない)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'kv_error' }) }),
    );
    renderPanel();
    expect(await screen.findByText(/読み込みに失敗/)).toBeInTheDocument();
  });
});
