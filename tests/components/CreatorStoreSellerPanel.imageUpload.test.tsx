// 出品フォームの画像の欄 (出品者の GET の imageUpload)。false / 無いときは今の URL の欄のまま (DOM の pin は
// CreatorStoreSellerPanel.boundaries.test.tsx が見る)。true のときは表紙を画像の欄、追加画像をサムネと「画像を追加」にし、
// 保存の形 (imageUrl の文字列・galleryUrls の配列) と保存の API は変えない。AI 出品アシスタントの「この画像を表紙に使う」は
// 押したときだけアップロードする。画像の下ごしらえ (canvas) は差し替え、POST /api/images/upload は fetch の mock で受ける。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import { COO_WORLD_DRAFT, jsonResponse } from '../_helpers/listingAssistantFixtures';

const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const BLOB = 'https://teststore.public.blob.vercel-storage.com/v1/k';
const PRODUCT_ID = `h_${'d'.repeat(32)}`;

const prepare = vi.hoisted(() => ({ upload: vi.fn(), listing: vi.fn() }));
vi.mock('@/lib/images/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/images/prepare')>()),
  prepareUploadImage: prepare.upload,
}));
vi.mock('@/components/creator-store-seller/listingAssistantImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/creator-store-seller/listingAssistantImage')>()),
  prepareListingImage: prepare.listing,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, enableCreatorStoreUi: true, enableLicenseNftUi: false, enableStoreDeliveryTicketUi: false },
  };
});
vi.mock('@/hooks/useStoreCacheScope', () => ({ useStoreCacheScope: () => {} }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true, address: ADDRESS }) }));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <button type="button">Connect wallet</button> }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true, sessionAddress: ADDRESS, signIn: vi.fn(), isSigningIn: false, signInError: null,
    signOut: vi.fn(), mismatch: false, isLoading: false,
  }),
}));

import { CreatorStoreSellerPanel } from '@/components/CreatorStoreSellerPanel';

const S = ja.CreatorStoreSeller;
const A = S.assistant;
const I = ja.ImageField;

type Pending = { resolve: (response: Response) => void; init: RequestInit };
let uploads: Pending[];
let fetchMock: ReturnType<typeof vi.fn>;

function existingProduct() {
  return {
    id: PRODUCT_ID, payTo: ADDRESS, title: '既存の商品', priceJpyc: '1000', contentKind: 'text', label: 'prompt',
    imageUrl: 'https://images.example/cover.png', galleryUrls: ['https://images.example/g1.png', 'https://images.example/g2.png'],
    saleActive: false, usdcEnabled: true, contentAvailable: true,
  };
}

function stubApi(seller: { imageUpload?: boolean; listingAssistant?: boolean }) {
  uploads = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/images/upload')) {
      return new Promise<Response>((resolve) => uploads.push({ resolve, init: init! }));
    }
    if (url === '/api/store/seller') return jsonResponse({ ok: true, seller: null, ...seller });
    if (url === '/api/store/products' && !init?.method) return jsonResponse({ ok: true, products: [existingProduct()], max: 24 });
    if (url === `/api/store/products/${PRODUCT_ID}` && !init?.method) {
      return jsonResponse({ ok: true, product: existingProduct(), content: { kind: 'text', value: '本文' } });
    }
    if (url === '/api/store/seller/listing-assistant') {
      return jsonResponse({
        ok: true,
        draft: {
          title: { value: COO_WORLD_DRAFT.title, fits: true }, desc: { value: COO_WORLD_DRAFT.desc, fits: true },
          tags: { value: COO_WORLD_DRAFT.tags, fits: true }, en: { value: COO_WORLD_DRAFT.en, fits: true },
          x: { value: COO_WORLD_DRAFT.x, fits: true }, checks: { value: COO_WORLD_DRAFT.checks, fits: true },
        },
      });
    }
    if (init?.method) return jsonResponse({ ok: true, product: existingProduct() });
    return jsonResponse({ ok: false, error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={client}>
      <CreatorStoreSellerPanel handle="alice" />
    </QueryClientProvider>,
  );
}

const uploadCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/images/upload'));
const saveCall = () =>
  fetchMock.mock.calls.find(
    ([url, init]) => String(url).startsWith('/api/store/products') && (init?.method === 'POST' || init?.method === 'PATCH'),
  );

