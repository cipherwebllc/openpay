// StorefrontPublishPanel を実描画で検証: SIWE 状態 / 所有 handle 取得 / 公開 POST の body /
// 固定URL 表示 / 公開済み表示 / メニュー未充足の無効化。env/useSiweSession/useOrigin/fetch をモック。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import type { StorefrontParts } from '@/lib/mobileOrder';
import type { Address } from 'viem';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const h = vi.hoisted(() => ({ isSignedIn: true, enableShopsApi: false }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return true;
      },
      get enableShopsApi() {
        return h.enableShopsApi;
      },
    },
  };
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
const STORE_WITH_TIME: StorefrontParts = {
  ...STORE,
  openFrom: '09:30',
  lastOrder: '21:30',
  minLeadMinutes: 20,
};
const CFG = { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }] };

function renderPanel(
  props: Partial<{
    storefront: StorefrontParts | null;
    receiver: Address | null;
    onGetHandle: () => void;
    onLoadStorefront: (parts: StorefrontParts, receiver: string) => void;
  }> = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <StorefrontPublishPanel
        storefront={props.storefront === undefined ? STORE : props.storefront}
        receiver={props.receiver ?? null}
        onGetHandle={props.onGetHandle}
        onLoadStorefront={props.onLoadStorefront}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.isSignedIn = true;
  h.enableShopsApi = false;
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

  it('handle を公開 → 時間系を含む POST 生バイトを送り固定URLを表示', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : { ok: true, status: 200, json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE_WITH_TIME });
    const btn = await screen.findByRole('button', { name: 'この @handle に公開' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    // POST body: handle + 既存 config 再送 + storefront。
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeTruthy();
    const rawBody = (post![1] as RequestInit).body as string;
    expect(rawBody).toBe(
      `{"handle":"shop","config":{"to":"${ADDR}","methods":[{"token":"jpyc","chain":"polygon"}]},"storefront":{"chain":"polygon","mode":"storefront","feePayer":"merchant","menu":[{"id":"a","name":"ブレンド","price":"500"}],"openFrom":"09:30","lastOrder":"21:30","minLeadMinutes":20},"expectedUpdatedAt":100}`,
    );
    const body = JSON.parse(rawBody);
    expect(body.handle).toBe('shop');
    expect(body.config).toEqual(CFG);
    expect(body.storefront).toEqual(STORE_WITH_TIME);
    expect(body.expectedUpdatedAt).toBe(100);
    // 固定店舗 URL。
    expect(screen.getByText('https://open-pay.jp/@shop')).toBeInTheDocument();
  });

  it('時間系未設定の店は従来の POST 生バイトから不変', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : { ok: true, status: 200, json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE });
    fireEvent.click(await screen.findByRole('button', { name: 'この @handle に公開' }));
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());

    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect((post![1] as RequestInit).body).toBe(
      `{"handle":"shop","config":{"to":"${ADDR}","methods":[{"token":"jpyc","chain":"polygon"}]},"storefront":{"chain":"polygon","mode":"storefront","feePayer":"merchant","menu":[{"id":"a","name":"ブレンド","price":"500"}]},"expectedUpdatedAt":100}`,
    );
  });

  it('Shops API flag OFF は checkbox 非表示で従来 POST バイトを維持', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : { ok: true, status: 200, json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE });
    const publishButton = await screen.findByRole('button', { name: 'この @handle に公開' });
    expect(
      screen.queryByRole('checkbox', {
        name: 'AI エージェント検索に掲載する（Shops API）',
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(publishButton);
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect((post![1] as RequestInit).body).toBe(
      `{"handle":"shop","config":{"to":"${ADDR}","methods":[{"token":"jpyc","chain":"polygon"}]},"storefront":{"chain":"polygon","mode":"storefront","feePayer":"merchant","menu":[{"id":"a","name":"ブレンド","price":"500"}]},"expectedUpdatedAt":100}`,
    );
  });

  it('Shops API flag ON でも checkbox 既定 OFF は従来 POST バイト不変', async () => {
    h.enableShopsApi = true;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : { ok: true, status: 200, json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE });
    const checkbox = await screen.findByRole('checkbox', {
      name: 'AI エージェント検索に掲載する（Shops API）',
    });
    expect(checkbox).not.toBeChecked();
    expect(
      screen.getByText(
        '掲載すると、店名・紹介文・住所・営業時間・メニュー概要・受付状況が、OpenPay の有料 API を通じて第三者の AI エージェントやアプリに提供されます。電話番号は提供されません。解除はこのチェックを外して公開を更新（反映まで最大 60 秒）。住所が自宅を兼ねる場合は掲載前にご確認ください。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'この @handle に公開' }));
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect((post![1] as RequestInit).body).toBe(
      `{"handle":"shop","config":{"to":"${ADDR}","methods":[{"token":"jpyc","chain":"polygon"}]},"storefront":{"chain":"polygon","mode":"storefront","feePayer":"merchant","menu":[{"id":"a","name":"ブレンド","price":"500"}]},"expectedUpdatedAt":100}`,
    );
  });

  it('Shops API checkbox を明示 ON にしたときだけ agentListing:true を POST 生バイトへ追加', async () => {
    h.enableShopsApi = true;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : { ok: true, status: 200, json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE });
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'AI エージェント検索に掲載する（Shops API）',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'この @handle に公開' }));
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect((post![1] as RequestInit).body).toBe(
      `{"handle":"shop","config":{"to":"${ADDR}","methods":[{"token":"jpyc","chain":"polygon"}]},"storefront":{"chain":"polygon","mode":"storefront","feePayer":"merchant","menu":[{"id":"a","name":"ブレンド","price":"500"}],"agentListing":true},"expectedUpdatedAt":100}`,
    );
  });

  it('ビルダーの受取先が現 config.to と異なる → config.to を新受取先に更新して POST (他 config は保持) + 差分注記', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }),
          },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE, receiver: ADDR2 });
    const btn = await screen.findByRole('button', { name: 'この @handle に公開' });
    // 現 config.to (ADDR) と異なるので「X→Y に更新」注記が出る。
    expect(screen.getByText(/更新して公開します/)).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body.config.to).toBe(ADDR2); // 受取先が更新される
    expect(body.config.methods).toEqual(CFG.methods); // 他フィールドは保持
    expect(body.storefront).toEqual(STORE);
  });

  it('ビルダーの受取先が現 config.to と同一 → config を変更せず維持 (config.to 温存)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: true, status: 200, json: async () => ({ ok: true, status: 'updated' }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: 100 }] }),
          },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE, receiver: ADDR }); // = 現 config.to と同一
    const btn = await screen.findByRole('button', { name: 'この @handle に公開' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('公開しました 🎉')).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body.config).toEqual(CFG);
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

  it('公開済み + 下書き同値 → 公開中チップのみ (正規化後の偽差分なし)', async () => {
    const updatedAt = Date.now() - 2 * 60 * 60 * 1_000;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          handles: [{ handle: 'shop', config: CFG, storefront: STORE, updatedAt }],
        }),
      }),
    );
    renderPanel({ storefront: { ...STORE, tagline: undefined } });
    const status = await screen.findByTestId('storefront-publish-status');
    expect(within(status).getByText('公開中')).toBeInTheDocument();
    expect(within(status).getByText('2 時間前')).toBeInTheDocument();
    expect(within(status).queryByText('未公開の変更があります')).not.toBeInTheDocument();
  });

  it('公開済み + storefront 下書き変更 → 未公開の変更があります', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          handles: [{ handle: 'shop', config: CFG, storefront: STORE, updatedAt: Date.now() }],
        }),
      }),
    );
    renderPanel({
      storefront: { ...STORE, menu: [{ ...STORE.menu[0], price: '550' }] },
    });
    const status = await screen.findByTestId('storefront-publish-status');
    expect(within(status).getByText('公開中')).toBeInTheDocument();
    expect(within(status).getByText('未公開の変更があります')).toBeInTheDocument();
  });

  it('公開済み agentListing の JSON round-trip を復元し、checkbox 差分を未公開変更にする', async () => {
    h.enableShopsApi = true;
    const published = JSON.parse(
      JSON.stringify({ ...STORE, agentListing: true }),
    ) as StorefrontParts;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          handles: [{ handle: 'shop', config: CFG, storefront: published, updatedAt: Date.now() }],
        }),
      }),
    );
    renderPanel({ storefront: STORE });
    const checkbox = await screen.findByRole('checkbox', {
      name: 'AI エージェント検索に掲載する（Shops API）',
    });
    expect(checkbox).toBeChecked();
    const status = screen.getByTestId('storefront-publish-status');
    expect(within(status).queryByText('未公開の変更があります')).not.toBeInTheDocument();
    fireEvent.click(checkbox);
    expect(within(status).getByText('未公開の変更があります')).toBeInTheDocument();
  });

  it('公開済み JSON round-trip から時間系だけ変わると未公開の変更として表示する', async () => {
    const published = JSON.parse(JSON.stringify(STORE_WITH_TIME)) as StorefrontParts;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          handles: [{ handle: 'shop', config: CFG, storefront: published, updatedAt: Date.now() }],
        }),
      }),
    );
    renderPanel({ storefront: { ...STORE_WITH_TIME, minLeadMinutes: 30 } });
    const status = await screen.findByTestId('storefront-publish-status');
    expect(within(status).getByText('公開中')).toBeInTheDocument();
    expect(within(status).getByText('未公開の変更があります')).toBeInTheDocument();
  });

  it('公開済み + 受取先変更 → 既存警告とステータスの両方に未公開差分を出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          handles: [{ handle: 'shop', config: CFG, storefront: STORE, updatedAt: Date.now() }],
        }),
      }),
    );
    renderPanel({ storefront: STORE, receiver: ADDR2 });
    const status = await screen.findByTestId('storefront-publish-status');
    expect(within(status).getByText('未公開の変更があります')).toBeInTheDocument();
    expect(screen.getByText(/更新して公開します/)).toBeInTheDocument();
  });

  it('storefront 無し → 未公開チップ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG, updatedAt: Date.now() }] }),
      }),
    );
    renderPanel({ storefront: STORE });
    const status = await screen.findByTestId('storefront-publish-status');
    expect(within(status).getByText('未公開')).toBeInTheDocument();
    expect(within(status).queryByText('未公開の変更があります')).not.toBeInTheDocument();
  });

  it('currentParts=null は受取先が異なっても差分判定せず、公開中チップのみ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          handles: [{ handle: 'shop', config: CFG, storefront: STORE, updatedAt: Date.now() }],
        }),
      }),
    );
    renderPanel({ storefront: null, receiver: ADDR2 });
    const status = await screen.findByTestId('storefront-publish-status');
    expect(within(status).getByText('公開中')).toBeInTheDocument();
    expect(within(status).queryByText('未公開の変更があります')).not.toBeInTheDocument();
  });

  it('公開成功後 → 公開中 · たった今 + 変更なしへ遷移', async () => {
    let published = false;
    const updatedAt = Date.now();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        published = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: 'updated', updatedAt }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          handles: [
            {
              handle: 'shop',
              config: CFG,
              storefront: published ? STORE : undefined,
              updatedAt: published ? updatedAt : 100,
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel({ storefront: STORE });
    fireEvent.click(await screen.findByRole('button', { name: 'この @handle に公開' }));
    const status = await screen.findByTestId('storefront-publish-status');
    await waitFor(() => expect(within(status).getByText('公開中')).toBeInTheDocument());
    expect(within(status).getByText('たった今')).toBeInTheDocument();
    expect(within(status).queryByText('未公開の変更があります')).not.toBeInTheDocument();
  });

  it('公開済み handle は固定 URL + コピー/開く/QR を再公開せずに提示 (@handle が唯一の共有導線)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG, storefront: STORE }] }),
      }),
    );
    renderPanel({ storefront: STORE });
    expect(await screen.findByText('公開中の店舗 URL')).toBeInTheDocument();
    expect(screen.getByText('https://open-pay.jp/@shop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QR を表示' })).toBeInTheDocument();
  });

  it('QR を表示 → プラカードを開き 店名 (config.name fallback) と受取チェーンを描画', async () => {
    // STORE は shopName 未設定 → placard は config.name へ fallback。chain='polygon' → 'Polygon'。
    const cfgNamed = { ...CFG, name: 'ヤマダ珈琲' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: cfgNamed, storefront: STORE }] }),
      }),
    );
    renderPanel({ storefront: STORE });
    fireEvent.click(await screen.findByRole('button', { name: 'QR を表示' }));
    // プラカード (dialog) が開く。
    const dialog = await screen.findByRole('dialog', { name: '卓上プラカード (印刷用)' });
    expect(dialog).toBeInTheDocument();
    // 店名は storefront.shopName 無 → config.name にフォールバック。
    expect(screen.getByRole('heading', { name: 'ヤマダ珈琲' })).toBeInTheDocument();
    // 対応ネットワークは単一 chain='polygon' → ラベル 'Polygon'。お支払いは JPYC のみを明示。
    expect(screen.getByText('お支払いは JPYC のみ')).toBeInTheDocument();
    expect(screen.getByText('対応ネットワーク：Polygon')).toBeInTheDocument();
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
        <StorefrontPublishPanel storefront={STORE} receiver={null} />
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

  it('公開済み handle は「編集（読み込む）」→確認→onLoadStorefront(parts, receiver) を呼ぶ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG, storefront: STORE }] }),
      }),
    );
    const onLoadStorefront = vi.fn();
    renderPanel({ storefront: STORE, onLoadStorefront });
    fireEvent.click(await screen.findByRole('button', { name: '編集（公開中の内容を読み込む）' }));
    // 確認 → 読み込む。
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));
    expect(onLoadStorefront).toHaveBeenCalledWith(STORE, CFG.to);
  });

  it('未公開 handle は編集（読み込む）ボタンを出さない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ handles: [{ handle: 'shop', config: CFG }] }),
      }),
    );
    renderPanel({ storefront: STORE, onLoadStorefront: vi.fn() });
    await screen.findByRole('button', { name: 'この @handle に公開' });
    expect(
      screen.queryByRole('button', { name: '編集（公開中の内容を読み込む）' }),
    ).not.toBeInTheDocument();
  });
});
