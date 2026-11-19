// マイページの「アップロードした画像」(components/ImageLibrary.tsx) と /me のカード (components/ImageLibraryCard.tsx)。
// 一覧と削除の通信 (lib/images/libraryClient) は mock して、応答の時を test が決める。
// 出す・出さない (/me の imageUpload・imageUploadSignIn)・一覧・もっと見る・消す前の確認・二重の削除・204 で行を外して
// 読み直す・409 で使っている所を出す・結果の分からない失敗で読み直す・古い GET を捨てる・ウォレットの切り替えを固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import type { ImageLibraryItem } from '@/lib/images/library';
import type { ImageDeleteResult, ImageLibraryPageResult } from '@/lib/images/libraryClient';

const A = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const B = '0x2222222222222222222222222222222222222222';
const T = ja.ImageLibrary;
const intro = T.intro.replace('{max}', '200');

function expectNoGuidance() {
  expect(screen.queryByText(intro)).not.toBeInTheDocument();
  expect(screen.queryByText(T.usageNote)).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('200 枚');
}

const account = vi.hoisted(() => ({ address: undefined as string | undefined }));
const siwe = vi.hoisted(() => ({
  isSignedIn: false,
  isLoading: false,
  imageUpload: false,
  imageUploadSignIn: false,
  refreshSession: vi.fn(),
}));
const client = vi.hoisted(() => ({ fetchImageLibraryPage: vi.fn(), deleteLibraryImage: vi.fn() }));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: account.address, isConnected: !!account.address }) }));
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => siwe }));
vi.mock('@/lib/images/libraryClient', () => client);
vi.mock('@/components/SignInGate', () => ({
  SignInGate: ({ cta, prompt }: { cta: string; prompt?: string }) => (
    <div>
      <p>{prompt}</p>
      <button type="button">{cta}</button>
    </div>
  ),
}));

import { ImageLibrary } from '@/components/ImageLibrary';
import { ImageLibraryCard } from '@/components/ImageLibraryCard';

type Deferred<T> = { resolve: (value: T) => void; promise: Promise<T> };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

let pages: ({ wallet: string; cursor: string | null; signal?: AbortSignal } & Deferred<ImageLibraryPageResult>)[];
let deletes: ({ wallet: string; target: unknown } & Deferred<ImageDeleteResult>)[];

function item(n: number, extra: Partial<ImageLibraryItem> = {}): ImageLibraryItem {
  const id = `img${String(n).padStart(19, '0')}`;
  return {
    id,
    ext: 'jpg',
    purpose: 'product',
    url: `https://s.public.blob.vercel-storage.com/v1/k/product/${id}.jpg`,
    size: 1000,
    uploadedAt: '2026-11-19T03:04:05.000Z',
    usedIn: [],
    ...extra,
  };
}

function signIn(address: string, imageUpload = true) {
  account.address = address;
  Object.assign(siwe, { isSignedIn: true, isLoading: false, imageUpload, imageUploadSignIn: true });
}

function rows() {
  return screen.queryAllByRole('listitem').filter((li) => li.querySelector('img, span') && within(li).queryByRole('button'));
}

function rowFor(n: number) {
  const id = `img${String(n).padStart(19, '0')}`;
  const img = document.querySelector(`img[src$="${id}.jpg"]`);
  const li = img?.closest('li');
  if (!li) throw new Error(`row ${n} not found`);
  return li as HTMLElement;
}

async function resolvePage(index: number, result: ImageLibraryPageResult) {
  await act(async () => {
    pages[index].resolve(result);
    await pages[index].promise;
  });
}

async function resolveDelete(index: number, result: ImageDeleteResult) {
  await act(async () => {
    deletes[index].resolve(result);
    await deletes[index].promise;
  });
}

