import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

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
      <HandleClaimPanel
        payload={config ? { config, profile: {} } : null}
        {...extra}
      />
    </QueryClientProvider>,
  );
}

// サインイン済みフロー用: GET /api/handle (mine) を所有1件で応答する fetch スタブ。
function stubMine(
  handles: {
    handle: string;
    config: HandleTipConfig;
    profile?: HandleProfile;
    updatedAt?: number;
  }[],
) {
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

  it('サインイン済み: 所有一覧が先頭 (編集/削除 のみ) + 新規取得セクション', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    renderPanel(CONFIG, { onEdit: vi.fn() });
    await waitFor(() =>
      expect(screen.getByText('@alice')).toBeInTheDocument(),
    );
    // 行ボタンは 編集/削除 の 2 つのみ (開く/コピー/QR は ④ プレビュー下へ移動)。
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '開く' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'コピー' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QRコード' })).not.toBeInTheDocument();
    expect(screen.getByText('新しいハンドルを取得')).toBeInTheDocument();
  });

  it('編集モード: バナー + 編集をやめる + 別名入力で複製警告', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    const onStopEditing = vi.fn();
    renderPanel(CONFIG, { editingHandle: 'alice', onStopEditing });
    await waitFor(() =>
      expect(screen.getByText('@alice')).toBeInTheDocument(),
    );
    // バナーは一覧側 (該当行) とフォーム側の両方に出る
    expect(screen.getAllByText('公開中 @alice').length).toBeGreaterThan(0);
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

  it('publish (新規): POST body に handle/config/profile・成功メッセージ + onPublished', async () => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/handle' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ ok: true, handle: 'bob', status: 'created' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === '/api/handle') {
        return new Response(JSON.stringify({ ok: true, handles: [], max: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, available: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onPublished = vi.fn();
    renderPanel(CONFIG, {
      payload: { config: CONFIG, profile: { bio: 'hi' } },
      onPublished,
    });
    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'bob' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'この handle を取得' }));
    await waitFor(() =>
      expect(
        screen.getByText('「@bob」を取得しました！続けてこのまま編集・更新できます。'),
      ).toBeInTheDocument(),
    );
    expect(onPublished).toHaveBeenCalledWith({
      handle: 'bob',
      payload: { config: CONFIG, profile: { bio: 'hi' } },
      updatedAt: expect.any(Number),
    });
    // POST body が現在の config/profile をそのまま運ぶこと (机上でなく実検証)
    const post = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      handle: 'bob',
      config: CONFIG,
      profile: { bio: 'hi' },
    });
    // 入力は消えず、ボタンは更新系へ… (所有一覧 invalidate 後の再取得は stub が [] を返すため
    // ownedNames には載らないが、入力値が保持されることだけ確認)
    expect(screen.getByPlaceholderText('alice')).toHaveValue('bob');
  });

  it('publish (更新): updated ステータスで「更新しました」を表示', async () => {
    h.isSignedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/handle' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ ok: true, handle: 'alice', status: 'updated' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u === '/api/handle') {
          return new Response(
            JSON.stringify({ ok: true, handles: [{ handle: 'alice', config: CONFIG }], max: 3 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true, available: false, reason: 'taken' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderPanel(CONFIG, { editingHandle: 'alice', isDirty: true });
    await waitFor(() =>
      expect(screen.getByText('@alice')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'alice' },
    });
    // 自分の所有 handle は「使用済み」でも更新ボタンが有効
    const update = screen.getByRole('button', { name: '設定を更新' });
    expect(update.className).toContain('ring-2');
    fireEvent.click(update);
    await waitFor(() =>
      expect(screen.getByText('「@alice」を更新しました。')).toBeInTheDocument(),
    );
  });

  it('一覧取得の KV 障害 (502) は「0件」に偽装せずエラー + 再試行を表示', async () => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/handle') {
        return new Response(JSON.stringify({ ok: false, error: 'kv_error' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(CONFIG);
    await waitFor(() =>
      expect(
        screen.getByText('取得済みハンドルの一覧を読み込めませんでした。'),
      ).toBeInTheDocument(),
    );
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('空き確認の KV 障害 (reason:unavailable) は「使用済み」と偽らず「確認できない」', async () => {
    h.isSignedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === '/api/handle') {
          return new Response(JSON.stringify({ ok: true, handles: [], max: 3 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // GET /api/handle/{h}: KV outage は available:false + reason:'unavailable'
        return new Response(
          JSON.stringify({ ok: true, available: false, reason: 'unavailable' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderPanel(CONFIG);
    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'bob' },
    });
    await waitFor(
      () =>
        expect(
          screen.getByText(
            '空き状況を確認できませんでした。時間をおいて再度お試しください。',
          ),
        ).toBeInTheDocument(),
      { timeout: 3000 }, // debounce 350ms を跨ぐ
    );
    expect(screen.queryByText('すでに使用されています')).not.toBeInTheDocument();
  });

  it('削除クリックで danger 確認モーダルを表示 (window.confirm でなく dialog)', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    renderPanel(CONFIG);
    await waitFor(() => expect(screen.getByText('@alice')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // モーダル見出し (releaseModalTitle) を表示する。
    expect(screen.getByText('@alice を削除しますか？')).toBeInTheDocument();
  });

  it('キャンセルで DELETE を発火せずモーダルを閉じる', async () => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url) === '/api/handle') {
        return new Response(
          JSON.stringify({ ok: true, handles: [{ handle: 'alice', config: CONFIG }], max: 3 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(CONFIG);
    await waitFor(() => expect(screen.getByText('@alice')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // DELETE は一度も呼ばれていない (mine の GET のみ)。
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('ESC でも確認モーダルを閉じる (DELETE 不発)', async () => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url) === '/api/handle') {
        return new Response(
          JSON.stringify({ ok: true, handles: [{ handle: 'alice', config: CONFIG }], max: 3 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(CONFIG);
    await waitFor(() => expect(screen.getByText('@alice')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('「解放する」で DELETE fetch が発火 → 失敗は無言にせずエラー表示', async () => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/handle') {
        return new Response(
          JSON.stringify({ ok: true, handles: [{ handle: 'alice', config: CONFIG }], max: 3 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: false, error: 'kv_error' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(CONFIG);
    await waitFor(() => expect(screen.getByText('@alice')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    // モーダルの確定ボタン (releaseModalConfirm) で DELETE 発火。
    fireEvent.click(screen.getByRole('button', { name: '解放する' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByText('解放に失敗しました (kv_error)')).toBeInTheDocument(),
    );
  });

  it('編集中の handle を解放したら編集モードを解除する (onStopEditing 呼出)', async () => {
    h.isSignedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/handle') {
          return new Response(
            JSON.stringify({ ok: true, handles: [{ handle: 'alice', config: CONFIG }], max: 3 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (init?.method === 'DELETE') {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const onStopEditing = vi.fn();
    renderPanel(CONFIG, { editingHandle: 'alice', onStopEditing });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(screen.getByRole('button', { name: '解放する' }));
    await waitFor(() => expect(onStopEditing).toHaveBeenCalled());
  });
});
