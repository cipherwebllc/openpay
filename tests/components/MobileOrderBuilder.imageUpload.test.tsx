// モバイル注文の店のアイコン・カバー (画像のアップロード PR 3B)。/api/auth/siwe/me の imageUpload が true のときだけ、URL の欄を
// 画像の欄 (components/ImageField・用途 storefront・前処理の長辺はアイコン 512・カバー 1280) にする。保存の形は今と同じ
// (下書きの https URL の文字列)・公開は今と同じ POST /api/handle。本物の MobileOrderBuilder・StorefrontPublishPanel・
// useMobileOrderDraft を通し、画像の下ごしらえ (canvas) は差し替え、POST /api/images/upload は fetch の mock で受ける。
// 1 欄でも送っている間は、公開のボタン (帯の 2 つ)・公開中の店の自動 / 手動の読み込みを止め、別のタブの下書きを取り込まない。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLayoutEffect, useState, type ReactElement } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import { useMobileOrderDraft } from '@/hooks/useMobileOrderDraft';
import { IMAGE_MAX_EDGE, STOREFRONT_COVER_MAX_EDGE } from '@/lib/images/purpose';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0x000000000000000000000000000000000000dEaD';
const DRAFT_KEY = 'openpay:mobile-order-draft:v1';
const PRESETS_KEY = 'openpay:product-presets:v1';
const BLOB = 'https://teststore.public.blob.vercel-storage.com/v1/k/storefront';
const OLD_AVATAR = 'https://images.example/avatar.png';

const h = vi.hoisted(() => ({
  signedIn: true,
  sessionAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as string,
  imageUpload: true as boolean | undefined,
  imageUploadSignIn: true as boolean | undefined,
  /** GET /api/handle の応答を保留する (届く順を決める)。 */
  holdMine: false,
}));
const prepare = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock('@/lib/images/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/images/prepare')>()),
  prepareUploadImage: prepare.upload,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableMobileOrder: true, enableHandles: true, enableShopsApi: false } };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: ADDR, isConnected: true }) }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.signedIn,
    sessionAddress: h.signedIn ? h.sessionAddress : null,
    imageUpload: h.imageUpload,
    imageUploadSignIn: h.imageUploadSignIn,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    refreshSession: vi.fn(),
  }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useResolveAddress', () => ({ useResolveAddress: () => ({ data: null }) }));
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="addr" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { MobileOrderBuilder } from '@/components/MobileOrderBuilder';

const MO = ja.MobileOrder;
const I = ja.ImageField;

/** 公開中の店 (読み込むと下書きがこの内容に入れ替わる)。 */
const LIVE_STOREFRONT = {
  chain: 'polygon',
  mode: 'storefront',
  feePayer: 'merchant',
  shopName: '公開中の店',
  avatar: 'https://images.example/live-avatar.png',
  menu: [{ id: 'live1', name: '公開中のメニュー', price: '700' }],
};

type Pending = { purpose: string; resolve: (response: Response) => void };
let uploads: Pending[];
let posts: Array<Record<string, unknown>>;
let releaseMine: (() => void) | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubApi() {
  uploads = [];
  posts = [];
  releaseMine = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/images/upload')) {
        const purpose = new URL(url, 'https://test.local').searchParams.get('purpose') ?? '';
        return new Promise<Response>((resolve) => uploads.push({ purpose, resolve }));
      }
      if (url === '/api/handle' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ ok: true, handle: 'cafe', status: 'updated', updatedAt: 2000 });
      }
      if (url === '/api/handle') {
        const body = json({
          ok: true,
          max: 3,
          handles: [{ handle: 'cafe', config: { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }] }, storefront: LIVE_STOREFRONT, updatedAt: 1000 }],
        });
        if (!h.holdMine) return body;
        return new Promise<Response>((resolve) => {
          releaseMine = () => resolve(body);
        });
      }
      return json({ ok: false, error: 'unexpected' }, 404);
    }),
  );
}

function tree(): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MobileOrderBuilder />
    </QueryClientProvider>
  );
}

const storedDraft = () => JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Record<string, unknown>;
const avatarGroup = () => screen.getByRole('group', { name: MO.avatarLabel });
const coverGroup = () => screen.getByRole('group', { name: MO.coverLabel });
const fileInputIn = (element: HTMLElement) => element.querySelector('input[type="file"]') as HTMLInputElement;
const previewSrc = (element: HTMLElement) => element.querySelector('img')?.getAttribute('src') ?? null;
const publishButtons = () => screen.getAllByRole('button', { name: new RegExp(`^(${MO.publishUpdateButton}|${MO.publishButton})$`) });

