// レジの商品の画像 (画像のアップロード PR 3B)。商品の編集のシートの画像の URL の欄を、/api/auth/siwe/me の imageUpload が true の
// ときだけ画像の欄 (components/ImageField・用途 preset・長辺 800) にする。保存の形は今と同じ (この端末の localStorage の
// https URL の文字列)。本物の RegisterMode・ProductPresetManager・useProductPresets・useLocalStorageSettings を通し、画像の
// 下ごしらえ (canvas) は差し替え、POST /api/images/upload は fetch の mock で受ける (応答を保留して、届く順を決める)。
// 遅れて届いた結果を捨てる: URL の手入力 (元の値に戻しても)・行の削除・シートを閉じる・imageUpload / 本人の切り替え・別のタブの
// 一括読込の後に届いた結果は入れない。並べ替えても送り始めた行 (id) に入る。別のタブの変更は送っている間は取り込まず、書くときに
// 最新の一覧の同じ id の行の画像だけを重ねる (別のタブの改名・行の削除が残る・再読込しても残る)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLayoutEffect, useState, type ReactElement } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import { useProductPresets } from '@/hooks/useProductPresets';
import { IMAGE_MAX_EDGE } from '@/lib/images/purpose';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0x000000000000000000000000000000000000dEaD';
const PRESETS_KEY = 'openpay:product-presets:v1';
const QR_KEY = 'openpay:qr-settings:v2';
const BLOB = 'https://teststore.public.blob.vercel-storage.com/v1/k/preset';
const OLD = 'https://images.example/old.png';

const h = vi.hoisted(() => ({
  signedIn: true,
  sessionAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as string | null,
  imageUpload: true as boolean | undefined,
  imageUploadSignIn: true as boolean | undefined,
  /** 段階 all (サインインすれば誰でも使える)。サインインの前の 1 行はこれだけで出す。 */
  imageUploadOpen: false as boolean | undefined,
}));
const prepare = vi.hoisted(() => ({ upload: vi.fn() }));

vi.mock('@/lib/images/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/images/prepare')>()),
  prepareUploadImage: prepare.upload,
}));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({ useAccount: () => ({ address: ADDR, isConnected: true }) }));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
// /api/auth/siwe/me (useSiweSession は今の取得が成功していて、セッションが接続中の wallet と一致するときだけ imageUpload を true にする)。
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.signedIn,
    sessionAddress: h.signedIn ? h.sessionAddress : null,
    imageUpload: h.imageUpload,
    imageUploadSignIn: h.imageUploadSignIn,
    imageUploadOpen: h.imageUploadOpen,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    refreshSession: vi.fn(),
  }),
}));

import { RegisterMode } from '@/components/RegisterMode';

const PM = ja.ProductPresetManager;
const I = ja.ImageField;
const RM = ja.RegisterMode;

type Row = { id: string; name: string; unitPrice: string; image?: string };

/** 保存の形 (sanitize を通した後と同じ: sortOrder は並びの番号)。 */
function stored(rows: Row[]) {
  return {
    presets: rows.map((row, index) => ({
      id: row.id,
      name: row.name,
      unitPrice: row.unitPrice,
      token: 'jpyc',
      taxRate: 10,
      taxCategory: 'taxable_10',
      memo: null,
      ...(row.image ? { image: row.image } : {}),
      sortOrder: index,
      enabled: true,
    })),
    receipt: { day: '', n: 0 },
  };
}

const ROWS: Row[] = [
  { id: 'a', name: 'コーヒー', unitPrice: '500', image: OLD },
  { id: 'b', name: '紅茶', unitPrice: '450' },
  { id: 'c', name: 'ケーキ', unitPrice: '600' },
];

type Pending = { purpose: string; resolve: (response: Response) => void };
let uploads: Pending[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubApi() {
  uploads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/images/upload')) {
        const purpose = new URL(url, 'https://test.local').searchParams.get('purpose') ?? '';
        return new Promise<Response>((resolve) => uploads.push({ purpose, resolve }));
      }
      return json({ ok: false, error: 'unexpected' }, 404);
    }),
  );
}