function pick(input: HTMLInputElement, name = 'photo.jpg') {
  fireEvent.change(input, { target: { files: [new File(['raw'], name, { type: 'image/jpeg' })] } });
}

async function answer(index: number, url: string) {
  await act(async () => uploads[index].resolve(jsonResponse({ ok: true, url })));
}

const coverGroup = () => screen.getByRole('group', { name: S.coverImageLabel });
const galleryGroup = () => screen.getByRole('group', { name: S.galleryLabel.replace('{max}', '4') });
const fileInputIn = (element: HTMLElement) => element.querySelector('input[type="file"]') as HTMLInputElement;

beforeEach(() => {
  vi.unstubAllGlobals();
  prepare.upload.mockImplementation(async () => ({
    ok: true,
    image: { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), type: 'image/jpeg', width: 10, height: 10 },
  }));
  prepare.listing.mockResolvedValue({ ok: true, image: { data: '/9j/4A==', bytes: 4, width: 10, height: 10 } });
});

describe('imageUpload が false / 無いとき', () => {
  it.each([false, undefined])('%s なら今の URL の欄のまま (画像の欄・file の欄を出さない)', async (imageUpload) => {
    stubApi({ imageUpload, listingAssistant: true });
    const { container } = renderPanel();
    await screen.findByRole('heading', { name: '新しい商品' });
    expect(screen.getByLabelText(S.imageUrlLabel)).toHaveAttribute('id', 'creator-store-product-image-url');
    expect(screen.getByLabelText(S.galleryUrlsLabel)).toHaveAttribute('id', 'creator-store-product-gallery-urls');
    expect(screen.queryByRole('button', { name: I.choose })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: S.galleryAdd })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: S.coverImageLabel })).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();

    // AI 出品アシスタントにも「この画像を表紙に使う」を出さない。
    fireEvent.click(screen.getByRole('button', { name: A.open }));
    pick(await screen.findByLabelText(A.imageLabel) as HTMLInputElement);
    await screen.findByText(A.imageSelected.replace('{width}', '10').replace('{height}', '10').replace('{kb}', '1'));
    expect(screen.queryByRole('button', { name: A.useAsCover })).not.toBeInTheDocument();
  });
});

