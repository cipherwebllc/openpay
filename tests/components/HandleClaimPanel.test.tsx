import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HandleTipConfig } from '@/lib/handle';

// env フラグ / SIWE 状態を制御する hoisted state。
const h = vi.hoisted(() => ({ enableHandles: true, isSignedIn: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
    },
  };
});
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    sessionAddress: h.isSignedIn
      ? '0x52d4901142e2B5680027da5EB47C86CB02a3cA81'
      : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));

import { HandleClaimPanel } from '@/components/HandleClaimPanel';

const CONFIG: HandleTipConfig = {
  to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  methods: [{ token: 'jpyc', chain: 'polygon' }],
};

function renderPanel(
  config: HandleTipConfig | null,
  extra?: Partial<Parameters<typeof HandleClaimPanel>[0]>,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <HandleClaimPanel config={config} {...extra} />
    </QueryClientProvider>,
  );
}

// サインイン済みフロー用: GET /api/handle (mine) を所有1件で応答する fetch スタブ。
function stubMine(handles: { handle: string; config: HandleTipConfig }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === '/api/handle') {
        return new Response(JSON.stringify({ ok: true, handles, max: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, available: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  h.enableHandles = true;
  h.isSignedIn = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HandleClaimPanel', () => {
  it('flag OFF → 何も描画しない (inert)', () => {
    h.enableHandles = false;
    const { container } = renderPanel(CONFIG);
    expect(container).toBeEmptyDOMElement();
  });

  it('flag ON + 未サインイン → config の有無に関わらずサインインボタン (編集到達性)', () => {
    // config 無しでもサインインを出す (既存 handle の編集/解放を受取先未設定でも到達可能に)。
    renderPanel(null);
    expect(
      screen.getByRole('button', { name: 'サインインして取得' }),
    ).toBeInTheDocument();
  });

  it('flag ON + config あり + 未サインイン → サインインボタン', () => {
    renderPanel(CONFIG);
    expect(
      screen.getByRole('button', { name: 'サインインして取得' }),
    ).toBeInTheDocument();
  });

  it('サインイン済み: 所有一覧が先頭 (編集/開く/コピー/解放) + 新規取得セクション', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    renderPanel(CONFIG, { onEdit: vi.fn() });
    await waitFor(() =>
      expect(screen.getByText('https://test.local/@alice')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    const open = screen.getByRole('link', { name: '開く' });
    expect(open).toHaveAttribute('href', 'https://test.local/@alice');
    expect(open).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: '解放' })).toBeInTheDocument();
    expect(screen.getByText('新しいハンドルを取得')).toBeInTheDocument();
  });

  it('編集モード: バナー + 編集をやめる + 別名入力で複製警告', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    const onStopEditing = vi.fn();
    renderPanel(CONFIG, { editingHandle: 'alice', onStopEditing });
    await waitFor(() =>
      expect(screen.getByText('https://test.local/@alice')).toBeInTheDocument(),
    );
    // バナーは一覧側 (該当行) とフォーム側の両方に出る
    expect(screen.getAllByText('「@alice」を編集中').length).toBeGreaterThan(0);
    // 別名を入力すると「同内容の複製になる」事前警告
    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'bob' },
    });
    expect(
      screen.getByText(
        '「@alice」はそのまま残し、同じ内容で新しいハンドル「@bob」を取得します。',
      ),
    ).toBeInTheDocument();
    // 編集をやめる → 親へ通知
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    expect(onStopEditing).toHaveBeenCalled();
  });
});