async function pick(group: HTMLElement, count: number) {
  fireEvent.change(fileInputIn(group), { target: { files: [new File(['raw'], 'photo.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(uploads).toHaveLength(count));
}

async function answer(index: number, url: string) {
  await act(async () => uploads[index].resolve(json({ ok: true, url })));
}

/** 書きかけの下書き (店名・アイコン・カバー・メニュー 1 つ)。手付かずではないので、公開中の店を自動では読み込まない。 */
function seedDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ shopName: 'Cafe', avatar: OLD_AVATAR, cover: '' }));
  localStorage.setItem(
    PRESETS_KEY,
    JSON.stringify({
      presets: [{ id: 'm1', name: 'ブレンド', unitPrice: '500', token: 'jpyc', taxRate: 8, taxCategory: 'taxable_8', memo: null, sortOrder: 0, enabled: true }],
      receipt: { day: '', n: 0 },
    }),
  );
}

async function renderWithImageFields() {
  const view = renderWithIntl(tree());
  await screen.findByRole('group', { name: MO.avatarLabel });
  await waitFor(() => expect(publishButtons()).toHaveLength(2));
  await waitFor(() => publishButtons().forEach((button) => expect(button).toBeEnabled()));
  return view;
}

beforeEach(() => {
  h.signedIn = true;
  h.sessionAddress = ADDR;
  h.imageUpload = true;
  h.imageUploadSignIn = true;
  h.holdMine = false;
  localStorage.clear();
  seedDraft();
  stubApi();
  prepare.upload.mockReset();
  prepare.upload.mockImplementation(async () => ({
    ok: true,
    image: { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), type: 'image/jpeg', width: 10, height: 10 },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('画像の欄を出すか (/api/auth/siwe/me)', () => {
  it.each([
    ['段階 off (imageUpload も imageUploadSignIn も無い)', () => { h.imageUpload = undefined; h.imageUploadSignIn = undefined; }],
    ['サインイン済みでも imageUpload が false', () => { h.imageUpload = false; }],
  ])('%s なら今の URL の欄のまま', async (_label, setup) => {
    setup();
    const { container } = renderWithIntl(tree());
    await waitFor(() => expect(publishButtons()).toHaveLength(2));
    expect(screen.queryByRole('group', { name: MO.avatarLabel })).not.toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('https://')).toHaveLength(2);
    expect(screen.queryByText(I.signInToUpload)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('サインインしていなくて imageUploadSignIn なら 1 行の案内と今の URL の欄', async () => {
    h.signedIn = false;
    h.imageUpload = false;
    renderWithIntl(tree());
    expect(await screen.findByText(I.signInToUpload)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: MO.avatarLabel })).not.toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('https://')).toHaveLength(2);
  });

  it('サインイン済みで imageUpload: アイコン (長辺 512) とカバー (長辺 1280) の画像の欄・用途はどちらも storefront・今の URL はプレビューに残る', async () => {
    await renderWithImageFields();
    expect(previewSrc(avatarGroup())).toBe(OLD_AVATAR);
    expect(within(coverGroup()).getByText(I.empty)).toBeInTheDocument();
    expect(within(avatarGroup()).getByText(`${MO.avatarImageHint} ${I.hint.replace('{max}', '512')}`)).toBeInTheDocument();
    expect(within(coverGroup()).getByText(`${MO.coverImageHint} ${I.hint.replace('{max}', '1280')}`)).toBeInTheDocument();
    fireEvent.click(within(avatarGroup()).getByRole('button', { name: I.useUrl }));
    expect(within(avatarGroup()).getByRole('textbox', { name: MO.avatarUrlLabel })).toHaveAttribute('maxlength', '512');
    expect(within(avatarGroup()).getByText(MO.avatarHint)).toBeInTheDocument();

    await pick(avatarGroup(), 1);
    await pick(coverGroup(), 2);
    expect(uploads.map((upload) => upload.purpose)).toEqual(['storefront', 'storefront']);
    expect(prepare.upload.mock.calls.map(([, purpose, maxEdge]) => [purpose, maxEdge])).toEqual([
      ['storefront', 512],
      ['storefront', 1280],
    ]);
    expect(IMAGE_MAX_EDGE.storefront).toBe(512);
    expect(STOREFRONT_COVER_MAX_EDGE).toBe(1280);
  });
});

describe('公開とアップロード', () => {
  it('2 欄の完了の順を逆にしても両方入り、残り 1 件の間は両方の公開のボタンが止まる・公開の本文は手入力と同じ形', async () => {
    await renderWithImageFields();
    await pick(avatarGroup(), 1);
    await pick(coverGroup(), 2);
    publishButtons().forEach((button) => expect(button).toBeDisabled());
    expect(screen.getAllByText(MO.barReasonImageBusy)).toHaveLength(2);
    await answer(1, `${BLOB}/cover.jpg`);
    // 残り 1 件 (アイコン) の間は、どちらの帯のボタンも止まったまま (押しても送らない)。
    publishButtons().forEach((button) => expect(button).toBeDisabled());
    fireEvent.click(publishButtons()[0]);
    expect(posts).toHaveLength(0);
    await answer(0, `${BLOB}/avatar.jpg`);
    await waitFor(() => publishButtons().forEach((button) => expect(button).toBeEnabled()));
    expect(screen.queryByText(MO.barReasonImageBusy)).not.toBeInTheDocument();
    expect(storedDraft()).toMatchObject({ avatar: `${BLOB}/avatar.jpg`, cover: `${BLOB}/cover.jpg` });
    fireEvent.click(publishButtons()[1]);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].storefront).toMatchObject({ shopName: 'Cafe', avatar: `${BLOB}/avatar.jpg`, cover: `${BLOB}/cover.jpg` });
    // 卓上の QR は /@handle (画像の数や URL の長さに関わらない)。
    fireEvent.click(screen.getByRole('button', { name: MO.showQr }));
    const placard = await screen.findByRole('dialog', { name: MO.placardTitle });
    expect(within(placard).getByText('https://test.local/@cafe')).toBeInTheDocument();
  });

  it('送っている間に URL を書き換えて元の URL に戻すと、後から届いた画像は入らない', async () => {
    await renderWithImageFields();
    await pick(avatarGroup(), 1);
    fireEvent.click(within(avatarGroup()).getByRole('button', { name: I.useUrl }));
    const url = within(avatarGroup()).getByRole('textbox', { name: MO.avatarUrlLabel });
    fireEvent.change(url, { target: { value: 'https://images.example/typed.png' } });
    fireEvent.change(url, { target: { value: OLD_AVATAR } });
    await answer(0, `${BLOB}/late.jpg`);
    await waitFor(() => expect(storedDraft().avatar).toBe(OLD_AVATAR));
    expect(previewSrc(avatarGroup())).toBe(OLD_AVATAR);
  });

  it('送っている間は手動の「読み込む」を押せず、終わると押せる (読み込んだ後に届いた結果は入らない)', async () => {
    await renderWithImageFields();
    // 下書きが公開中と違うので「編集（公開中の内容を読み込む）」が出ている。
    const load = screen.getByRole('button', { name: MO.editLoadButton });
    fireEvent.click(load);
    const yes = screen.getByRole('button', { name: MO.editLoadConfirmYes });
    await pick(coverGroup(), 1);
    expect(yes).toBeDisabled();
    fireEvent.click(yes);
    expect(storedDraft().shopName).toBe('Cafe');
    await answer(0, `${BLOB}/cover.jpg`);
    await waitFor(() => expect(yes).toBeEnabled());
    fireEvent.click(yes);
    await waitFor(() => expect(storedDraft()).toMatchObject({ shopName: '公開中の店', avatar: LIVE_STOREFRONT.avatar, cover: '' }));
  });

  it('送っている間は公開中の店を自動で読み込まず、届いた画像を残す', async () => {
    // 手付かずの端末 (下書きも商品も既定のまま) で、公開中の店の GET が届く前にアイコンを選ぶ。
    localStorage.clear();
    h.holdMine = true;
    renderWithIntl(tree());
    await screen.findByRole('group', { name: MO.avatarLabel });
    await pick(avatarGroup(), 1);
    await waitFor(() => expect(releaseMine).not.toBeNull());
    await act(async () => releaseMine?.());
    await screen.findAllByText('@cafe');
    expect(storedDraft().shopName ?? '').toBe('');
    await answer(0, `${BLOB}/avatar.jpg`);
    await waitFor(() => expect(storedDraft().avatar).toBe(`${BLOB}/avatar.jpg`));
    // 届いた画像で手付かずではなくなったので、読み込まない (公開中の店の名前・アイコンで上書きしない)。
    expect(storedDraft().shopName ?? '').toBe('');
    expect(screen.queryByText(MO.autoLoaded)).not.toBeInTheDocument();
  });

  it.each([
    ['imageUpload が false になった (URL の欄に戻る)', () => { h.imageUpload = false; }],
    ['セッションの本人が替わった', () => { h.sessionAddress = ADDR2; }],
  ])('%s 後に届いた、前に始まった結果は入らない', async (_label, change) => {
    const view = await renderWithImageFields();
    await pick(coverGroup(), 1);
    change();
    view.rerender(tree());
    await answer(0, `${BLOB}/cover.jpg`);
    expect(storedDraft().cover).toBe('');
  });

  it('送っている間は別のタブの下書きを取り込まず、終わったら取り込む (ほかの欄)', async () => {
    await renderWithImageFields();
    await pick(coverGroup(), 1);
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...storedDraft(), tagline: '別のタブのひとこと' }));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByLabelText(MO.taglineLabel)).toHaveValue('');
    await answer(0, `${BLOB}/cover.jpg`);
    await waitFor(() => expect(screen.getByLabelText(MO.taglineLabel)).toHaveValue('別のタブのひとこと'));
    expect(storedDraft()).toMatchObject({ cover: `${BLOB}/cover.jpg`, tagline: '別のタブのひとこと' });
  });
});

