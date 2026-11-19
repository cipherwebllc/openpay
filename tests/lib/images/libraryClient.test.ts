// アップロードした画像の一覧と削除のブラウザ側 (lib/images/libraryClient)。fetch は mock。
// 今つないでいるウォレットを header で送る・削除の本文は {purpose,id,ext} だけ・204 は消えた・409 は使っている所を返す・
// 本文の形が違えば unknown・通信の失敗は network (例外を投げない)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteLibraryImage, fetchImageLibraryPage } from '@/lib/images/libraryClient';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ITEM = {
  id: 'img0000000000000000001',
  ext: 'jpg',
  purpose: 'product',
  url: 'https://s.public.blob.vercel-storage.com/v1/k/product/img0000000000000000001.jpg',
  size: 10,
  uploadedAt: '2026-11-19T03:04:05.000Z',
  usedIn: [{ kind: 'profile', handle: 'shop', field: 'avatar' }],
};

const fetchMock = vi.fn();

function reply(status: number, body?: unknown) {
  return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchImageLibraryPage', () => {
  it('最初のページは cursor なし・続きは cursor を URL に入れ、どちらもウォレットを header で送る (no-store)', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, images: [ITEM], nextCursor: 'c:24' }));
    const signal = new AbortController().signal;
    expect(await fetchImageLibraryPage(WALLET, null, signal)).toEqual({ ok: true, images: [ITEM], nextCursor: 'c:24' });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/images', { headers: { 'x-openpay-wallet': WALLET }, cache: 'no-store', signal });
    await fetchImageLibraryPage(WALLET, 'a b/+', signal);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/images?cursor=a%20b%2F%2B');
  });

  it.each([
    ['images が配列でない', { ok: true, images: null, nextCursor: null }],
    ['行の形が違う (url が https でない)', { ok: true, images: [{ ...ITEM, url: 'javascript:alert(1)' }], nextCursor: null }],
    ['行の日時が読めない', { ok: true, images: [{ ...ITEM, uploadedAt: 'not a date' }], nextCursor: null }],
    ['使っている所の形が違う', { ok: true, images: [{ ...ITEM, usedIn: [{ kind: 'profile', handle: 1, field: 'avatar' }] }], nextCursor: null }],
    ['nextCursor の形が違う', { ok: true, images: [], nextCursor: 3 }],
  ])('%s なら unknown', async (_label, body) => {
    fetchMock.mockResolvedValue(reply(200, body));
    expect(await fetchImageLibraryPage(WALLET, null)).toMatchObject({ ok: false, error: 'unknown' });
  });

  it.each([
    [401, { ok: false, error: 'session_mismatch' }, 'session_mismatch'],
    [429, { ok: false, error: 'rate_limited', retryAfterSec: 3 }, 'rate_limited'],
    [503, 'gateway timeout (not JSON)', 'storage_unavailable'],
    [404, '', 'not_found'],
    [500, '', 'unknown'],
  ])('失敗 %i は code にする', async (status, body, error) => {
    fetchMock.mockResolvedValue(reply(status, body));
    expect(await fetchImageLibraryPage(WALLET, null)).toMatchObject({ ok: false, error });
  });

  it('通信の失敗は network (例外を投げない)', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await fetchImageLibraryPage(WALLET, null)).toEqual({ ok: false, error: 'network' });
  });
});

describe('deleteLibraryImage', () => {
  const target = { purpose: 'product', id: ITEM.id, ext: 'jpg' } as const;

  it('本文は {purpose,id,ext} だけ・JSON・ウォレットを header で送る。204 は消えた', async () => {
    fetchMock.mockResolvedValue(reply(204));
    expect(await deleteLibraryImage(WALLET, { ...target, url: 'https://x' } as typeof target)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/images/delete');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'x-openpay-wallet': WALLET }, cache: 'no-store' });
    expect(JSON.parse(init.body)).toEqual(target);
  });

  it('409 image_in_use は使っている所を返す', async () => {
    fetchMock.mockResolvedValue(reply(409, { ok: false, error: 'image_in_use', usedIn: ITEM.usedIn }));
    expect(await deleteLibraryImage(WALLET, target)).toMatchObject({ ok: false, error: 'image_in_use', usedIn: ITEM.usedIn });
  });

  it.each([
    [503, { ok: false, error: 'storage_unavailable' }, 'storage_unavailable'],
    [401, { ok: false, error: 'unauthenticated' }, 'unauthenticated'],
    [200, { ok: true }, 'unknown'],
  ])('%i は code にする', async (status, body, error) => {
    fetchMock.mockResolvedValue(reply(status, body));
    expect(await deleteLibraryImage(WALLET, target)).toMatchObject({ ok: false, error });
  });

  it('通信の失敗は network', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await deleteLibraryImage(WALLET, target)).toEqual({ ok: false, error: 'network' });
  });
});

describe('権限の喪失を判定する HTTP status', () => {
  it.each([
    ['一覧', () => fetchImageLibraryPage(WALLET, null)],
    ['削除', () => deleteLibraryImage(WALLET, { purpose: 'product', id: ITEM.id, ext: 'jpg' })],
  ] as const)('%s は本文の code と独立に status を返す', async (_label, request) => {
    fetchMock.mockResolvedValue(reply(403, { ok: false, error: 'cross_site_request' }));
    expect(await request()).toEqual({ ok: false, error: 'cross_site_request', status: 403 });
  });
});