function tree(): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <RegisterMode />
    </QueryClientProvider>
  );
}

const savedRows = () => (JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}') as ReturnType<typeof stored>).presets;
const savedImage = (id: string) => savedRows().find((row) => row.id === id)?.image;
const sheet = () => within(screen.getByRole('dialog', { name: RM.productsSheetTitle }));
/** 行の画像の欄 (並びの順) と、最後に追加のフォームの欄。 */
const imageGroups = () => sheet().getAllByRole('group', { name: PM.imageUploadLabel });
const fileInputIn = (element: HTMLElement) => element.querySelector('input[type="file"]') as HTMLInputElement;
/** 欄のプレビューの画像の URL (alt="" の飾りの画像なので role では引けない)。 */
const previewSrc = (element: HTMLElement) => element.querySelector('img')?.getAttribute('src') ?? null;
const nameInputs = () => sheet().getAllByRole('textbox', { name: PM.nameLabel }) as HTMLInputElement[];

async function openSheet() {
  fireEvent.click(await screen.findByRole('button', { name: RM.presetManagerTitle }));
  await screen.findByRole('dialog', { name: RM.productsSheetTitle });
}

async function renderWithImageFields() {
  const view = renderWithIntl(tree());
  await openSheet();
  await waitFor(() => expect(imageGroups()).toHaveLength(ROWS.length + 1));
  return view;
}

