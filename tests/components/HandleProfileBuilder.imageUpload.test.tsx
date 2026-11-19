// プロフの画像の欄 (アバター・カバー・リンクの各行の小さな画像)。持ち主の GET /api/handle の imageUpload が true のときだけ
// 画像の欄 (components/ImageField) にし、false / 無い / サインインしていないときは今の URL の欄のまま (DOM の pin は
// HandleProfileBuilder-pinning.test.tsx が見る)。保存の形 (avatar・cover・links[].imageUrl の https URL の文字列) と
// 保存の API (POST /api/handle) は変えない。claim panel は mock しない (本物の HandleClaimPanel が GET を読み、imageUpload を
// 知らせ、アップロード中は公開のボタンを止める)。画像の下ごしらえ (canvas) は差し替え、POST /api/images/upload は fetch の
// mock で受ける (応答を保留して、届く順を決める)。
// 遅れて届いた結果を捨てる: URL の手入力・やめる→外す・リンクの行の削除と並べ替え・imageUpload の切り替え・下書きの入れ替え
// (編集に入る・やめる) の後に届いたアップロードの結果は入れない。リンクの行は id で結ぶ (並べ替えても送り始めた行に入る)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import { DEFAULT_PROFILE_DRAFT } from '@/hooks/useHandleProfileDraft';
import { myHandlesQueryKey, type MineResponse, type OwnedHandle } from '@/lib/handleMine';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const STORAGE_KEY = 'openpay:handle-profile-draft:v1';
const BLOB = 'https://teststore.public.blob.vercel-storage.com/v1/k';

const h = vi.hoisted(() => ({
  signedIn: true,
  imageUpload: true as boolean | undefined,
  handles: [] as unknown[],
}));
const prepare = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock('@/lib/images/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/images/prepare')>()),
  prepareUploadImage: prepare.upload,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableHandles: true } };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: ADDR, isConnected: true }) }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.signedIn,
    sessionAddress: h.signedIn ? ADDR : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useResolveAddress', () => ({ useResolveAddress: () => ({ data: null }) }));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="addr" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';

const HP = ja.HandleProfile;
const HB = ja.HandleProfileBuilder;
const HC = ja.HandleClaim;
const I = ja.ImageField;

/** 書きかけの下書き (受取先・名前・リンク 2 本)。手付かずではないので、持っている @handle の編集に自動では入らない。 */
const DRAFT = {
  to: ADDR,
  name: 'Alice',
  links: [
    { label: 'Blog', url: 'https://blog.example' },
    { label: 'Shop', url: 'https://shop.example' },
  ],
};

/** 公開中の @handle (編集に入ると下書きがこの内容に入れ替わる)。 */
const BOB: OwnedHandle = {
  handle: 'bob',
  config: { to: ADDR, name: 'Bob', methods: [{ token: 'jpyc', chain: 'polygon' }] },
  profile: { avatar: 'https://images.example/bob.png', links: [{ label: 'Bob site', url: 'https://bob.example' }] },
  updatedAt: 1000,
};

type Pending = { purpose: string; resolve: (response: Response) => void };
let uploads: Pending[];
let posts: Array<Record<string, unknown>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubApi() {
  uploads = [];
  posts = [];
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
        return json({ ok: true, handle: 'alice', status: 'created', updatedAt: 500 }, 201);
      }
      if (url === '/api/handle') {
        return json({
          ok: true,
          handles: h.handles,
          max: 3,
          ...(h.imageUpload === undefined ? {} : { imageUpload: h.imageUpload }),
        });
      }
      if (url.startsWith('/api/handle/')) return json({ ok: true, available: true });
      return json({ ok: false, error: 'unexpected' }, 500);
    }),
  );
}