describe('プレビュー (お店のページ) の画像が読めない (404) とき', () => {
  it('アイコンは店名の頭文字に戻り、カバーは隠れ、メニューの名前と価格は残る', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ shopName: 'Cafe', avatar: `${BLOB}/gone-avatar.jpg`, cover: `${BLOB}/gone-cover.jpg` }));
    localStorage.setItem(
      PRESETS_KEY,
      JSON.stringify({
        presets: [{ id: 'm1', name: 'ブレンド', unitPrice: '500', token: 'jpyc', taxRate: 8, taxCategory: 'taxable_8', memo: null, image: `${BLOB}/gone-menu.jpg`, sortOrder: 0, enabled: true }],
        receipt: { day: '', n: 0 },
      }),
    );
    renderWithIntl(tree());
    const preview = (await screen.findByRole('heading', { name: MO.stepPreviewTitle })).closest('section') as HTMLElement;
    await waitFor(() => expect(preview.querySelectorAll('img').length).toBeGreaterThanOrEqual(3));
    for (const img of Array.from(preview.querySelectorAll('img'))) fireEvent.error(img);
    expect(preview.querySelector(`img[src="${BLOB}/gone-cover.jpg"]`)).toBeNull();
    expect(preview.querySelector(`img[src="${BLOB}/gone-avatar.jpg"]`)).toBeNull();
    expect(within(preview).getAllByText('C').length).toBeGreaterThan(0);
    expect(within(preview).getByText('ブレンド')).toBeInTheDocument();
    expect(within(preview).getAllByText(/500/).length).toBeGreaterThan(0);
  });
});

describe('別のタブの取り込みの保留 (holdImport) は描画の確定で効く', () => {
  function HoldHarness() {
    const [busy, setBusy] = useState(false);
    const { settings } = useMobileOrderDraft(busy);
    useLayoutEffect(() => {
      if (busy) window.dispatchEvent(new Event('focus'));
    }, [busy]);
    return (
      <>
        <button type="button" onClick={() => setBusy((current) => !current)}>
          toggle
        </button>
        <output data-testid="avatar">{settings.avatar}</output>
      </>
    );
  }

  it('保留中は前の値のまま、保留が終わったら別のタブの値を取り込む', async () => {
    renderWithIntl(<HoldHarness />);
    await waitFor(() => expect(screen.getByTestId('avatar')).toHaveTextContent(OLD_AVATAR));
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...storedDraft(), avatar: 'https://images.example/other-tab.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('avatar')).toHaveTextContent(OLD_AVATAR);
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(screen.getByTestId('avatar')).toHaveTextContent('https://images.example/other-tab.png'));
  });
});