/** 画像を選ぶ (file の欄の change)。送信は下ごしらえの後なので、届くまで待つ。 */
async function pick(group: HTMLElement, count: number) {
  fireEvent.change(fileInputIn(group), { target: { files: [new File(['raw'], 'photo.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(uploads).toHaveLength(count));
}

async function answer(index: number, url: string) {
  await act(async () => uploads[index].resolve(json({ ok: true, url })));
}

function focusTab() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  h.signedIn = true;
  h.sessionAddress = ADDR;
  h.imageUpload = true;
  h.imageUploadSignIn = true;
  h.imageUploadOpen = false;
  localStorage.clear();
  localStorage.setItem(PRESETS_KEY, JSON.stringify(stored(ROWS)));
  localStorage.setItem(QR_KEY, JSON.stringify({ receiver: ADDR, token: 'jpyc', chain: 'polygon' }));
  stubApi();
  prepare.upload.mockReset();
  prepare.upload.mockImplementation(async () => ({
    ok: true,
    image: { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), type: 'image/jpeg', width: 10, height: 10 },
  }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('画像の欄を出すか (/api/auth/siwe/me)', () => {
  it.each([
    ['段階 off (imageUpload も imageUploadSignIn も無い)', () => { h.imageUpload = undefined; h.imageUploadSignIn = undefined; }],
    ['サインイン済みでも imageUpload が false (運営者でない・設定が無い)', () => { h.imageUpload = false; }],
    ['/me の取得の失敗 (どれも false)', () => { h.imageUpload = false; h.imageUploadSignIn = false; h.imageUploadOpen = false; }],
    // 段階 admin: サインインの前は運営者かどうか分からない (ヘッダのサインインの導線だけ・画面の 1 行は出さない)。
    ['段階 admin でサインインしていない (imageUploadSignIn だけ)', () => { h.signedIn = false; h.imageUpload = false; }],
  ])('%s なら今の URL の欄のまま (案内の 1 行も出さない)', async (_label, setup) => {
    setup();
    renderWithIntl(tree());
    await openSheet();
    expect(sheet().queryByRole('group', { name: PM.imageUploadLabel })).not.toBeInTheDocument();
    expect(sheet().getAllByRole('textbox', { name: PM.imageLabel })).toHaveLength(ROWS.length + 1);
    expect(sheet().queryByText(I.signInToUpload)).not.toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('input[type="file"]')).toBeNull();
  });

  it('段階 all でサインインしていなければ「サインインすると画像をアップロードできます」の 1 行と今の URL の欄', async () => {
    h.signedIn = false;
    h.imageUpload = false;
    h.imageUploadOpen = true;
    renderWithIntl(tree());
    await openSheet();
    expect(sheet().getByText(I.signInToUpload)).toBeInTheDocument();
    expect(sheet().queryByRole('group', { name: PM.imageUploadLabel })).not.toBeInTheDocument();
    // URL の欄はいつも使える (手入力で保存できる)。
    const url = sheet().getAllByRole('textbox', { name: PM.imageLabel })[1];
    fireEvent.change(url, { target: { value: 'https://images.example/tea.png' } });
    await waitFor(() => expect(savedImage('b')).toBe('https://images.example/tea.png'));
  });

  it('サインイン済みで imageUpload: 各行と追加のフォームが画像の欄 (用途 preset・長辺 800)・今の URL はプレビューに残る', async () => {
    await renderWithImageFields();
    expect(previewSrc(imageGroups()[0])).toBe(OLD);
    expect(within(imageGroups()[1]).getByText(I.empty)).toBeInTheDocument();
    // 追加のフォームの欄だけに長辺の案内。「URL で指定する ›」を開くと今の案内 (URL の貼り方・ガイド) と 512 字の上限。
    const add = imageGroups()[ROWS.length];
    expect(within(add).getByText(I.hint.replace('{max}', '800'))).toBeInTheDocument();
    fireEvent.click(within(add).getByRole('button', { name: I.useUrl }));
    expect(within(add).getByRole('link', { name: PM.imageGuideLink })).toHaveAttribute('href', '/ja/guide/image-url');
    expect(within(add).getByRole('textbox', { name: PM.imageLabel })).toHaveAttribute('maxlength', '512');
    expect(sheet().queryByText(I.signInToUpload)).not.toBeInTheDocument();

    await pick(imageGroups()[1], 1);
    expect(uploads[0].purpose).toBe('preset');
    // 長辺は用途の既定 (preset = 800・lib/images/prepare が IMAGE_MAX_EDGE で縮める)。
    expect(prepare.upload).toHaveBeenCalledWith(expect.any(File), 'preset');
    expect(IMAGE_MAX_EDGE.preset).toBe(800);
    await answer(0, `${BLOB}/b.jpg`);
    await waitFor(() => expect(savedImage('b')).toBe(`${BLOB}/b.jpg`));
    // 保存の形は今と同じ (image は URL の文字列・ほかの行とキーは変わらない)。
    expect(savedRows()).toEqual(stored([ROWS[0], { ...ROWS[1], image: `${BLOB}/b.jpg` }, ROWS[2]]).presets);
  });
});

describe('遅れて届いた結果', () => {
  it('2 つの行の結果を逆の順に同じ確定の中で返しても、両方の行に入る (描画のときの一覧を書き戻さない)', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[1], 1);
    await pick(imageGroups()[2], 2);
    await act(async () => {
      uploads[1].resolve(json({ ok: true, url: `${BLOB}/c.jpg` }));
      uploads[0].resolve(json({ ok: true, url: `${BLOB}/b.jpg` }));
    });
    await waitFor(() => expect(savedImage('b')).toBe(`${BLOB}/b.jpg`));
    expect(savedImage('c')).toBe(`${BLOB}/c.jpg`);
    expect(savedImage('a')).toBe(OLD);
    expect(previewSrc(imageGroups()[1])).toBe(`${BLOB}/b.jpg`);
    expect(previewSrc(imageGroups()[2])).toBe(`${BLOB}/c.jpg`);
  });

  it('送っている間に URL を書き換えて元の URL に戻すと、後から届いた画像は入らない', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[0], 1);
    fireEvent.click(within(imageGroups()[0]).getByRole('button', { name: I.useUrl }));
    const url = within(imageGroups()[0]).getByRole('textbox', { name: PM.imageLabel });
    fireEvent.change(url, { target: { value: 'https://images.example/typed.png' } });
    fireEvent.change(url, { target: { value: OLD } });
    await answer(0, `${BLOB}/late.jpg`);
    await waitFor(() => expect(savedImage('a')).toBe(OLD));
    expect(previewSrc(imageGroups()[0])).toBe(OLD);
  });

  it('行を消した後に届いた結果は入らない (ほかの行も変わらない)', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[1], 1);
    fireEvent.click(sheet().getAllByRole('button', { name: PM.remove })[1]);
    await waitFor(() => expect(savedRows().map((row) => row.id)).toEqual(['a', 'c']));
    await answer(0, `${BLOB}/b.jpg`);
    expect(savedRows()).toEqual(stored([ROWS[0], ROWS[2]]).presets);
  });

  it('並べ替えても、送り始めた行 (id) に入る', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[2], 1);
    fireEvent.click(sheet().getAllByRole('button', { name: PM.moveUp })[2]);
    await waitFor(() => expect(savedRows().map((row) => row.id)).toEqual(['a', 'c', 'b']));
    await answer(0, `${BLOB}/c.jpg`);
    await waitFor(() => expect(savedImage('c')).toBe(`${BLOB}/c.jpg`));
    expect(savedImage('b')).toBeUndefined();
    expect(previewSrc(imageGroups()[1])).toBe(`${BLOB}/c.jpg`);
  });

  it('シートを閉じた後に届いた結果は入らない', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[1], 1);
    fireEvent.click(sheet().getByRole('button', { name: ja.QrGenerator.shopSettings.done }));
    await answer(0, `${BLOB}/b.jpg`);
    expect(savedImage('b')).toBeUndefined();
  });

  it.each([
    ['imageUpload が false になった (URL の欄に戻る)', () => { h.imageUpload = false; }],
    ['セッションの本人が替わった', () => { h.sessionAddress = ADDR2; }],
  ])('%s 後に届いた、前に始まった結果は入らない', async (_label, change) => {
    const view = await renderWithImageFields();
    await pick(imageGroups()[1], 1);
    change();
    view.rerender(tree());
    await answer(0, `${BLOB}/b.jpg`);
    expect(savedImage('b')).toBeUndefined();
  });
});