beforeEach(() => {
  account.address = undefined;
  Object.assign(siwe, { isSignedIn: false, isLoading: false, imageUpload: false, imageUploadSignIn: false });
  siwe.refreshSession.mockReset().mockResolvedValue(undefined);
  pages = [];
  deletes = [];
  client.fetchImageLibraryPage.mockReset().mockImplementation((wallet: string, cursor: string | null, signal?: AbortSignal) => {
    const d = deferred<ImageLibraryPageResult>();
    pages.push({ wallet, cursor, signal, ...d });
    return d.promise;
  });
  client.deleteLibraryImage.mockReset().mockImplementation((wallet: string, target: unknown) => {
    const d = deferred<ImageDeleteResult>();
    deletes.push({ wallet, target, ...d });
    return d.promise;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ImageLibrary: 出す・出さない', () => {
  it('サインインの前で imageUploadSignIn が無い (段階 off など) なら短い文だけで、一覧の GET を送らない', () => {
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByText(T.notAvailable)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.signIn })).not.toBeInTheDocument();
    expect(client.fetchImageLibraryPage).not.toHaveBeenCalled();
  });

  it('サインインの前で imageUploadSignIn ならサインインの入口 (一覧の GET は送らない)', () => {
    siwe.imageUploadSignIn = true;
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByRole('button', { name: T.signIn })).toBeInTheDocument();
    expect(screen.getByText(T.signInPrompt)).toBeInTheDocument();
    expect(client.fetchImageLibraryPage).not.toHaveBeenCalled();
  });

  it('サインイン済みでも imageUpload が無ければ (admin の段階で運営者でない) 短い文だけ', () => {
    signIn(A, false);
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByText(T.notAvailable)).toBeInTheDocument();
    expect(client.fetchImageLibraryPage).not.toHaveBeenCalled();
  });

  it('/me のカードは imageUpload のときだけ (新しいタブではなく同じタブで /ja/me/images へ)', () => {
    const { rerender } = renderWithIntl(<ul><ImageLibraryCard /></ul>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    signIn(A);
    rerender(<ul><ImageLibraryCard /></ul>);
    const link = screen.getByRole('link', { name: new RegExp(ja.MePage.cards.images.title) });
    expect(link).toHaveAttribute('href', '/ja/me/images');
    expect(link).not.toHaveAttribute('target');
  });
});

describe('ImageLibrary: 機能の案内は使えるときだけ (レビュー 1 回目 MUST 6)', () => {
  it('段階 off (サインインの導線も無い) では短い「使えません」の文だけ', () => {
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByText(T.notAvailable)).toBeInTheDocument();
    expectNoGuidance();
  });

  it('admin の段階で運営者でない (サインイン済み・imageUpload が無い) ときも案内を出さない', () => {
    signIn(A, false);
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByText(T.notAvailable)).toBeInTheDocument();
    expectNoGuidance();
  });

  it('サインインの前 (運営者かどうかまだ分からない) は入口だけで、案内を出さない', () => {
    siwe.imageUploadSignIn = true;
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByRole('button', { name: T.signIn })).toBeInTheDocument();
    expectNoGuidance();
  });

  it('使えるときだけ案内を出す', () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByText(intro)).toBeInTheDocument();
    expect(screen.getByText(T.usageNote)).toBeInTheDocument();
  });
});