describe('imageUpload が true のとき', () => {
  it('表紙と追加画像 4 枚をアップロードし、保存の body は今と同じ形 (imageUrl の文字列・galleryUrls の配列)', async () => {
    stubApi({ imageUpload: true });
    renderPanel();
    await screen.findByRole('heading', { name: '新しい商品' });
    expect(screen.queryByLabelText(S.imageUrlLabel)).not.toBeInTheDocument();

    pick(fileInputIn(coverGroup()));
    await waitFor(() => expect(uploads).toHaveLength(1));
    const [url, init] = uploadCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/images/upload?purpose=product');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'image/jpeg' }, cache: 'no-store' });
    expect(init.body).toBeInstanceOf(Blob);
    await answer(0, `${BLOB}/product/cover.jpg`);
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', `${BLOB}/product/cover.jpg`);

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(within(galleryGroup()).getByRole('button', { name: S.galleryAdd }));
      pick(fileInputIn(galleryGroup()), `g${index}.jpg`);
      await waitFor(() => expect(uploads).toHaveLength(index + 2));
      await answer(index + 1, `${BLOB}/product/g${index}.jpg`);
    }
    expect(within(galleryGroup()).queryByRole('button', { name: S.galleryAdd })).not.toBeInTheDocument();
    expect(within(galleryGroup()).getByText(S.galleryFull.replace('{max}', '4'))).toBeInTheDocument();
    expect(within(galleryGroup()).getAllByRole('button', { name: I.remove })).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '新しい商品' } });
    fireEvent.change(screen.getByLabelText(S.priceLabel), { target: { value: '500' } });
    fireEvent.change(document.getElementById('creator-store-product-content')!, { target: { value: 'https://example.com/file' } });
    fireEvent.submit(screen.getByLabelText('商品名').closest('form')!);
    await waitFor(() => expect(saveCall()).toBeDefined());
    const body = JSON.parse(String((saveCall() as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.imageUrl).toBe(`${BLOB}/product/cover.jpg`);
    expect(body.galleryUrls).toEqual([0, 1, 2, 3].map((index) => `${BLOB}/product/g${index}.jpg`));
  });

  it('既存の商品の画像はそのまま出し、外した追加画像だけを落として保存する (URL の欄で開くと今の textarea)', async () => {
    stubApi({ imageUpload: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', 'https://images.example/cover.png');
    const removeButtons = within(galleryGroup()).getAllByRole('button', { name: I.remove });
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0]).toHaveAccessibleDescription(S.galleryItem.replace('{number}', '1'));
    fireEvent.click(removeButtons[0]);

    fireEvent.click(within(galleryGroup()).getByRole('button', { name: I.useUrl }));
    expect(screen.getByLabelText(S.galleryUrlsLabel)).toHaveValue('https://images.example/g2.png');
    fireEvent.click(within(coverGroup()).getByRole('button', { name: I.useUrl }));
    expect(screen.getByLabelText(S.imageUrlLabel)).toHaveValue('https://images.example/cover.png');

    fireEvent.submit(screen.getByLabelText('商品名').closest('form')!);
    await waitFor(() => expect(saveCall()).toBeDefined());
    const [saveUrl, saveInit] = saveCall() as [string, RequestInit];
    expect(saveUrl).toBe(`/api/store/products/${PRODUCT_ID}`);
    const body = JSON.parse(String(saveInit.body)) as Record<string, unknown>;
    expect(body.imageUrl).toBe('https://images.example/cover.png');
    expect(body.galleryUrls).toEqual(['https://images.example/g2.png']);
    expect(uploadCalls()).toHaveLength(0);
  });

  it('アップロード中は保存を止める (ボタンも Enter の送信も)・終われば保存できる', async () => {
    stubApi({ imageUpload: true });
    renderPanel();
    await screen.findByRole('heading', { name: '新しい商品' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '新しい商品' } });
    fireEvent.change(screen.getByLabelText(S.priceLabel), { target: { value: '500' } });
    fireEvent.change(document.getElementById('creator-store-product-content')!, { target: { value: 'https://example.com/file' } });

    pick(fileInputIn(coverGroup()));
    await waitFor(() => expect(uploads).toHaveLength(1));
    const submit = screen.getByRole('button', { name: S.createProduct });
    expect(submit).toBeDisabled();
    expect(screen.getByText(S.imageBusySave)).toBeInTheDocument();
    fireEvent.submit(screen.getByLabelText('商品名').closest('form')!);
    expect(saveCall()).toBeUndefined();

    await answer(0, `${BLOB}/product/cover.jpg`);
    expect(submit).toBeEnabled();
    fireEvent.submit(screen.getByLabelText('商品名').closest('form')!);
    await waitFor(() => expect(saveCall()).toBeDefined());
    expect(JSON.parse(String((saveCall() as [string, RequestInit])[1].body)).imageUrl).toBe(`${BLOB}/product/cover.jpg`);
  });

  it('アップロードの失敗では元の表紙を保つ', async () => {
    stubApi({ imageUpload: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    pick(fileInputIn(coverGroup()));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].resolve(jsonResponse({ ok: false, error: 'rate_limited', retryAfterSec: 60 }, 429)));
    expect(within(coverGroup()).getByRole('alert')).toHaveTextContent(I.errors.rateLimited);
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', 'https://images.example/cover.png');
  });

  it('編集の対象を替えたら、前の商品のアップロードの応答を次の商品に入れない', async () => {
    stubApi({ imageUpload: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    pick(fileInputIn(coverGroup()));
    await waitFor(() => expect(uploads).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: S.cancelEdit }));
    await screen.findByRole('heading', { name: '新しい商品' });
    expect(screen.getByRole('button', { name: S.createProduct })).toBeEnabled();
    await answer(0, `${BLOB}/product/late.jpg`);
    expect(coverGroup().querySelector('img')).toBeNull();
  });

  it('AI 出品アシスタント: 画像を選んで案を作っただけではアップロードせず、「この画像を表紙に使う」で表紙に入れ、元に戻せる', async () => {
    stubApi({ imageUpload: true, listingAssistant: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    fireEvent.click(screen.getByRole('button', { name: A.open }));
    pick(await screen.findByLabelText(A.imageLabel) as HTMLInputElement, 'shot.png');
    const useAsCover = await screen.findByRole('button', { name: A.useAsCover });
    fireEvent.click(screen.getByRole('button', { name: A.generate }));
    await screen.findByRole('heading', { name: A.resultHeading });
    fireEvent.click(screen.getByRole('button', { name: A.applyTitle }));
    expect(uploadCalls()).toHaveLength(0);
    expect(prepare.upload).not.toHaveBeenCalled();

    fireEvent.click(useAsCover);
    fireEvent.click(useAsCover);
    await waitFor(() => expect(uploads).toHaveLength(1));
    // 表紙の大きさで、選んだ元の file から描き直す (AI に送った JPEG ではない)。
    expect(prepare.upload).toHaveBeenCalledTimes(1);
    expect(prepare.upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'shot.png' }), 'product');
    expect(screen.getByRole('button', { name: S.saveProduct })).toBeDisabled();
    await answer(0, `${BLOB}/product/ai.jpg`);
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', `${BLOB}/product/ai.jpg`);
    expect(screen.getByText(A.coverApplied)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: S.saveProduct })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: A.undoCover }));
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', 'https://images.example/cover.png');
  });

  async function openAssistantWithImage(name = 'shot.png') {
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    fireEvent.click(screen.getByRole('button', { name: A.open }));
    const input = (await screen.findByLabelText(A.imageLabel)) as HTMLInputElement;
    pick(input, name);
    return { input, useAsCover: await screen.findByRole('button', { name: A.useAsCover }) };
  }

  it('AI の表紙の応答が遅れて届いても、その間に手で入れた表紙の URL を上書きしない', async () => {
    stubApi({ imageUpload: true, listingAssistant: true });
    renderPanel();
    const { useAsCover } = await openAssistantWithImage();
    fireEvent.click(useAsCover);
    await waitFor(() => expect(uploads).toHaveLength(1));

    fireEvent.click(within(coverGroup()).getByRole('button', { name: I.useUrl }));
    fireEvent.change(screen.getByLabelText(S.imageUrlLabel), { target: { value: 'https://images.example/typed.png' } });
    await answer(0, `${BLOB}/product/late-ai.jpg`);

    expect(screen.getByLabelText(S.imageUrlLabel)).toHaveValue('https://images.example/typed.png');
    expect(screen.queryByText(A.coverApplied)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: S.saveProduct })).toBeEnabled();
  });

  it('表紙の欄のアップロードの応答が遅れて届いても、その間に AI で入れた表紙を上書きしない', async () => {
    stubApi({ imageUpload: true, listingAssistant: true });
    renderPanel();
    const { useAsCover } = await openAssistantWithImage();
    pick(fileInputIn(coverGroup()), 'field.jpg');
    await waitFor(() => expect(uploads).toHaveLength(1));
    fireEvent.click(useAsCover);
    await waitFor(() => expect(uploads).toHaveLength(2));
    await answer(1, `${BLOB}/product/ai.jpg`);
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', `${BLOB}/product/ai.jpg`);
    await answer(0, `${BLOB}/product/late-field.jpg`);
    expect(coverGroup().querySelector('img')).toHaveAttribute('src', `${BLOB}/product/ai.jpg`);
    expect(screen.getByRole('button', { name: S.saveProduct })).toBeEnabled();
  });

  it('AI で画像を選び直している間 (準備中) は「この画像を表紙に使う」を押せない (前の画像を公開しない)', async () => {
    stubApi({ imageUpload: true, listingAssistant: true });
    let finishB!: () => void;
    prepare.listing
      .mockResolvedValueOnce({ ok: true, image: { data: '/9j/4A==', bytes: 4, width: 10, height: 10 } })
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishB = () => resolve({ ok: true, image: { data: '/9j/4B==', bytes: 4, width: 20, height: 20 } });
        }),
      );
    renderPanel();
    const { input, useAsCover } = await openAssistantWithImage('a.png');
    expect(useAsCover).toBeEnabled();
    pick(input, 'b.png');
    await waitFor(() => expect(screen.getByRole('button', { name: A.useAsCover })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: A.useAsCover }));
    expect(prepare.upload).not.toHaveBeenCalled();

    await act(async () => finishB());
    const ready = screen.getByRole('button', { name: A.useAsCover });
    expect(ready).toBeEnabled();
    fireEvent.click(ready);
    await waitFor(() => expect(prepare.upload).toHaveBeenCalledTimes(1));
    expect(prepare.upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'b.png' }), 'product');
  });
});