describe('商品の id と追加のフォームの key', () => {
  it('id が `#new` の商品と追加のフォームを同時に送っても、結果と取り込みの保留が混ざらない', async () => {
    const rows: Row[] = [{ id: '#new', name: 'ナイトブレンド', unitPrice: '700' }, ROWS[1]];
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored(rows)));
    renderWithIntl(tree());
    await openSheet();
    await waitFor(() => expect(imageGroups()).toHaveLength(rows.length + 1));
    await pick(imageGroups()[0], 1);
    await pick(imageGroups()[rows.length], 2);
    // 商品の行の結果は、追加のフォームの送信に捨てられない。
    await answer(0, `${BLOB}/night.jpg`);
    await waitFor(() => expect(savedImage('#new')).toBe(`${BLOB}/night.jpg`));
    expect(within(imageGroups()[rows.length]).getByText(I.empty)).toBeInTheDocument();
    // 追加のフォームがまだ送っているので、別のタブの商品は取り込まない (商品の行の完了で保留が外れない)。
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored([{ ...rows[0], name: '別のタブの名前', image: `${BLOB}/night.jpg` }, rows[1]])));
    focusTab();
    expect(nameInputs()[0].value).toBe('ナイトブレンド');
    await answer(1, `${BLOB}/new.jpg`);
    expect(previewSrc(imageGroups()[rows.length])).toBe(`${BLOB}/new.jpg`);
    expect(savedImage('#new')).toBe(`${BLOB}/night.jpg`);
    // 両方が終わったら、保留していた取り込みをする。
    await waitFor(() => expect(nameInputs()[0].value).toBe('別のタブの名前'));
  });
});

