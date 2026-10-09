import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

// env フラグ / SIWE 状態を制御する hoisted state。
const h = vi.hoisted(() => ({ enableHandles: true, isSignedIn: false, isConnected: true, walletAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as string | undefined, signInError: null as string | null }));
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
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected, address: h.walletAddress }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    sessionAddress: h.isSignedIn
      ? '0x52d4901142e2B5680027da5EB47C86CB02a3cA81'
      : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: h.signInError,
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
  locale: 'ja' | 'en' = 'ja',
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 公開のボタンは帯 (ビルダーが渡す描画先) の 1 つだけ。既定で描画先を 1 つ用意する。
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <HandleClaimPanel
        payload={config ? { config, profile: {} } : null}
        barSlots={[slot]}
        {...extra}
      />
    </QueryClientProvider>,
    { locale },
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
  h.isConnected = true;
  h.walletAddress = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
  h.signInError = null;
  h.enableHandles = true;
  h.isSignedIn = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HandleClaimPanel', () => {
  it.each([
    [false, '0x52d4901142e2B5680027da5EB47C86CB02a3cA81'],
    [true, undefined],
  ])('未接続またはアドレス未確定では接続導線を表示し、サインインエラーを隠す (%s, %s)', (connected, address) => {
    h.isSignedIn = false;
    h.isConnected = connected;
    h.walletAddress = address;
    h.signInError = 'wallet_not_connected';
    renderPanel(null);
    expect(screen.getByText('接続すると、サインインできます。')).toBeInTheDocument();
    // 未接続はボタン 1 つ (押すとウォレットの一覧を開く)。
    fireEvent.click(screen.getByRole('button', { name: 'ウォレットを接続' }));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'サインインして取得' })).not.toBeInTheDocument();
    expect(screen.queryByText('サインインできませんでした。ウォレットで署名を承認して、もう一度お試しください。')).not.toBeInTheDocument();
  });

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

  it('接続済みの状態を短縮アドレスとともに表示する', () => {
    renderPanel(null);
    expect(screen.getByText('接続済み: 0x52d4…cA81。取得にはサインインが必要です。')).toBeInTheDocument();
  });

  it('サインイン済みでも「サインイン済み: 0x…」の行は出さない (ヘッダと受け取りのカードが示す)・説明は未取得の人にだけ', async () => {
    h.isSignedIn = true;
    stubMine([]);
    const first = renderPanel(CONFIG);
    expect(screen.queryByText(/サインイン済み: /)).toBeNull();
    expect(screen.getByText('覚えやすい固定リンク。受取先や金額を変えてもリンクは不変です。')).toBeInTheDocument();
    first.unmount();
    stubMine([{ handle: 'alice', config: CONFIG }]);
    renderPanel(CONFIG);
    await screen.findByText('@alice');
    expect(screen.queryByText('覚えやすい固定リンク。受取先や金額を変えてもリンクは不変です。')).toBeNull();
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

  it('編集モード: 一覧の該当行に公開中の表示 + 別名入力で複製警告', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    renderPanel(CONFIG, { editingHandle: 'alice' });
    // 編集中は公開の帯にも @alice が出るので、一覧の行が届くのを待つ。
    await screen.findByText('編集中');
    // 編集中の行に「編集中」(公開状態・更新時刻・編集をやめる はビルダーの「あなたのページ」の見出しの下に 1 か所)。
    expect(within(screen.getByRole('listitem')).getByText('編集中')).toBeInTheDocument();
    expect(screen.queryByText('公開中 @alice')).toBeNull();
    expect(screen.queryByRole('button', { name: '編集をやめる' })).toBeNull();
    // 編集中の @handle には「編集」を出さない・@handle の入力欄は畳む (公開先は編集中の @handle)。
    expect(screen.queryByRole('button', { name: '編集' })).toBeNull();
    expect(screen.queryByPlaceholderText('alice')).toBeNull();
    expect(screen.getByRole('button', { name: '公開を更新' })).toBeInTheDocument();
    // 「新しいハンドルを取得」で入力欄を開き、別名を入力すると「同内容の複製になる」事前警告
    fireEvent.click(screen.getByRole('button', { name: '新しいハンドルを取得' }));
    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'bob' },
    });
    expect(
      screen.getByText(
        '「@alice」はそのまま残し、同じ内容で新しいハンドル「@bob」を取得します。',
      ),
    ).toBeInTheDocument();
    // 「やめる」で入力欄を畳み、公開先を編集中の @alice に戻す。
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByPlaceholderText('alice')).toBeNull();
    expect(screen.getByRole('button', { name: '公開を更新' })).toBeInTheDocument();
  });

  it('この端末が手付かずで @handle が 1 つだけなら、サインイン時にその編集へ 1 回だけ自動で入る', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    const onEdit = vi.fn();
    renderPanel(CONFIG, { canAutoEdit: () => true, onEdit });
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith('alice', CONFIG, undefined, undefined));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('一覧の取得を待つあいだに @handle を打ち始めたら、自動で編集に入らず打った文字を残す', async () => {
    h.isSignedIn = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === '/api/handle') {
          await gate;
          return new Response(JSON.stringify({ ok: true, handles: [{ handle: 'alice', config: CONFIG }], max: 3 }), {
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
    const onEdit = vi.fn();
    renderPanel(CONFIG, { canAutoEdit: () => true, onEdit });
    const input = screen.getByPlaceholderText('alice');
    fireEvent.change(input, { target: { value: 'bob' } });
    release();
    await screen.findByText('@alice');
    expect(onEdit).not.toHaveBeenCalled();
    expect(input).toHaveValue('bob');
  });

  it('@handle が 2 つ以上・この端末に手が入っているときは自動で編集に入らない', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }, { handle: 'bob', config: CONFIG }]);
    const onEdit = vi.fn();
    const first = renderPanel(CONFIG, { canAutoEdit: () => true, onEdit });
    await screen.findByText('@bob');
    expect(onEdit).not.toHaveBeenCalled();
    first.unmount();
    stubMine([{ handle: 'alice', config: CONFIG }]);
    const check = vi.fn(() => false);
    renderPanel(CONFIG, { canAutoEdit: check, onEdit });
    await screen.findByText('@alice');
    // 親はそのレコードと下書きを比べて決める (公開中と同じ下書きなら入る・違えば入らない)。
    expect(check).toHaveBeenCalledWith(CONFIG, undefined);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('上限まで取得済みで編集していないときは、新しい @handle の入力欄を出さず「編集」へ案内する', async () => {
    h.isSignedIn = true;
    stubMine([
      { handle: 'alice', config: CONFIG },
      { handle: 'bob', config: CONFIG },
      { handle: 'carol', config: CONFIG },
    ]);
    renderPanel(CONFIG, { onEdit: vi.fn() });
    expect(await screen.findByText('@carol')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('alice')).toBeNull();
    expect(screen.getByText('@handle は 3 個まで取得できます。更新するときは上の一覧で「編集」を押してください。')).toBeInTheDocument();
    expect(screen.getByText('一覧の「編集」から更新できます')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '公開する' })).toBeDisabled();
  });

  it('公開のボタンは帯の 1 つだけ (カードの中に同じ働きのボタンを並べない)', async () => {
    h.isSignedIn = true;
    stubMine([]);
    renderPanel(CONFIG);
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'bob' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '公開する' })).toBeEnabled());
    expect(screen.getAllByRole('button', { name: /公開|取得|更新/ })).toHaveLength(1);
  });

  it('公開ボタンの帯 (スマホ下部・PC プレビュー下) にも同じ公開処理を描く・押せない理由を 1 行', async () => {
    h.isSignedIn = true;
    stubMine([]);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    renderPanel(CONFIG, { barSlots: [slot] });
    // @handle を決めるまでは押せない理由を出す。
    expect(await within(slot).findByText('@handle を決めると公開できます')).toBeInTheDocument();
    expect(within(slot).getByRole('button', { name: '公開する' })).toBeDisabled();
  });

  it('publish (新規): POST body に handle/config/profile・成功メッセージ + onPublished', async () => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/handle' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            handle: 'bob',
            status: 'created',
            updatedAt: 500,
          }),
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
    fireEvent.click(screen.getByRole('button', { name: '公開する' }));
    await waitFor(() =>
      expect(
        screen.getByText('「@bob」を取得しました！続けてこのまま編集・更新できます。'),
      ).toBeInTheDocument(),
    );
    expect(onPublished).toHaveBeenCalledWith({
      handle: 'bob',
      payload: { config: CONFIG, profile: { bio: 'hi' } },
      updatedAt: 500,
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

  it.each(['alice', 'store'])('publishes updates for an owned %s, including newly reserved names', async (handle) => {
    h.isSignedIn = true;
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/handle' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              ok: true,
              handle,
              status: 'updated',
              updatedAt: 201,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u === '/api/handle') {
          return new Response(
            JSON.stringify({
              ok: true,
              handles: [{ handle, config: CONFIG, updatedAt: 200 }],
              max: 3,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true, available: false, reason: 'taken' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const onPublished = vi.fn();
    renderPanel(CONFIG, {
      editingHandle: handle,
      expectedUpdatedAt: 200,
      isDirty: true,
      onPublished,
    });
    await screen.findByText('編集中');
    // 編集に入ると公開先 (畳んだ入力欄) は編集中の @handle。自分の所有 handle は「使用済み」でも更新ボタンが有効
    const update = screen.getByRole('button', { name: '公開を更新' });
    // 未公開の変更があることは帯の左に出す (押す前に気づける)。
    expect(update.parentElement).toHaveTextContent('未公開の変更があります');
    fireEvent.click(update);
    await waitFor(() =>
      expect(screen.getByText(`「@${handle}」を更新しました。`)).toBeInTheDocument(),
    );
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      handle,
      config: CONFIG,
      profile: {},
      expectedUpdatedAt: 200,
    });
    expect(onPublished).toHaveBeenCalledWith({
      handle,
      payload: { config: CONFIG, profile: {} },
      updatedAt: 201,
    });
  });

  it.each([
    [
      'ja' as const,
      '公開する',
      'Audius のトラックを確認できず、埋め込み表示を有効にできないため保存できませんでした。URL を確認して、もう一度お試しください。',
    ],
    [
      'en' as const,
      'Publish',
      'Could not save because the Audius track could not be verified for embedding. Check the URL and try again.',
    ],
  ])('Audius resolve failure shows the dedicated %s builder error', async (locale, button, message) => {
    h.isSignedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === '/api/handle' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ ok: false, error: 'audius resolve failed' }),
            {
              status: 400,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (String(url) === '/api/handle') {
          return new Response(
            JSON.stringify({ ok: true, handles: [], max: 3 }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, available: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderPanel(CONFIG, undefined, locale);
    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'bob' },
    });
    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.queryByText(/audius resolve failed/)).not.toBeInTheDocument();
    // 帯から押したときにも気づけるよう、帯に 1 行 (理由はカード側)。
    expect(screen.getByRole('alert')).toHaveTextContent(locale === 'ja' ? '公開できませんでした' : "Couldn't publish");
  });

  it('publish 409 conflict → 専用文言・最新一覧を再取得・明示再読込で baseline を更新', async () => {
    h.isSignedIn = true;
    let mineReads = 0;
    const onEdit = vi.fn();
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/handle' && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: false, error: 'conflict' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u === '/api/handle') {
          mineReads += 1;
          const updatedAt = mineReads === 1 ? 200 : 300;
          return new Response(
            JSON.stringify({
              ok: true,
              handles: [{ handle: 'alice', config: CONFIG, updatedAt }],
              max: 3,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, available: false, reason: 'taken' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(CONFIG, {
      editingHandle: 'alice',
      expectedUpdatedAt: 200,
      onEdit,
    });
    await screen.findByText('編集中');
    fireEvent.click(screen.getByRole('button', { name: '公開を更新' }));
    await waitFor(() =>
      expect(
        screen.getByText('別の端末で更新されました。再読込してください。'),
      ).toBeInTheDocument(),
    );
    expect(mineReads).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole('button', { name: '再読込' }));
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith(
        'alice',
        CONFIG,
        undefined,
        300,
      ),
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

  // 共通の focus 管理 (useModalFocus) へ寄せる前の挙動を固定する (D11): 初期 focus は安全側の
  // キャンセル・Tab / Shift+Tab は 2 ボタンの間を回る・閉じたら押した「削除」へ戻る。
  it('確認モーダルの focus: 初期はキャンセル・Tab は 2 ボタンを循環・閉じたら「削除」へ戻る', async () => {
    h.isSignedIn = true;
    stubMine([{ handle: 'alice', config: CONFIG }]);
    renderPanel(CONFIG);
    const releaseButton = await screen.findByRole('button', { name: '削除' });
    releaseButton.focus();
    fireEvent.click(releaseButton);
    const dialog = screen.getByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'キャンセル' });
    const confirm = within(dialog).getByRole('button', { name: '解放する' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '削除' })).toHaveFocus();
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

it.each([[false, false], [false, true], [true, false], [true, true]])('prevalidates every publish method: arc=%s tip=%s', async (arc, tip) => {
  h.isSignedIn = true;
  const envModule = await import('@/lib/env');
  const enabledSpy = vi.spyOn(envModule, 'isArcTipEnabled').mockReturnValue(arc && tip);
  const config: HandleTipConfig = { ...CONFIG, methods: [{ token: 'usdc', chain: 'base', crossChain: true }, { token: 'usdc', chain: 'arc', crossChain: false }] };
  const onPublished = vi.fn();
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === 'POST' ? { ok: true, status: 'created', updatedAt: 500 } : String(url) === '/api/handle' ? { ok: true, handles: [], max: 3 } : { ok: true, available: true },
  ), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  renderPanel(config, { onPublished });
  fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'bob' } });
  fireEvent.click(screen.getByRole('button', { name: '公開する' }));
  if (arc && tip) {
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post![1]!.body as string).config.methods).toEqual(config.methods);
  } else {
    await screen.findByText(/無効または未対応の受取方法/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(onPublished).not.toHaveBeenCalled();
  }
  enabledSpy.mockRestore();
});

it('blocks a disabled published Arc record even after unrelated edits', async () => {
  h.isSignedIn = true;
  stubMine([{ handle: 'alice', config: CONFIG, updatedAt: 10 }]);
  renderPanel(CONFIG, { editingHandle: 'alice', expectedUpdatedAt: 10, publishBlockedReason: 'Arc disabled: cannot republish', isDirty: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('Arc disabled: cannot republish');
  expect(await screen.findByRole('button', { name: '公開を更新' })).toBeDisabled();
});