function renderBuilder() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderWithIntl(
    <QueryClientProvider client={qc}>
      <HandleProfileBuilder />
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

/** GET /api/handle の取り直しで imageUpload が変わった (cache を書き換える = 本物の HandleClaimPanel が知らせる)。 */
async function setImageUpload(qc: QueryClient, imageUpload: boolean) {
  h.imageUpload = imageUpload;
  await act(async () => {
    qc.setQueryData<MineResponse>(myHandlesQueryKey(ADDR), (current) => ({
      handles: current?.handles ?? [],
      max: current?.max,
      imageUpload,
    }));
  });
}

const avatarGroup = () => screen.getByRole('group', { name: HP.avatarImageLabel });
const coverGroup = () => screen.getByRole('group', { name: HP.coverImageLabel });
const linkGroups = () => screen.getAllByRole('group', { name: HB.linkImageLabel });
const fileInputIn = (element: HTMLElement) => element.querySelector('input[type="file"]') as HTMLInputElement;
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
const storedLinks = () => stored().links as Array<Record<string, unknown>>;
// 公開のボタン (新しい @handle は「公開する」・持っている @handle の編集中は「公開を更新」)。
const publishButtons = () => screen.getAllByRole('button', { name: new RegExp(`^(${HC.barPublish}|${HC.barUpdate})$`) });

function openGroup(title: string) {
  const summary = screen.getByText(title).closest('summary') as HTMLElement;
  if (!(summary.parentElement as HTMLDetailsElement).open) fireEvent.click(summary);
}

/** 画像を選ぶ (file の欄の change)。送信は下ごしらえの後なので、届くまで待つ。送っている間は公開を止めている。 */
async function pick(group: HTMLElement, count: number) {
  fireEvent.change(fileInputIn(group), { target: { files: [new File(['raw'], 'photo.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(uploads).toHaveLength(count));
  // 公開のボタンの帯 (スマホの下部・PC のプレビューの下) の両方に理由を出す。
  await waitFor(() => expect(screen.getAllByText(HC.barReasonImageBusy)).toHaveLength(2));
}

/**
 * 公開を止めていない (アップロード中の理由が消え、ボタンが押せる)。欄が外れた後の「アップロード中ではない」は、外れた欄の後片づけ
 * (unmount の effect) の次の描画で反映されるので待つ。
 */
async function expectPublishNotHeld() {
  await waitFor(() => expect(screen.queryByText(HC.barReasonImageBusy)).not.toBeInTheDocument());
  expect(publishButtons()[0]).toBeEnabled();
}

async function answer(index: number, url: string) {
  await act(async () => uploads[index].resolve(json({ ok: true, url })));
}

async function answerError(index: number, status: number, error: string) {
  await act(async () => uploads[index].resolve(json({ ok: false, error }, status)));
}

/** @handle を入れて公開し、送った本文を返す。 */
async function publish(): Promise<Record<string, unknown>> {
  fireEvent.change(screen.getByPlaceholderText(HC.handlePlaceholder), { target: { value: 'alice' } });
  await waitFor(() => expect(publishButtons()[0]).toBeEnabled());
  fireEvent.click(publishButtons()[0]);
  await waitFor(() => expect(posts).toHaveLength(1));
  return posts[0];
}

/**
 * 画像の欄が出るまで待ち、見た目・リンクのまとまりを開く。@handle も入れておく (公開を止める理由は、ほかの理由
 * (サインイン・受取先・@handle) が無いときに出るので、アップロード中の理由が出るかを見られるように)。
 */
async function renderWithImageFields() {
  const view = renderBuilder();
  await screen.findByRole('group', { name: HP.avatarImageLabel });
  openGroup(HP.groupLook);
  openGroup(HP.groupLinks);
  fireEvent.change(screen.getByPlaceholderText(HC.handlePlaceholder), { target: { value: 'alice' } });
  await waitFor(() => expect(publishButtons()[0]).toBeEnabled());
  return view;
}

beforeEach(() => {
  h.signedIn = true;
  h.imageUpload = true;
  h.handles = [];
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DRAFT));
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

describe('imageUpload が false / 無い / サインインしていないとき', () => {
  it.each([
    ['GET の imageUpload が false', () => { h.imageUpload = false; }],
    ['GET に imageUpload が無い', () => { h.imageUpload = undefined; }],
    ['サインインしていない (GET を読まない)', () => { h.signedIn = false; }],
  ])('%s なら今の URL の欄のまま (画像の欄・file の欄を出さない)', async (_label, setup) => {
    setup();
    const { container } = renderBuilder();
    // GET (または サインインの案内) を待つ。
    if (h.signedIn) await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/handle'));
    await screen.findByRole('textbox', { name: /^アバター画像 URL/ });
    openGroup(HP.groupLook);
    openGroup(HP.groupLinks);
    expect(screen.getByRole('textbox', { name: /^アバター画像 URL/ })).toHaveAttribute('type', 'url');
    expect(screen.getByRole('textbox', { name: /^カバー画像 URL/ })).toHaveAttribute('type', 'url');
    expect(screen.getAllByRole('textbox', { name: HB.imageUrlLabel })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: I.choose })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: HP.avatarImageLabel })).not.toBeInTheDocument();
    expect(screen.queryByText(HB.linkImageHint.replace('{max}', '320'))).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('imageUpload が true のとき: 3 つの欄', () => {
  it('アバター・カバー・リンクの各行が画像の欄になり、用途ごとの長辺と今の案内を出す', async () => {
    await renderWithImageFields();
    expect(within(avatarGroup()).getByRole('button', { name: I.choose })).toBeInTheDocument();
    expect(within(avatarGroup()).getByText(`${HP.avatarImageHint} ${I.hint.replace('{max}', '512')}`)).toBeInTheDocument();
    expect(within(coverGroup()).getByText(`${HP.coverImageHint} ${I.hint.replace('{max}', '1280')}`)).toBeInTheDocument();
    expect(screen.getByText(HB.linkImageHint.replace('{max}', '320'))).toBeInTheDocument();
    expect(linkGroups()).toHaveLength(2);
    // 「URL で指定する ›」を開くと今の案内 (URL の貼り方・ガイドへの導線) を出す。
    fireEvent.click(within(avatarGroup()).getByRole('button', { name: I.useUrl }));
    expect(within(avatarGroup()).getByText(HP.avatarHint)).toBeInTheDocument();
    fireEvent.click(within(coverGroup()).getByRole('button', { name: I.useUrl }));
    expect(within(coverGroup()).getByRole('link', { name: HP.imageGuideLink })).toHaveAttribute('href', '/ja/guide/image-url');
    expect(within(coverGroup()).getByRole('textbox', { name: HP.coverLabel })).toHaveAttribute('maxlength', '512');
  });

  it('選んだ画像は用途ごとに送り、公開の本文は URL を手で入れたときと同じ形', async () => {
    // 今の画面 (URL の欄) で 3 つの URL を手で入れて公開した本文。
    h.imageUpload = false;
    const manual = renderBuilder();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/handle'));
    openGroup(HP.groupLook);
    openGroup(HP.groupLinks);
    fireEvent.change(screen.getByRole('textbox', { name: /^アバター画像 URL/ }), { target: { value: `${BLOB}/avatar/a.jpg` } });
    fireEvent.change(screen.getByRole('textbox', { name: /^カバー画像 URL/ }), { target: { value: `${BLOB}/cover/c.jpg` } });
    fireEvent.change(screen.getAllByRole('textbox', { name: HB.imageUrlLabel })[1], { target: { value: `${BLOB}/link/l.jpg` } });
    const typed = await publish();
    manual.unmount();

    // 画像の欄で選んで公開した本文。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DRAFT));
    h.imageUpload = true;
    stubApi();
    await renderWithImageFields();
    await pick(avatarGroup(), 1);
    await answer(0, `${BLOB}/avatar/a.jpg`);
    await pick(coverGroup(), 2);
    await answer(1, `${BLOB}/cover/c.jpg`);
    await pick(linkGroups()[1], 3);
    await answer(2, `${BLOB}/link/l.jpg`);
    expect(uploads.map((u) => u.purpose)).toEqual(['avatar', 'cover', 'link']);
    expect(prepare.upload.mock.calls.map(([, purpose]) => purpose)).toEqual(['avatar', 'cover', 'link']);
    const uploaded = await publish();

    expect(uploaded).toEqual(typed);
    expect(uploaded.profile).toMatchObject({
      avatar: `${BLOB}/avatar/a.jpg`,
      cover: `${BLOB}/cover/c.jpg`,
      links: [{ label: 'Blog', url: 'https://blog.example' }, { label: 'Shop', url: 'https://shop.example', imageUrl: `${BLOB}/link/l.jpg` }],
    });
    // 下書きに入る形も今と同じ (URL の文字列・下書きのキーは増えない)。
    expect(stored()).toMatchObject({ avatar: `${BLOB}/avatar/a.jpg`, cover: `${BLOB}/cover/c.jpg` });
    expect(storedLinks()[1]).toEqual({ label: 'Shop', url: 'https://shop.example', imageUrl: `${BLOB}/link/l.jpg` });
    expect(Object.keys(stored()).sort()).toEqual(Object.keys(DEFAULT_PROFILE_DRAFT).sort());
  });

  it('外す・URL で指定するで値を変えられる (保存の形は今と同じ)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DRAFT, avatar: 'https://images.example/old.png' }));
    await renderWithImageFields();
    fireEvent.click(within(avatarGroup()).getByRole('button', { name: I.remove }));
    await waitFor(() => expect(stored().avatar).toBe(''));
    expect(within(avatarGroup()).getByText(I.empty)).toBeInTheDocument();
    fireEvent.click(within(linkGroups()[0]).getByRole('button', { name: I.useUrl }));
    fireEvent.change(within(linkGroups()[0]).getByRole('textbox', { name: HB.imageUrlLabel }), {
      target: { value: 'https://images.example/blog.png' },
    });
    await waitFor(() => expect(storedLinks()[0].imageUrl).toBe('https://images.example/blog.png'));
    expect(storedLinks()[1].imageUrl).toBeUndefined();
  });

  it('失敗しても元の画像を保ち、短い文を出す', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DRAFT, cover: 'https://images.example/old-cover.png' }));
    await renderWithImageFields();
    await pick(coverGroup(), 1);
    await answerError(0, 429, 'rate_limited');
    expect(within(coverGroup()).getByRole('alert')).toHaveTextContent(I.errors.rateLimited);
    expect(within(coverGroup()).getByRole('alert')).toHaveTextContent(I.keepOriginal);
    expect(stored().cover).toBe('https://images.example/old-cover.png');
  });

  it('アップロード中は公開のボタンを止めて理由を出し、届いたら公開できる', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[0], 1);
    await waitFor(() => expect(publishButtons()[0]).toBeDisabled());
    for (const button of publishButtons()) expect(button).toBeDisabled();
    expect(screen.getAllByText(HC.barReasonImageBusy)).toHaveLength(2);
    expect(within(linkGroups()[0]).getByRole('status')).toHaveTextContent(I.uploading);
    fireEvent.click(publishButtons()[0]);
    expect(posts).toHaveLength(0);
    await answer(0, `${BLOB}/link/x.jpg`);
    await waitFor(() => expect(publishButtons()[0]).toBeEnabled());
    expect(screen.queryByText(HC.barReasonImageBusy)).not.toBeInTheDocument();
    fireEvent.click(publishButtons()[0]);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0].profile as { links: unknown[] }).links[0]).toEqual({
      label: 'Blog', url: 'https://blog.example', imageUrl: `${BLOB}/link/x.jpg`,
    });
  });

  it('「やめる」で送信をやめると公開を止めなくなり、後から届いた画像は入らない', async () => {
    await renderWithImageFields();
    await pick(avatarGroup(), 1);
    fireEvent.click(within(avatarGroup()).getByRole('button', { name: I.cancel }));
    await expectPublishNotHeld();
    await answer(0, `${BLOB}/avatar/late.jpg`);
    expect(stored().avatar).toBe('');
    expect(within(avatarGroup()).getByText(I.empty)).toBeInTheDocument();
  });
});