describe('ImageLibrary: 一覧', () => {
  it('サインイン済みの本人の 1 ページ目を読み、用途・日付・使っている所を出す', async () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    expect(screen.getByRole('status')).toHaveTextContent(T.loading);
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(1);
    expect(pages[0]).toMatchObject({ wallet: A, cursor: null });
    await resolvePage(0, {
      ok: true,
      images: [
        item(1, { purpose: 'avatar' }),
        item(2, {
          usedIn: [
            { kind: 'product', id: 'h_x', title: '星の写真集', field: 'cover' },
            { kind: 'storefront', handle: 'shop', field: 'menu' },
          ],
        }),
      ],
      nextCursor: null,
    });
    const first = rowFor(1);
    expect(first).toHaveTextContent(T.purposes.avatar);
    expect(first).toHaveTextContent(T.notUsed);
    expect(first).toHaveTextContent('にアップロード');
    const second = rowFor(2);
    expect(second).toHaveTextContent(T.usedInLabel);
    expect(second).toHaveTextContent('商品「星の写真集」の表紙');
    expect(second).toHaveTextContent('@shop の店舗のメニューの画像');
    expect(screen.queryByRole('button', { name: T.loadMore })).not.toBeInTheDocument();
  });

  it('画像が無ければ空の文', async () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [], nextCursor: null });
    expect(screen.getByText(T.empty)).toBeInTheDocument();
  });

  it('もっと見るで続きを足す (読んでいる間は押せない・二度押しで 2 回送らない)', async () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [item(1)], nextCursor: 'c:24' });
    const more = screen.getByRole('button', { name: T.loadMore });
    act(() => {
      more.click();
      more.click();
    });
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(2);
    expect(pages[1]).toMatchObject({ wallet: A, cursor: 'c:24' });
    expect(screen.getByRole('button', { name: T.loadingMore })).toBeDisabled();
    await resolvePage(1, { ok: true, images: [item(2), item(1)], nextCursor: null });
    expect(rowFor(1)).toBeInTheDocument();
    expect(rowFor(2)).toBeInTheDocument();
    expect(document.querySelectorAll(`img[src$="${item(1).id}.jpg"]`)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: T.loadMore })).not.toBeInTheDocument();
  });

  it('読めなければ失敗の文ともう一度読み込むボタン (401 はサインインし直しの文)', async () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: false, status: 401, error: 'unknown' });
    expect(screen.getByRole('alert')).toHaveTextContent(T.errors.unauthenticated);
    expect(siwe.refreshSession).toHaveBeenCalledTimes(1);
    expectNoGuidance();
    fireEvent.click(screen.getByRole('button', { name: T.retry }));
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(2);
    await resolvePage(1, { ok: true, images: [item(1)], nextCursor: null });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(rowFor(1)).toBeInTheDocument();
  });
});

describe('ImageLibrary: 消す', () => {
  async function shown(images = [item(1), item(2)], nextCursor: string | null = null) {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images, nextCursor });
  }

  it('消す前に確認 (レジ・下書き・注文リンク・QR で切れる旨)。やめると閉じて「消す」に focus が戻る', async () => {
    await shown();
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    const group = within(rowFor(1)).getByRole('group', { name: T.confirmTitle });
    expect(group).toHaveTextContent(T.confirmBody);
    expect(T.confirmBody).toContain('レジ');
    expect(T.confirmBody).toContain('QR');
    expect(within(group).getByRole('button', { name: T.cancel })).toHaveFocus();
    fireEvent.click(within(group).getByRole('button', { name: T.cancel }));
    expect(within(rowFor(1)).queryByRole('group')).not.toBeInTheDocument();
    expect(within(rowFor(1)).getByRole('button', { name: T.delete })).toHaveFocus();
    expect(client.deleteLibraryImage).not.toHaveBeenCalled();
  });

  it('確定すると 1 回だけ送り (同じ tick の二度押しも)、204 で行を外して先頭から読み直す', async () => {
    await shown();
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    const confirm = within(rowFor(1)).getByRole('button', { name: T.confirmDelete });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(client.deleteLibraryImage).toHaveBeenCalledTimes(1);
    expect(deletes[0]).toMatchObject({ wallet: A, target: { purpose: 'product', id: item(1).id, ext: 'jpg' } });
    expect(within(rowFor(1)).getByRole('button', { name: T.deleting })).toBeDisabled();
    await resolveDelete(0, { ok: true });
    expect(document.querySelector(`img[src$="${item(1).id}.jpg"]`)).toBeNull();
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(2);
    expect(pages[1]).toMatchObject({ wallet: A, cursor: null });
    await resolvePage(1, { ok: true, images: [item(2)], nextCursor: null });
    expect(rowFor(2)).toBeInTheDocument();
  });

  it('409 (使っている) は行に使っている所と理由を出し、読み直さない', async () => {
    await shown();
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(0, {
      ok: false,
      error: 'image_in_use',
      usedIn: [{ kind: 'profile', handle: 'shop', field: 'avatar' }],
    });
    const row = rowFor(1);
    expect(within(row).getByRole('alert')).toHaveTextContent(T.errors.inUse);
    expect(row).toHaveTextContent('@shop のアバター');
    expect(within(row).getByRole('button', { name: T.delete })).toBeEnabled();
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'storage_unavailable', 'unknown'] as const)('結果が分からない失敗 (%s) は一覧を読み直す', async (error) => {
    await shown();
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(0, { ok: false, error });
    expect(screen.getByText(T.errors.deleteUnknown)).toBeInTheDocument();
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(2);
  });

  it('枠 (429) は行に文を出し、読み直さない', async () => {
    await shown();
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(0, { ok: false, error: 'rate_limited' });
    expect(within(rowFor(1)).getByRole('alert')).toHaveTextContent(T.errors.rateLimited);
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(1);
  });

  it('消した後の読み直しが始まったら、その前の「もっと見る」の結果は入れない (古い GET を捨てる)', async () => {
    await shown([item(1), item(2)], 'c:24');
    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    expect(pages[1]).toMatchObject({ cursor: 'c:24' });
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(0, { ok: true });
    // 読み直しで前の「もっと見る」の要求は取り消される。
    expect(pages[1].signal?.aborted).toBe(true);
    await resolvePage(1, { ok: true, images: [item(30)], nextCursor: null });
    expect(document.querySelector(`img[src$="${item(30).id}.jpg"]`)).toBeNull();
    await resolvePage(2, { ok: true, images: [item(2)], nextCursor: 'c:24' });
    expect(rowFor(2)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.loadMore })).toBeEnabled();
  });
});