describe('追加のフォーム', () => {
  it('画像を送っている間は「追加」を止め (押しても足さない)、届いたら追加で画像つきの行になる', async () => {
    await renderWithImageFields();
    fireEvent.change(nameInputs()[ROWS.length], { target: { value: 'スコーン' } });
    fireEvent.change(sheet().getByPlaceholderText(PM.pricePlaceholder), { target: { value: '380' } });
    const add = sheet().getByRole('button', { name: PM.addButton });
    expect(add).toBeEnabled();
    await pick(imageGroups()[ROWS.length], 1);
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(savedRows()).toHaveLength(ROWS.length);
    await answer(0, `${BLOB}/new.jpg`);
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() => expect(savedRows()).toHaveLength(ROWS.length + 1));
    expect(savedRows()[ROWS.length]).toMatchObject({ name: 'スコーン', unitPrice: '380', image: `${BLOB}/new.jpg` });
    // 追加の後のフォームは空 (画像も)。
    expect(within(imageGroups()[ROWS.length + 1]).getByText(I.empty)).toBeInTheDocument();
  });
});

describe('別のタブの変更 (送っている間は取り込まず、書くときに画像だけを重ねる)', () => {
  it('別のタブの改名・行の削除を保って画像を重ね、再読込しても残る', async () => {
    const view = await renderWithImageFields();
    await pick(imageGroups()[2], 1);
    // 別のタブが「コーヒー」を改名し、「紅茶」を消して保存した。
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored([{ ...ROWS[0], name: 'ブレンド' }, ROWS[2]])));
    focusTab();
    // 送っている間は取り込まない (この画面は前の一覧のまま)。
    expect(nameInputs().slice(0, ROWS.length).map((input) => input.value)).toEqual(['コーヒー', '紅茶', 'ケーキ']);
    await answer(0, `${BLOB}/c.jpg`);
    const expected = stored([{ ...ROWS[0], name: 'ブレンド' }, { ...ROWS[2], image: `${BLOB}/c.jpg` }]).presets;
    await waitFor(() => expect(savedRows()).toEqual(expected));
    // 画面も保存した一覧に揃う (次の書き込みで前の一覧に戻さない)。
    await waitFor(() => expect(nameInputs().slice(0, 2).map((input) => input.value)).toEqual(['ブレンド', 'ケーキ']));
    expect(imageGroups()).toHaveLength(3);
    fireEvent.change(nameInputs()[1], { target: { value: 'チーズケーキ' } });
    await waitFor(() => expect(savedRows()[1]).toMatchObject({ name: 'チーズケーキ', image: `${BLOB}/c.jpg` }));
    expect(savedRows().map((row) => row.name)).toEqual(['ブレンド', 'チーズケーキ']);
    // 再読込 (作り直して保存値を読む) しても同じ。
    view.unmount();
    renderWithIntl(tree());
    await openSheet();
    await waitFor(() => expect(nameInputs().slice(0, 2).map((input) => input.value)).toEqual(['ブレンド', 'チーズケーキ']));
    expect(previewSrc(imageGroups()[1])).toBe(`${BLOB}/c.jpg`);
  });

  it('別のタブの行が壊れていても (打ちかけの空の価格・数値の画像)、別の商品の画像が届いたときにレジの描画は落ちない', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[2], 1);
    // 別のタブの保存値: コーヒーの画像が数値・紅茶の価格が空 (打ちかけ)。どちらも sanitize が直す値。
    const broken = stored(ROWS).presets.map((row) =>
      row.id === 'a' ? { ...row, image: 123 } : row.id === 'b' ? { ...row, unitPrice: '' } : row,
    );
    localStorage.setItem(PRESETS_KEY, JSON.stringify({ presets: broken, receipt: { day: '', n: 0 } }));
    focusTab();
    await answer(0, `${BLOB}/c.jpg`);
    // 保存には別のタブの値のまま画像だけを重ねる (別のタブの打ちかけを消さない)。
    await waitFor(() => expect(savedImage('c')).toBe(`${BLOB}/c.jpg`));
    expect(savedRows().map((row) => [row.id, row.image, row.unitPrice])).toEqual([
      ['a', 123, '500'],
      ['b', undefined, ''],
      ['c', `${BLOB}/c.jpg`, '600'],
    ]);
    // 画面はこのタブの一覧のまま (壊れた行を描画に渡さない)・描画は続く。
    expect(nameInputs().slice(0, ROWS.length).map((input) => input.value)).toEqual(['コーヒー', '紅茶', 'ケーキ']);
    expect(previewSrc(imageGroups()[0])).toBe(OLD);
    expect(previewSrc(imageGroups()[2])).toBe(`${BLOB}/c.jpg`);
    // 次の書き込みでこのタブの一覧に戻さない (別のタブの値が保存に残る)。
    await act(async () => undefined);
    expect(savedRows()[1].unitPrice).toBe('');
  });

  it('別のタブが一覧を丸ごと入れ替えた (一括読込) 後に届いた結果は入らない', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[0], 1);
    const loaded = stored([{ id: 'x', name: 'ランチ', unitPrice: '1200' }, { id: 'y', name: 'ディナー', unitPrice: '3000' }]);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(loaded));
    focusTab();
    await answer(0, `${BLOB}/a.jpg`);
    await waitFor(() => expect(nameInputs().slice(0, 2).map((input) => input.value)).toEqual(['ランチ', 'ディナー']));
    expect(savedRows()).toEqual(loaded.presets);
  });

  it('同じ行の画像を別のタブも替えていたら、保存済みの方を残す', async () => {
    await renderWithImageFields();
    await pick(imageGroups()[0], 1);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored([{ ...ROWS[0], image: 'https://images.example/other-tab.png' }, ROWS[1], ROWS[2]])));
    focusTab();
    await answer(0, `${BLOB}/a.jpg`);
    await waitFor(() => expect(previewSrc(imageGroups()[0])).toBe('https://images.example/other-tab.png'));
    expect(savedImage('a')).toBe('https://images.example/other-tab.png');
  });

  it('送っていないときは、前面に戻ったら今までどおり取り込む', async () => {
    await renderWithImageFields();
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored([{ ...ROWS[0], name: 'ブレンド' }, ROWS[1], ROWS[2]])));
    focusTab();
    await waitFor(() => expect(nameInputs()[0].value).toBe('ブレンド'));
  });
});