describe('遅れて届いた結果を捨てる', () => {
  it('アバター: 送っている間に URL を手で入れたら、後から届いた画像は入らない', async () => {
    await renderWithImageFields();
    await pick(avatarGroup(), 1);
    fireEvent.click(within(avatarGroup()).getByRole('button', { name: I.useUrl }));
    fireEvent.change(within(avatarGroup()).getByRole('textbox', { name: HP.avatarLabel }), {
      target: { value: 'https://images.example/typed.png' },
    });
    await answer(0, `${BLOB}/avatar/late.jpg`);
    await waitFor(() => expect(stored().avatar).toBe('https://images.example/typed.png'));
    expect(within(avatarGroup()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('カバー: やめて外した後に届いた画像は入らない (外した値のまま)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DRAFT, cover: 'https://images.example/old-cover.png' }));
    await renderWithImageFields();
    await pick(coverGroup(), 1);
    fireEvent.click(within(coverGroup()).getByRole('button', { name: I.cancel }));
    fireEvent.click(within(coverGroup()).getByRole('button', { name: I.remove }));
    await answer(0, `${BLOB}/cover/late.jpg`);
    await waitFor(() => expect(stored().cover).toBe(''));
  });

  it('リンク: 送っている行を消したら、後から届いた画像はほかの行に入らない', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[1], 1);
    // 2 本目 (Shop) を消す (行の「削除」)。
    fireEvent.click(screen.getAllByRole('button', { name: HP.removeLink })[1]);
    await waitFor(() => expect(storedLinks()).toHaveLength(1));
    await expectPublishNotHeld();
    await answer(0, `${BLOB}/link/late.jpg`);
    expect(storedLinks()).toEqual([{ label: 'Blog', url: 'https://blog.example' }]);
    expect(within(linkGroups()[0]).getByText(I.empty)).toBeInTheDocument();
  });

  it('リンク: 上の行を消しても、送っていた行 (下の行) に入る', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[1], 1);
    fireEvent.click(screen.getAllByRole('button', { name: HP.removeLink })[0]);
    await waitFor(() => expect(storedLinks()).toHaveLength(1));
    // 送っていた行は消えていないので、アップロード中のまま (公開を止めたまま)。
    expect(within(linkGroups()[0]).getByRole('status')).toHaveTextContent(I.uploading);
    await answer(0, `${BLOB}/link/shop.jpg`);
    await waitFor(() => expect(storedLinks()).toEqual([{ label: 'Shop', url: 'https://shop.example', imageUrl: `${BLOB}/link/shop.jpg` }]));
  });

  it('リンク: 送っている間に行を並べ替えても、送り始めた行に入る (位置の同じ別の行に入らない)', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[0], 1);
    // 1 本目 (Blog) を下へ動かす。
    fireEvent.click(screen.getAllByRole('button', { name: HP.moveDown })[0]);
    await waitFor(() => expect(storedLinks().map((l) => l.label)).toEqual(['Shop', 'Blog']));
    await answer(0, `${BLOB}/link/blog.jpg`);
    await waitFor(() => expect(storedLinks()[1].imageUrl).toBe(`${BLOB}/link/blog.jpg`));
    expect(storedLinks()[0]).toEqual({ label: 'Shop', url: 'https://shop.example' });
  });

  it('リンク: 送っている間に同じ行のラベルを書き換えても、画像はその行に入り、書き換えも残る', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[0], 1);
    const label = screen.getAllByRole('textbox', { name: HB.linkLabel })[0];
    fireEvent.change(label, { target: { value: 'My blog' } });
    // 行を作り直しても欄は同じもの (アップロード中のまま・入力の node も同じ)。
    expect(screen.getAllByRole('textbox', { name: HB.linkLabel })[0]).toBe(label);
    expect(within(linkGroups()[0]).getByRole('status')).toHaveTextContent(I.uploading);
    await answer(0, `${BLOB}/link/blog.jpg`);
    await waitFor(() => expect(storedLinks()[0]).toEqual({ label: 'My blog', url: 'https://blog.example', imageUrl: `${BLOB}/link/blog.jpg` }));
  });

  it('リンク: 2 つの行で同時に送っても、それぞれの行に入る (届く順が逆でも)', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[0], 1);
    await pick(linkGroups()[1], 2);
    await answer(1, `${BLOB}/link/shop.jpg`);
    await answer(0, `${BLOB}/link/blog.jpg`);
    await waitFor(() => expect(storedLinks().map((l) => l.imageUrl)).toEqual([`${BLOB}/link/blog.jpg`, `${BLOB}/link/shop.jpg`]));
  });

  it('imageUpload が false に切り替わった後に URL の欄で入れた値を、後から届いた画像が上書きしない', async () => {
    const { qc } = await renderWithImageFields();
    await pick(avatarGroup(), 1);
    await setImageUpload(qc, false);
    // 今の URL の欄に戻り、アップロード中の印も外れる。
    const avatar = await screen.findByRole('textbox', { name: /^アバター画像 URL/ });
    await expectPublishNotHeld();
    fireEvent.change(avatar, { target: { value: 'https://images.example/typed.png' } });
    await answer(0, `${BLOB}/avatar/late.jpg`);
    await waitFor(() => expect(stored().avatar).toBe('https://images.example/typed.png'));
  });

  it('imageUpload が false → true に戻った直後に選んだ画像は入る (切り替えが新しい送信を捨てない)', async () => {
    const { qc } = await renderWithImageFields();
    await setImageUpload(qc, false);
    await screen.findByRole('textbox', { name: /^アバター画像 URL/ });
    await setImageUpload(qc, true);
    await pick(await screen.findByRole('group', { name: HP.avatarImageLabel }), 1);
    await answer(0, `${BLOB}/avatar/new.jpg`);
    await waitFor(() => expect(stored().avatar).toBe(`${BLOB}/avatar/new.jpg`));
  });

  it('サインインが外れたら (別のウォレットのセッション) 今の URL の欄に戻る', async () => {
    const view = await renderWithImageFields();
    h.signedIn = false;
    view.rerender(
      <QueryClientProvider client={view.qc}>
        <HandleProfileBuilder />
      </QueryClientProvider>,
    );
    await screen.findByRole('textbox', { name: /^アバター画像 URL/ });
    expect(screen.queryByRole('group', { name: HP.avatarImageLabel })).not.toBeInTheDocument();
  });

  it('送っている間に公開中の @handle の編集に入ったら、前の下書きに向けた画像は読み込んだ内容に入らない', async () => {
    h.handles = [BOB];
    await renderWithImageFields();
    await pick(avatarGroup(), 1);
    await pick(linkGroups()[0], 2);
    fireEvent.click(await screen.findByRole('button', { name: HC.edit }));
    await waitFor(() => expect(stored().name).toBe('Bob'));
    // 欄を作り直したので、アップロード中の印は消え、公開も止めない。
    await expectPublishNotHeld();
    expect(within(avatarGroup()).queryByRole('status')).toBeNull();
    await answer(0, `${BLOB}/avatar/late.jpg`);
    await answer(1, `${BLOB}/link/late.jpg`);
    expect(stored().avatar).toBe('https://images.example/bob.png');
    expect(storedLinks()).toEqual([{ label: 'Bob site', url: 'https://bob.example' }]);
  });

  it('送っている間に編集をやめて下書きを戻しても、後から届いた画像は戻した下書きに入らない', async () => {
    h.handles = [BOB];
    await renderWithImageFields();
    fireEvent.click(await screen.findByRole('button', { name: HC.edit }));
    await waitFor(() => expect(stored().name).toBe('Bob'));
    await pick(avatarGroup(), 1);
    fireEvent.click(screen.getByRole('button', { name: HC.stopEditing }));
    await waitFor(() => expect(stored().name).toBe('Alice'));
    await answer(0, `${BLOB}/avatar/late.jpg`);
    expect(stored().avatar).toBe('');
    expect(within(avatarGroup()).getByText(I.empty)).toBeInTheDocument();
  });
});