describe('ImageLibrary: 本人・権限を失ったと分かったとき (レビュー 1 回目 MUST 4)', () => {
  async function shown() {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [item(1), item(2)], nextCursor: 'c:24' });
  }

  function expectCleared() {
    expectNoGuidance();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.delete })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.loadMore })).not.toBeInTheDocument();
  }

  it('一覧を出した後の「もっと見る」が 401 session_mismatch なら、行と確認を消して /me を取り直す', async () => {
    await shown();
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    expect(within(rowFor(1)).getByRole('group')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    await resolvePage(1, { ok: false, status: 401, error: 'session_mismatch' });
    expectCleared();
    expect(screen.getByRole('alert')).toHaveTextContent(T.errors.unauthenticated);
    expect(siwe.refreshSession).toHaveBeenCalledTimes(1);
    expect(client.deleteLibraryImage).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'forbidden', T.errors.notAvailable],
    [403, 'cross_site_request', T.errors.notAvailable],
    [404, 'unknown', T.errors.notAvailable],
    [401, 'unauthenticated', T.errors.unauthenticated],
  ] as const)('削除が %i %s なら、進んでいる GET を捨て、/me を待つ間も行と案内を隠す', async (status, error, message) => {
    await shown();
    const refresh = deferred<void>();
    siwe.refreshSession.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.confirmDelete }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(0, { ok: false, status, error });
    expectCleared();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(siwe.refreshSession).toHaveBeenCalledTimes(1);
    // 進んでいた「もっと見る」は取り消され、後から届いても入れない。
    expect(pages[1].signal?.aborted).toBe(true);
    await resolvePage(1, { ok: true, images: [item(9)], nextCursor: null });
    // その前に始めたもう 1 つの削除が後から 204 で届いても、読み直さない (前の本人の一覧を出し直さない)。
    await resolveDelete(1, { ok: true });
    expectCleared();
    expect(client.fetchImageLibraryPage).toHaveBeenCalledTimes(2);
    expect(siwe.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: T.retry })).toBeDisabled();
    await act(async () => refresh.resolve());
    expect(screen.getByRole('button', { name: T.retry })).toBeEnabled();
  });

  it('失った後に「もう一度読み込む」で読み直せる (本人が戻っていれば一覧が出る)', async () => {
    await shown();
    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    await resolvePage(1, { ok: false, status: 401, error: 'session_mismatch' });
    fireEvent.click(screen.getByRole('button', { name: T.retry }));
    await resolvePage(2, { ok: true, images: [item(3)], nextCursor: null });
    expect(rowFor(3)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(intro)).toBeInTheDocument();
  });
});