describe('レジの画面 (会計)', () => {
  it('アップロードした画像が商品のタイルに出て、読めない (404) ときは画像だけ隠して名前と価格を残す', async () => {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored([{ ...ROWS[1], image: `${BLOB}/gone.jpg` }])));
    const { container } = renderWithIntl(tree());
    const tile = await within(await screen.findByRole('region', { name: /^(商品|Products)$/ })).findByRole('button', { name: /紅茶/ });
    const image = container.querySelector(`img[src="${BLOB}/gone.jpg"]`) as HTMLImageElement;
    expect(tile).toContainElement(image);
    fireEvent.error(image);
    expect(image.style.display).toBe('none');
    expect(tile).toHaveTextContent('紅茶');
    expect(tile).toHaveTextContent('450');
  });
});

describe('別のタブの取り込みの保留 (holdImport) は描画の確定で効く', () => {
  // 保留を始めた確定 (layout effect) の中で前面に戻った (focus) ときも、まだ保留していない値で取り込まない。
  function HoldHarness() {
    const [busy, setBusy] = useState(false);
    const { presets } = useProductPresets({ holdImport: busy });
    useLayoutEffect(() => {
      if (busy) window.dispatchEvent(new Event('focus'));
    }, [busy]);
    return (
      <>
        <button type="button" onClick={() => setBusy((current) => !current)}>
          toggle
        </button>
        <output data-testid="names">{presets.map((preset) => preset.name).join(',')}</output>
      </>
    );
  }

  it('保留中は前の一覧のまま、保留が終わったら別のタブの一覧を取り込む', async () => {
    renderWithIntl(<HoldHarness />);
    await waitFor(() => expect(screen.getByTestId('names')).toHaveTextContent('コーヒー,紅茶,ケーキ'));
    localStorage.setItem(PRESETS_KEY, JSON.stringify(stored([{ ...ROWS[0], name: 'ブレンド' }, ROWS[1], ROWS[2]])));
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('names')).toHaveTextContent('コーヒー,紅茶,ケーキ');
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(screen.getByTestId('names')).toHaveTextContent('ブレンド,紅茶,ケーキ'));
  });
});