describe('下書き', () => {
  it('アップロード中に画面を閉じて開き直しても、アップロード中の状態は残らない (下書きに入るのは URL だけ)', async () => {
    const first = await renderWithImageFields();
    await pick(avatarGroup(), 1);
    expect(within(avatarGroup()).getByRole('status')).toHaveTextContent(I.uploading);
    await waitFor(() => expect(screen.getAllByText(HC.barReasonImageBusy)).toHaveLength(2));
    first.unmount();
    // 閉じた後に届いた応答は、どこにも入らない。
    await answer(0, `${BLOB}/avatar/late.jpg`);
    expect(stored().avatar).toBe('');
    expect(Object.keys(stored()).sort()).toEqual(Object.keys(DEFAULT_PROFILE_DRAFT).sort());

    await renderWithImageFields();
    expect(within(avatarGroup()).queryByRole('status')).not.toBeInTheDocument();
    expect(within(avatarGroup()).getByRole('button', { name: I.choose })).toBeEnabled();
    expect(screen.queryByText(HC.barReasonImageBusy)).not.toBeInTheDocument();
  });

  it('アップロード中は別のタブの下書きを取り込まず、終わってから取り込む (送り始めた行が入れ替わらない)', async () => {
    await renderWithImageFields();
    await pick(linkGroups()[1], 1);
    // 別のタブが同じ下書きのリンクを並べ替え、名前を変えた。
    const otherTab = { ...stored(), name: 'Alice (other tab)', links: [...storedLinks()].reverse() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(otherTab));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByLabelText('表示名')).toHaveValue('Alice');
    await answer(0, `${BLOB}/link/shop.jpg`);
    // 画像は送り始めた行 (Shop) に入り、終わった後に取り込んだのはこのタブで変えていない名前だけ。
    await waitFor(() => expect(screen.getByLabelText('表示名')).toHaveValue('Alice (other tab)'));
    await waitFor(() => expect(storedLinks()).toEqual([
      { label: 'Blog', url: 'https://blog.example' },
      { label: 'Shop', url: 'https://shop.example', imageUrl: `${BLOB}/link/shop.jpg` },
    ]));
  });
});