describe('ImageLibrary: 409 の使っている所を古い GET で上書きしない (レビュー 1 回目 MUST 5)', () => {
  it('409 より後の「もっと見る」は既存の行を元の位置で更新し、使用なしになれば警告を消す', async () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [item(1), item(2), item(3)], nextCursor: 'c:24' });
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(0, { ok: false, status: 409, error: 'image_in_use', usedIn: [{ kind: 'profile', handle: 'demo', field: 'avatar' }] });
    expect(within(rowFor(2)).getByRole('alert')).toHaveTextContent(T.errors.inUse);
    expect(rowFor(2)).toHaveTextContent('@demo のアバター');

    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    await resolvePage(1, { ok: true, images: [item(4), item(2)], nextCursor: null });
    expect(rowFor(2)).toHaveTextContent(T.notUsed);
    expect(within(rowFor(2)).queryByRole('alert')).not.toBeInTheDocument();
    expect(rows()).toEqual([rowFor(1), rowFor(2), rowFor(3), rowFor(4)]);
  });

  it('A の 204 → 読み直しの開始 → B の 409 → その GET が届く順でも、B は 409 の使っている所のまま。後から始まった GET の値は使う', async () => {
    signIn(A);
    renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [item(1), item(2), item(3)], nextCursor: null });
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.confirmDelete }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.confirmDelete }));

    await resolveDelete(0, { ok: true });
    expect(pages[1]).toMatchObject({ cursor: null });
    await resolveDelete(1, { ok: false, error: 'image_in_use', usedIn: [{ kind: 'profile', handle: 'demo', field: 'avatar' }] });
    expect(rowFor(2)).toHaveTextContent('@demo のアバター');

    // 409 より前に始まった GET (B の使っている所はまだ空) が届く。
    await resolvePage(1, { ok: true, images: [item(3), item(4), item(2)], nextCursor: null });
    expect(rowFor(2)).toHaveTextContent('@demo のアバター');
    expect(rowFor(2)).not.toHaveTextContent(T.notUsed);
    expect(within(rowFor(2)).getByRole('alert')).toHaveTextContent(T.errors.inUse);
    expect(rows()).toEqual([rowFor(2), rowFor(3), rowFor(4)]);

    // 409 より後に始まった GET の値は使う (ほかのタブで外した後)。
    fireEvent.click(within(rowFor(3)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(3)).getByRole('button', { name: T.confirmDelete }));
    await resolveDelete(2, { ok: true });
    await resolvePage(2, { ok: true, images: [item(2)], nextCursor: null });
    expect(rowFor(2)).toHaveTextContent(T.notUsed);
    expect(rowFor(2)).not.toHaveTextContent('@demo のアバター');
    expect(within(rowFor(2)).queryByRole('alert')).not.toBeInTheDocument();
    expect(rows()).toEqual([rowFor(2)]);
  });
});

describe('ImageLibrary: ウォレットの切り替え', () => {
  it('前のウォレットのサムネ・確認・失敗の文を残さず、新しいウォレットで読み直す。前の応答は入れない', async () => {
    signIn(A);
    const { rerender } = renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [item(1), item(2)], nextCursor: 'c:24' });
    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.delete }));
    fireEvent.click(within(rowFor(2)).getByRole('button', { name: T.confirmDelete }));
    fireEvent.click(within(rowFor(1)).getByRole('button', { name: T.delete }));
    expect(within(rowFor(1)).getByRole('group')).toBeInTheDocument();

    signIn(B);
    rerender(<ImageLibrary />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(pages.at(-1)).toMatchObject({ wallet: B, cursor: null });
    // A の「もっと見る」と削除が後から届いても、B の画面に入れず、A で読み直さない。
    await resolvePage(1, { ok: true, images: [item(9)], nextCursor: null });
    await resolveDelete(0, { ok: true });
    expect(document.querySelector('img')).toBeNull();
    expect(client.fetchImageLibraryPage.mock.calls.filter(([wallet]) => wallet === A)).toHaveLength(2);
    await resolvePage(pages.length - 1, { ok: true, images: [item(5)], nextCursor: null });
    expect(rowFor(5)).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
  });

  it('サインインが外れたら一覧を外す', async () => {
    signIn(A);
    const { rerender } = renderWithIntl(<ImageLibrary />);
    await resolvePage(0, { ok: true, images: [item(1)], nextCursor: null });
    siwe.isSignedIn = false;
    siwe.imageUpload = false;
    rerender(<ImageLibrary />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: T.signIn })).toBeInTheDocument();
  });
});
