// @vitest-environment node
// アップロードした画像の一覧 (GET /api/images) と削除 (POST /api/images/delete)。Blob と KV は mock (Blob は小さな偽の store、
// KV は key → 値の表)。使っている所は本物の lib/images/usage (本物の parser) が、偽の KV から読む。
// 検査の順 (段階 → 同じ origin (削除) → 画面のウォレットの形 → IP → セッション → 本人の照合 → 運営者 → 設定 → ウォレットの枠
// → 本体)・本人の prefix の外に届かないこと・使っている所の全部の欄・409 (強制削除なし)・読めないときの 503・15 秒の期限・
// 呼び出しの数・200 枚 → 削除 → アップロードが通ることを固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { createLicenseDefinition } from '@/lib/license/definition';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x2222222222222222222222222222222222222222';
const SECRET = 'test-image-owner-secret-0123456789abcdef';
const BASE = 'https://teststore.public.blob.vercel-storage.com';

const requireSession = vi.hoisted(() => vi.fn());
const readSession = vi.hoisted(() => vi.fn());
const checkIpRateLimit = vi.hoisted(() => vi.fn());
const checkReadRateLimit = vi.hoisted(() => vi.fn());
const hashIpBucket = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
const kv = vi.hoisted(() => ({ isKvConfigured: vi.fn(), kvIncr: vi.fn(), kvLrange: vi.fn(), kvMget: vi.fn() }));
const blob = vi.hoisted(() => {
  class BlobNotFoundError extends Error {
    constructor() {
      super('The requested blob does not exist');
      this.name = 'BlobNotFoundError';
    }
  }
  return { list: vi.fn(), put: vi.fn(), head: vi.fn(), del: vi.fn(), BlobNotFoundError };
});

vi.mock('@/lib/siweSession', () => ({ requireSession, readSession }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIpBucket }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit, checkReadRateLimit }));
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/kv', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/kv')>()), ...kv }));
vi.mock('@vercel/blob', () => blob);

import { GET as listImages, maxDuration as listMaxDuration } from '@/app/api/images/route';
import { POST as deleteImage, maxDuration as deleteMaxDuration } from '@/app/api/images/delete/route';
import { POST as uploadImage } from '@/app/api/images/upload/route';
import { GET as siweMe } from '@/app/api/auth/siwe/me/route';
import { BLOB_LIST_DEADLINE_MS, IMAGE_LIBRARY_DEADLINE_MS } from '@/lib/images/blobStore';
import { imageOwnerKey } from '@/lib/images/ownerKey';

type StoredBlob = { pathname: string; url: string; size: number; uploadedAt: Date };

// 偽の Blob の store (path の辞書順・cursor は「次の位置」)。list・head・del・put を本物の SDK と同じ引数で受ける。
const store = new Map<string, StoredBlob>();
// 偽の KV (LRANGE の list と GET / MGET の文字列)。
const kvData = new Map<string, string | string[]>();

function ownerKey(address = OWNER) {
  return imageOwnerKey(address, SECRET);
}
function imageId(n: number) {
  return `img${String(n).padStart(19, '0')}`;
}
function pathFor(n: number, purpose = 'product', ext = 'jpg', address = OWNER) {
  return `v1/${ownerKey(address)}/${purpose}/${imageId(n)}.${ext}`;
}
function urlFor(pathname: string) {
  return `${BASE}/${pathname}`;
}
function addBlob(pathname: string, size = 1234) {
  store.set(pathname, { pathname, url: urlFor(pathname), size, uploadedAt: new Date(Date.UTC(2026, 10, 19, 3, 4, 5)) });
}

function fakeList({ prefix, limit = 1000, cursor }: { prefix: string; limit?: number; cursor?: string }) {
  const all = [...store.values()].filter((b) => b.pathname.startsWith(prefix)).sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
  const start = cursor ? Number(cursor.slice(2)) : 0;
  const blobs = all.slice(start, start + limit).map((b) => ({ ...b, downloadUrl: `${b.url}?download=1`, etag: 'e' }));
  const next = start + blobs.length;
  return Promise.resolve(next < all.length ? { blobs, hasMore: true, cursor: `c:${next}` } : { blobs, hasMore: false });
}

function handleRecord(owner: string, body: { profile?: unknown; storefront?: unknown }) {
  return JSON.stringify({
    owner,
    config: { to: owner, methods: [{ token: 'JPYC', chain: 'polygon' }] },
    ...body,
    createdAt: 1,
    updatedAt: 2,
  });
}

const PRODUCT_ID = `h_${'a'.repeat(32)}`;
const LICENSE_ID = `h_${'b'.repeat(32)}`;
function productRecord(id: string, owner: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    owner,
    payTo: owner,
    title: '星の写真集',
    priceJpyc: '1200',
    contentKind: 'url',
    label: 'download',
    contentRevision: 1,
    saleActive: true,
    contentAvailable: true,
    createdAt: 1,
    ...extra,
  });
}
/** 販売停止中のライセンス NFT の商品 (NFT の metadata は売れた後も今の表紙を返す)。 */
function pausedLicenseRecord(owner: string, imageUrl: string) {
  const license = createLicenseDefinition(
    LICENSE_ID,
    { supply: 10, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' },
    137,
    '0x3333333333333333333333333333333333333333',
  );
  return productRecord(LICENSE_ID, owner, {
    productKind: 'license',
    license,
    registration: { status: 'registered', attempts: 1, txHash: `0x${'c'.repeat(64)}` },
    contentKind: 'text',
    saleActive: false,
    title: 'ライセンス',
    imageUrl,
  });
}

function headers(extra: Record<string, string> = {}, wallet: string | null = OWNER) {
  return { ...(wallet === null ? {} : { 'x-openpay-wallet': wallet }), ...extra };
}
function get(query = '', extra: Record<string, string> = {}, wallet: string | null = OWNER) {
  return new Request(`https://open-pay.jp/api/images${query}`, { headers: headers(extra, wallet) });
}
function del(body: unknown, extra: Record<string, string> = {}, wallet: string | null = OWNER) {
  return new Request('https://open-pay.jp/api/images/delete', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra }, wallet),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const target = (n: number, purpose = 'product', ext = 'jpg') => ({ purpose, id: imageId(n), ext });

function failures() {
  return logger.warn.mock.calls.map(([event, detail]) => `${event as string}:${(detail as { code: string }).code}`);
}

beforeEach(() => {
  store.clear();
  kvData.clear();
  for (const fn of [requireSession, readSession, checkIpRateLimit, checkReadRateLimit, hashIpBucket, ...Object.values(kv)]) fn.mockReset();
  for (const fn of [blob.list, blob.put, blob.head, blob.del]) fn.mockReset();
  for (const fn of Object.values(logger)) fn.mockReset();
  vi.stubEnv('IMAGE_UPLOAD_MODE', 'admin');
  vi.stubEnv('IMAGE_OWNER_KEY_SECRET', SECRET);
  vi.stubEnv('BLOB_STORE_ID', 'store_test');
  vi.stubEnv('IP_HASH_SECRET', 'test-ip-hash-secret-0123456789abcdef');
  vi.stubEnv('ADMIN_WALLETS', `0x3333333333333333333333333333333333333333, ${OWNER}`);
  requireSession.mockResolvedValue({ ok: true, address: OWNER });
  readSession.mockResolvedValue({ status: 'authenticated', address: OWNER });
  hashIpBucket.mockReturnValue('hashed-ip');
  checkIpRateLimit.mockResolvedValue(true);
  checkReadRateLimit.mockResolvedValue(true);
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
  kv.kvLrange.mockImplementation(async (key: string, start: number, stop: number) => {
    const value = kvData.get(key);
    const list = Array.isArray(value) ? value : [];
    return { ok: true, value: list.slice(start, stop === -1 ? undefined : stop + 1) };
  });
  kv.kvMget.mockImplementation(async (keys: string[]) => {
    if (keys.length === 0) return { ok: true, value: [] };
    return { ok: true, value: keys.map((key) => { const value = kvData.get(key); return typeof value === 'string' ? value : null; }) };
  });
  blob.list.mockImplementation(fakeList);
  blob.head.mockImplementation(async (pathname: string) => {
    const found = store.get(pathname);
    if (!found) throw new blob.BlobNotFoundError();
    return { ...found, downloadUrl: `${found.url}?download=1`, contentType: 'image/jpeg', contentDisposition: '', cacheControl: '', etag: 'e' };
  });
  blob.del.mockImplementation(async (pathname: string) => {
    store.delete(pathname);
  });
  blob.put.mockImplementation(async (pathname: string) => {
    addBlob(pathname);
    return { url: urlFor(pathname), pathname };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

describe('images library: 段階・入口 (一覧と削除で同じ)', () => {
  const routes = [
    ['一覧', () => listImages(get())],
    ['削除', () => deleteImage(del(target(1)))],
  ] as const;

  it.each(routes)('%s: 段階 off・未設定・不正な値は 404 で、セッション・KV・Blob に届かない', async (_label, call) => {
    for (const mode of ['off', undefined, 'yes-please']) {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('IMAGE_UPLOAD_MODE', mode);
      const response = await call();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
      expectPrivate(response);
    }
    expect(requireSession).not.toHaveBeenCalled();
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.head).not.toHaveBeenCalled();
    expect(kv.kvLrange).not.toHaveBeenCalled();
  });

  it('admin の段階で運営者でなければ 403・all なら誰でも使える', async () => {
    requireSession.mockResolvedValue({ ok: true, address: OTHER });
    const forbiddenList = await listImages(get('', {}, OTHER));
    expect(forbiddenList.status).toBe(403);
    expect(await forbiddenList.json()).toEqual({ ok: false, error: 'forbidden' });
    const forbiddenDelete = await deleteImage(del(target(1), {}, OTHER));
    expect(forbiddenDelete.status).toBe(403);
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.head).not.toHaveBeenCalled();
    expect(checkReadRateLimit).not.toHaveBeenCalled();

    vi.stubEnv('IMAGE_UPLOAD_MODE', 'all');
    const allowed = await listImages(get('', {}, OTHER));
    expect(allowed.status).toBe(200);
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: `v1/${ownerKey(OTHER)}/` }));
  });

  it.each(routes)('%s: 未認証は 401・セッションの KV 障害は 503 (どちらも private, no-store + Vary: Cookie)', async (_label, call) => {
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    });
    const unauthenticated = await call();
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expectPrivate(unauthenticated);
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'session_storage_unavailable' }, { status: 503 }),
    });
    const storage = await call();
    expect(storage.status).toBe(503);
    expectPrivate(storage);
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.head).not.toHaveBeenCalled();
    expect(kv.kvLrange).not.toHaveBeenCalled();
  });

  it.each([
    ['一覧', (wallet: string | null) => listImages(get('', {}, wallet))],
    ['削除', (wallet: string | null) => deleteImage(del(target(1), {}, wallet))],
  ] as const)('%s: 画面のウォレットが無い・形が違うと 400 invalid_wallet (KV を読まない)・cookie の本人と違えば 401 session_mismatch', async (_label, call) => {
    for (const wallet of [null, '', 'not-an-address', `${OWNER}00`]) {
      const response = await call(wallet);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: 'invalid_wallet' });
      expectPrivate(response);
    }
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(requireSession).not.toHaveBeenCalled();

    const mismatch = await call(OTHER);
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toEqual({ ok: false, error: 'session_mismatch' });
    expectPrivate(mismatch);
    // 大文字・小文字の違いは同じ本人。
    expect((await call(OWNER.toLowerCase())).status).not.toBe(401);
    expect(blob.list.mock.calls.length + blob.head.mock.calls.length).toBe(1);
  });

  it.each(routes)('%s: IP の bucket が作れなければ 503 not_configured (セッションを読まない)', async (_label, call) => {
    hashIpBucket.mockReturnValue(null);
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'not_configured' });
    expect(requireSession).not.toHaveBeenCalled();
  });

  it.each([
    ['秘密が無い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', '')],
    ['秘密が短い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', 'x'.repeat(31))],
    ['Blob の store が無い', () => vi.stubEnv('BLOB_STORE_ID', ' ')],
  ])('%s なら 503 not_configured (Blob と KV の使っている所を読まない)', async (_label, setup) => {
    setup();
    for (const response of [await listImages(get()), await deleteImage(del(target(1)))]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: 'not_configured' });
    }
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.head).not.toHaveBeenCalled();
    expect(kv.kvLrange).not.toHaveBeenCalled();
  });

  it('枠: 一覧は IP 60 / ウォレット 30 (分)・削除は IP 20 / ウォレット 10 (分)。IP は認証の前・ウォレットは後', async () => {
    addBlob(pathFor(1));
    await listImages(get());
    expect(checkIpRateLimit).toHaveBeenCalledWith('images-list', 'hashed-ip', 60, 60);
    expect(checkReadRateLimit).toHaveBeenCalledWith(`images:list:wallet:${OWNER.toLowerCase()}`, 30, 60);
    await deleteImage(del(target(1)));
    expect(checkIpRateLimit).toHaveBeenCalledWith('images-delete', 'hashed-ip', 20, 60);
    expect(checkReadRateLimit).toHaveBeenCalledWith(`images:delete:wallet:${OWNER.toLowerCase()}`, 10, 60);
  });

  it.each(routes)('%s: IP の枠を超えたら 429 + Retry-After 60 (セッションを読まない)', async (_label, call) => {
    checkIpRateLimit.mockResolvedValue(false);
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 60 });
    expectPrivate(response);
    expect(requireSession).not.toHaveBeenCalled();
  });

  it.each(routes)('%s: ウォレットの枠を超えたら 429 + 次の分までの Retry-After (Blob に触れない)', async (_label, call) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 19, 12, 0, 45)));
    checkReadRateLimit.mockResolvedValue(false);
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('15');
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.head).not.toHaveBeenCalled();
  });
});

describe('images library: 一覧 (GET /api/images)', () => {
  it('本人の prefix だけを 24 件ずつ読み、行に id・拡張子・用途・URL・大きさ・UTC の日時・使っている所を付ける', async () => {
    addBlob(pathFor(1, 'avatar', 'png'), 2048);
    addBlob(pathFor(2));
    addBlob(pathFor(3, 'product', 'jpg', OTHER));
    const response = await listImages(get());
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(blob.list).toHaveBeenCalledTimes(1);
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: `v1/${ownerKey()}/`, limit: 24, cursor: undefined }));
    expect(await response.json()).toEqual({
      ok: true,
      images: [
        { id: imageId(1), ext: 'png', purpose: 'avatar', url: urlFor(pathFor(1, 'avatar', 'png')), size: 2048, uploadedAt: '2026-11-19T03:04:05.000Z', usedIn: [] },
        { id: imageId(2), ext: 'jpg', purpose: 'product', url: urlFor(pathFor(2)), size: 1234, uploadedAt: '2026-11-19T03:04:05.000Z', usedIn: [] },
      ],
      nextCursor: null,
    });
  });

  it('画像が無ければ空 (使っている所の KV を読まない)', async () => {
    const response = await listImages(get());
    expect(await response.json()).toEqual({ ok: true, images: [], nextCursor: null });
    expect(kv.kvLrange).not.toHaveBeenCalled();
    expect(kv.kvMget).not.toHaveBeenCalled();
  });

  it('続きは SDK の cursor をそのまま返し、受けた cursor を本人の prefix の list にそのまま渡す', async () => {
    for (let n = 1; n <= 30; n += 1) addBlob(pathFor(n));
    const first = await (await listImages(get())).json();
    expect(first.images).toHaveLength(24);
    expect(first.nextCursor).toBe('c:24');
    const second = await (await listImages(get(`?cursor=${encodeURIComponent(first.nextCursor)}`))).json();
    expect(blob.list).toHaveBeenLastCalledWith(expect.objectContaining({ prefix: `v1/${ownerKey()}/`, limit: 24, cursor: 'c:24' }));
    expect(second.images.map((item: { id: string }) => item.id)).toEqual([25, 26, 27, 28, 29, 30].map(imageId));
    expect(second.nextCursor).toBeNull();
  });

  it('cursor を差し替えても他人の path・規定の形でない path は返らない (返ってきた path を本人の prefix と形で照合する)', async () => {
    const mine = pathFor(1);
    blob.list.mockResolvedValueOnce({
      blobs: [
        mine,
        pathFor(2, 'product', 'jpg', OTHER),
        `v1/${ownerKey()}/unknown/${imageId(3)}.jpg`,
        `v1/${ownerKey()}/product/${imageId(4)}.gif`,
        `v1/${ownerKey()}/product/short.jpg`,
        `v1/${ownerKey()}/product/x/${imageId(5)}.jpg`,
        `v1/${ownerKey()}/product/${imageId(6)}`,
        `v1/${ownerKey()}x/product/${imageId(7)}.jpg`,
        `v2/${ownerKey()}/product/${imageId(8)}.jpg`,
      ].map((pathname) => ({ pathname, url: urlFor(pathname), size: 1, uploadedAt: new Date(0) })),
      hasMore: false,
    });
    const response = await listImages(get('?cursor=someone-elses-cursor'));
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: `v1/${ownerKey()}/`, cursor: 'someone-elses-cursor' }));
    const body = await response.json();
    expect(body.images.map((item: { url: string }) => item.url)).toEqual([urlFor(mine)]);
  });

  it.each([
    ['長すぎる', `?cursor=${'a'.repeat(1025)}`],
    ['空', '?cursor='],
    ['空白', '?cursor=a%20b'],
    ['制御文字', '?cursor=a%0Ab'],
    ['ASCII の外', `?cursor=${encodeURIComponent('あ')}`],
    ['2 つ', '?cursor=a&cursor=b'],
  ])('cursor の形が不正 (%s) なら 400 invalid_cursor で Blob に送らない', async (_label, query) => {
    const response = await listImages(get(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_cursor' });
    expect(blob.list).not.toHaveBeenCalled();
  });

  it('1024 文字の cursor は通す', async () => {
    const response = await listImages(get(`?cursor=${'a'.repeat(1024)}`));
    expect(response.status).toBe(200);
  });

  it('短い中間のページ (24 件より少ない・続きあり) でも hasMore に従って nextCursor を返す', async () => {
    addBlob(pathFor(1));
    blob.list.mockResolvedValueOnce({
      blobs: [{ pathname: pathFor(1), url: urlFor(pathFor(1)), size: 1, uploadedAt: new Date(0) }],
      hasMore: true,
      cursor: 'next-page',
    });
    const body = await (await listImages(get())).json();
    expect(body.images).toHaveLength(1);
    expect(body.nextCursor).toBe('next-page');
  });

  it.each([
    ['cursor が無い', undefined, undefined],
    ['前と同じ cursor (同じページを読み続ける)', 'same', '?cursor=same'],
    ['形の違う cursor', 'has space', undefined],
  ])('続きがあるのに %s なら 503 (続きを返せない)', async (_label, cursor, query) => {
    blob.list.mockResolvedValueOnce({ blobs: [], hasMore: true, ...(cursor ? { cursor } : {}) });
    const response = await listImages(get(query ?? ''));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(failures()).toEqual(['images.list.failed:list_cursor_invalid']);
  });

  it('list の失敗は 503 で、ログは固定の code だけ (SDK の文・path・アドレスを出さない)', async () => {
    blob.list.mockRejectedValueOnce(new Error(`boom ${pathFor(1)} ${OWNER}`));
    const response = await listImages(get());
    expect(response.status).toBe(503);
    expect(failures()).toEqual(['images.list.failed:list_failed']);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(ownerKey());
    expect(logged).not.toContain(OWNER.toLowerCase().slice(2));
  });

  it('list の締切 (5 秒) は 503 list_deadline で、SDK の signal は AbortError で止まる', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let signal: AbortSignal | undefined;
    blob.list.mockImplementation((options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    });
    let response: Response | undefined;
    void listImages(get()).then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(BLOB_LIST_DEADLINE_MS);
    expect(response?.status).toBe(503);
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(failures()).toEqual(['images.list.failed:list_deadline']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('images library: 使っている所 (本人の handle と Store の商品)', () => {
  function seedAllReferences() {
    // 1: プロフのアバター (query と fragment つきで保存) / 2: プロフのカバー / 3: リンクの画像 / 4: 店舗のアイコン /
    // 5: 店舗のカバー / 6: メニューの画像 / 7: 商品の表紙 / 8: 商品の追加画像 / 9: 販売停止のライセンスの商品の表紙 /
    // 10: どこにも使っていない / 11: 別の origin で同じ path / 12: 他人の記録 (古い index) / 13: id の違う商品の記録
    for (let n = 1; n <= 13; n += 1) addBlob(pathFor(n));
    kvData.set(`wallet:handles:${OWNER.toLowerCase()}`, ['shop', 'stale']);
    kvData.set('handle:shop', handleRecord(OWNER, {
      profile: {
        avatar: `${urlFor(pathFor(1))}?v=2#top`,
        cover: urlFor(pathFor(2)),
        links: [
          { kind: 'heading', label: '見出し' },
          { label: 'ブログ', url: 'https://blog.example', imageUrl: urlFor(pathFor(3)) },
          { label: '同じ画像', url: 'https://blog.example/2', imageUrl: urlFor(pathFor(3)) },
        ],
      },
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        avatar: urlFor(pathFor(4)),
        cover: urlFor(pathFor(5)),
        menu: [
          { id: 'm1', name: 'コーヒー', price: '500', visual: { kind: 'image', url: urlFor(pathFor(6)) } },
          { id: 'm2', name: 'ケーキ', price: '600', visual: { kind: 'emoji', value: '🍰' } },
          { id: 'm3', name: '他所の画像', price: '700', visual: { kind: 'image', url: `https://other.example/${pathFor(11)}` } },
        ],
      },
    }));
    kvData.set('handle:stale', handleRecord(OTHER, { profile: { avatar: urlFor(pathFor(12)) } }));
    kvData.set(`x402:hosted:owner:${OWNER.toLowerCase()}`, [PRODUCT_ID, LICENSE_ID, `h_${'d'.repeat(32)}`, 'not-a-hosted-id']);
    kvData.set(`x402:hosted:${PRODUCT_ID}`, productRecord(PRODUCT_ID, OWNER, {
      imageUrl: urlFor(pathFor(7)),
      galleryUrls: [urlFor(pathFor(8)), urlFor(pathFor(7))],
    }));
    kvData.set(`x402:hosted:${LICENSE_ID}`, pausedLicenseRecord(OWNER, urlFor(pathFor(9))));
    kvData.set(`x402:hosted:h_${'d'.repeat(32)}`, productRecord(`h_${'e'.repeat(32)}`, OWNER, { imageUrl: urlFor(pathFor(13)) }));
  }

  it('全部の欄を見つける (プロフ・店舗・商品の表紙と追加画像・販売停止のライセンスの商品)。他人の記録・別の origin・id の違う記録は数えない', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_LICENSE_NFT', '');
    seedAllReferences();
    const body = await (await listImages(get())).json();
    const byId = Object.fromEntries(body.images.map((item: { id: string; usedIn: unknown[] }) => [item.id, item.usedIn]));
    expect(byId[imageId(1)]).toEqual([{ kind: 'profile', handle: 'shop', field: 'avatar' }]);
    expect(byId[imageId(2)]).toEqual([{ kind: 'profile', handle: 'shop', field: 'cover' }]);
    expect(byId[imageId(3)]).toEqual([{ kind: 'profile', handle: 'shop', field: 'link' }]);
    expect(byId[imageId(4)]).toEqual([{ kind: 'storefront', handle: 'shop', field: 'avatar' }]);
    expect(byId[imageId(5)]).toEqual([{ kind: 'storefront', handle: 'shop', field: 'cover' }]);
    expect(byId[imageId(6)]).toEqual([{ kind: 'storefront', handle: 'shop', field: 'menu' }]);
    expect(byId[imageId(7)]).toEqual([
      { kind: 'product', id: PRODUCT_ID, title: '星の写真集', field: 'cover' },
      { kind: 'product', id: PRODUCT_ID, title: '星の写真集', field: 'gallery' },
    ]);
    expect(byId[imageId(8)]).toEqual([{ kind: 'product', id: PRODUCT_ID, title: '星の写真集', field: 'gallery' }]);
    expect(byId[imageId(9)]).toEqual([{ kind: 'product', id: LICENSE_ID, title: 'ライセンス', field: 'cover' }]);
    for (const n of [10, 11, 12, 13]) expect(byId[imageId(n)]).toEqual([]);
  });

  it('1 回の一覧で KV は LRANGE 2 + MGET 2 (種類ごとに 1 回)・Blob は list 1 回', async () => {
    seedAllReferences();
    await listImages(get());
    expect(kv.kvLrange).toHaveBeenCalledTimes(2);
    expect(kv.kvLrange).toHaveBeenCalledWith(`wallet:handles:${OWNER.toLowerCase()}`, 0, -1);
    expect(kv.kvLrange).toHaveBeenCalledWith(`x402:hosted:owner:${OWNER.toLowerCase()}`, 0, 23);
    expect(kv.kvMget).toHaveBeenCalledTimes(2);
    expect(kv.kvMget).toHaveBeenCalledWith(['handle:shop', 'handle:stale']);
    expect(kv.kvMget).toHaveBeenCalledWith([`x402:hosted:${PRODUCT_ID}`, `x402:hosted:${LICENSE_ID}`, `x402:hosted:h_${'d'.repeat(32)}`]);
    expect(blob.list).toHaveBeenCalledTimes(1);
    expect(blob.head).not.toHaveBeenCalled();
  });

  it.each([
    ['handle の index', () => kv.kvLrange.mockResolvedValueOnce({ ok: false, reason: 'timeout' })],
    ['商品の index', () => kv.kvLrange.mockImplementationOnce(async () => ({ ok: true, value: ['shop'] })).mockResolvedValueOnce({ ok: false, reason: 'network_error' })],
    ['記録の MGET', () => kv.kvMget.mockResolvedValueOnce({ ok: false, reason: 'http_error' })],
  ])('%s が読めなければ 503 (使っていないと言わない)', async (_label, setup) => {
    seedAllReferences();
    setup();
    const response = await listImages(get());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(failures()).toEqual(['images.list.failed:usage_unavailable']);
  });
});

describe('images library: 削除 (POST /api/images/delete)', () => {
  it.each([
    ['cross-site', { 'sec-fetch-site': 'cross-site' }, 403, 'cross_site_request'],
    ['same-site (サブドメイン)', { 'sec-fetch-site': 'same-site' }, 403, 'cross_site_request'],
    ['JSON でない本文', { 'content-type': 'text/plain' }, 415, 'unsupported_media_type'],
  ])('%s は断り、セッションも本文も読まない', async (_label, extra, status, error) => {
    const req = del(target(1), extra);
    const response = await deleteImage(req);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error });
    expectPrivate(response);
    expect(req.bodyUsed).toBe(false);
    expect(requireSession).not.toHaveBeenCalled();
    expect(checkIpRateLimit).not.toHaveBeenCalled();
  });

  it('本人の照合で断ったら本文を読まない', async () => {
    const req = del(target(1), {}, OTHER);
    expect((await deleteImage(req)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });

  it.each([
    ['1 KiB を超える', JSON.stringify({ ...target(1), pad: 'x'.repeat(1100) }), 413, 'payload_too_large'],
    ['JSON でない', '{', 400, 'invalid_body'],
    ['object でない', '[]', 400, 'invalid_body'],
    ['url を足した', { ...target(1), url: urlFor(pathFor(1)) }, 400, 'invalid_body'],
    ['項目が足りない', { purpose: 'product', id: imageId(1) }, 400, 'invalid_body'],
    ['用途が不正', target(1, 'unknown'), 400, 'invalid_body'],
    ['拡張子が不正', target(1, 'product', 'gif'), 400, 'invalid_body'],
    ['id が段を越える', { purpose: 'product', id: '../../v1/other/x', ext: 'jpg' }, 400, 'invalid_body'],
    ['id の長さが違う', { purpose: 'product', id: 'a'.repeat(21), ext: 'jpg' }, 400, 'invalid_body'],
    ['id に / を含む', { purpose: 'product', id: `${'a'.repeat(10)}/${'b'.repeat(11)}`, ext: 'jpg' }, 400, 'invalid_body'],
  ])('本文が %s なら断る (Blob に触れない)', async (_label, body, status, error) => {
    const response = await deleteImage(del(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error });
    expect(blob.head).not.toHaveBeenCalled();
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('path は server が SIWE の本人の ownerKey から組む (head → 使っている所 → del → 204)', async () => {
    addBlob(pathFor(1, 'link', 'png'));
    const response = await deleteImage(del(target(1, 'link', 'png')));
    expect(response.status).toBe(204);
    expectPrivate(response);
    expect(blob.head).toHaveBeenCalledWith(pathFor(1, 'link', 'png'), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(blob.del).toHaveBeenCalledWith(pathFor(1, 'link', 'png'), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(store.has(pathFor(1, 'link', 'png'))).toBe(false);
    // 1 回の削除で KV (使っている所) は LRANGE 2 (記録が無いので MGET は 0)・Blob は head 1 + del 1。
    expect(kv.kvLrange).toHaveBeenCalledTimes(2);
    expect(kv.kvMget).toHaveBeenCalledTimes(2);
    expect(blob.head).toHaveBeenCalledTimes(1);
    expect(blob.del).toHaveBeenCalledTimes(1);
  });

  it('他人の画像と同じ id を送っても、本人の prefix の外には届かない (他人の画像は残り、204)', async () => {
    addBlob(pathFor(1, 'product', 'jpg', OTHER));
    const response = await deleteImage(del(target(1)));
    expect(response.status).toBe(204);
    expect(blob.head).toHaveBeenCalledWith(pathFor(1), expect.anything());
    expect(blob.del).not.toHaveBeenCalled();
    expect(store.has(pathFor(1, 'product', 'jpg', OTHER))).toBe(true);
  });

  it('無い画像 (もう消えた・二重の削除) は 204 で、使っている所を読まず del も送らない', async () => {
    addBlob(pathFor(1));
    expect((await deleteImage(del(target(1)))).status).toBe(204);
    expect(blob.del).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    const again = await deleteImage(del(target(1)));
    expect(again.status).toBe(204);
    expect(kv.kvLrange).not.toHaveBeenCalled();
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('使っていれば 409 image_in_use と使っている所を返し、消さない (強制削除はない)', async () => {
    addBlob(pathFor(9));
    kvData.set(`x402:hosted:owner:${OWNER.toLowerCase()}`, [LICENSE_ID]);
    kvData.set(`x402:hosted:${LICENSE_ID}`, pausedLicenseRecord(OWNER, urlFor(pathFor(9))));
    const response = await deleteImage(del(target(9)));
    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'image_in_use',
      usedIn: [{ kind: 'product', id: LICENSE_ID, title: 'ライセンス', field: 'cover' }],
    });
    expect(blob.del).not.toHaveBeenCalled();
    expect(store.has(pathFor(9))).toBe(true);
  });

  it('用途をまたいで使っていても見つける (商品の画像をプロフのアバターに使った)', async () => {
    addBlob(pathFor(1, 'product'));
    kvData.set(`wallet:handles:${OWNER.toLowerCase()}`, ['me']);
    kvData.set('handle:me', handleRecord(OWNER, { profile: { avatar: urlFor(pathFor(1, 'product')) } }));
    const response = await deleteImage(del(target(1, 'product')));
    expect(response.status).toBe(409);
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('使っている所が読めなければ 503 で消さない', async () => {
    addBlob(pathFor(1));
    kv.kvLrange.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const response = await deleteImage(del(target(1)));
    expect(response.status).toBe(503);
    expect(blob.del).not.toHaveBeenCalled();
    expect(failures()).toEqual(['images.delete.failed:usage_unavailable']);
  });

  it.each([
    ['head の失敗', () => blob.head.mockRejectedValueOnce(new Error('head boom')), 'head_failed', false],
    ['del の失敗', () => blob.del.mockRejectedValueOnce(new Error('del boom')), 'delete_failed', true],
  ])('%s は 503 (ログは固定の code)', async (_label, setup, code, deleteCalled) => {
    addBlob(pathFor(1));
    setup();
    const response = await deleteImage(del(target(1)));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(failures()).toEqual([`images.delete.failed:${code}`]);
    expect(blob.del).toHaveBeenCalledTimes(deleteCalled ? 1 : 0);
  });

  it('del が BlobNotFoundError (head と del の間に消えた) でも 204', async () => {
    addBlob(pathFor(1));
    blob.del.mockRejectedValueOnce(new blob.BlobNotFoundError());
    expect((await deleteImage(del(target(1)))).status).toBe(204);
  });
});

describe('images library: 絶対の期限 (15 秒・関数の上限より前)', () => {
  const never = () => new Promise<never>(() => {});

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('期限は関数の上限 (maxDuration) の 5 秒以上前', () => {
    expect(listMaxDuration * 1000 - IMAGE_LIBRARY_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    expect(deleteMaxDuration * 1000 - IMAGE_LIBRARY_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it.each([
    ['一覧', () => listImages(get()), 'images.list.failed'],
    ['削除', () => deleteImage(del(target(1))), 'images.delete.failed'],
  ] as const)('%s: セッション (KV) が応答しなくても、開始から 15 秒で 503 storage_unavailable', async (_label, call, event) => {
    requireSession.mockImplementation(never);
    let response: Response | undefined;
    void call().then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(IMAGE_LIBRARY_DEADLINE_MS - 1);
    expect(response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expectPrivate(response as Response);
    expect(failures()).toEqual([`${event}:route_deadline`]);
  });

  it('一覧: 前段 (ウォレットの枠の KV) で 12 秒を使った後に list が応答しなければ、開始から 15 秒で 503 (list の 5 秒を待たない)', async () => {
    checkReadRateLimit.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(true), 12_000)));
    let signal: AbortSignal | undefined;
    blob.list.mockImplementation((options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return never();
    });
    let response: Response | undefined;
    void listImages(get()).then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(IMAGE_LIBRARY_DEADLINE_MS - 1);
    expect(blob.list).toHaveBeenCalledTimes(1);
    expect(response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(response?.status).toBe(503);
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(failures()).toEqual(['images.list.failed:route_deadline', 'images.list.failed:list_deadline']);
    expect(kv.kvLrange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('削除: 本文が届ききらなくても 15 秒で 503 で、期限の後に Blob に触れない', async () => {
    addBlob(pathFor(1));
    const req = new Request('https://open-pay.jp/api/images/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-openpay-wallet': OWNER },
      // 先頭だけ届いて、続きも終わりも来ない本文。
      body: new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode('{"purpose":')) }),
      duplex: 'half',
    } as RequestInit);
    let response: Response | undefined;
    void deleteImage(req).then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(IMAGE_LIBRARY_DEADLINE_MS);
    expect(response?.status).toBe(503);
    expect(failures()).toEqual(['images.delete.failed:route_deadline']);
    expect(blob.head).not.toHaveBeenCalled();
    expect(blob.del).not.toHaveBeenCalled();
  });

  it('削除: 使っている所の読み取りが期限の後に返っても del を始めない', async () => {
    addBlob(pathFor(1));
    kv.kvLrange.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: [] }), IMAGE_LIBRARY_DEADLINE_MS + 1_000)),
    );
    let response: Response | undefined;
    void deleteImage(del(target(1))).then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(IMAGE_LIBRARY_DEADLINE_MS);
    expect(response?.status).toBe(503);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blob.del).not.toHaveBeenCalled();
    expect(store.has(pathFor(1))).toBe(true);
    expect(failures()).toEqual(['images.delete.failed:route_deadline']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('一覧: list の途中で期限が来たら、list が後から返っても使っている所を読まない', async () => {
    addBlob(pathFor(1));
    checkReadRateLimit.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(true), 12_000)));
    blob.list.mockImplementation(
      (options: { prefix: string }) =>
        new Promise((resolve) => setTimeout(() => resolve(fakeList(options)), 4_000)),
    );
    let response: Response | undefined;
    void listImages(get()).then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(IMAGE_LIBRARY_DEADLINE_MS);
    expect(response?.status).toBe(503);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kv.kvLrange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('images library: 200 枚 → 削除 → アップロードが通る', () => {
  function upload() {
    const bytes = new Uint8Array(2048);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return uploadImage(new Request('https://open-pay.jp/api/images/upload?purpose=product', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'sec-fetch-site': 'same-origin' },
      body: bytes,
    }));
  }

  it('上限 200 枚で 409 image_limit → 一覧から 1 枚消す → もう一度のアップロードは 200', async () => {
    for (let n = 1; n <= 200; n += 1) addBlob(pathFor(n));
    const full = await upload();
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ ok: false, error: 'image_limit' });

    const page = await (await listImages(get())).json();
    const first = page.images[0];
    expect((await deleteImage(del({ purpose: first.purpose, id: first.id, ext: first.ext }))).status).toBe(204);
    expect(store.size).toBe(199);

    const again = await upload();
    expect(again.status).toBe(200);
    expect(store.size).toBe(200);
  });
});

describe('/api/auth/siwe/me の画像の 2 つの値 (env だけ・true のときだけ足す)', () => {
  async function me() {
    const response = await siweMe();
    return response.json();
  }

  it('段階 off・未設定では今と同じ形 (足さない)', async () => {
    for (const mode of ['off', undefined]) {
      vi.stubEnv('IMAGE_UPLOAD_MODE', mode);
      expect(await me()).toEqual({ ok: true, address: OWNER });
    }
  });

  it('admin: 運営者は imageUpload と imageUploadSignIn・運営者でない本人と未サインインは imageUploadSignIn だけ', async () => {
    expect(await me()).toEqual({ ok: true, address: OWNER, imageUpload: true, imageUploadSignIn: true });
    readSession.mockResolvedValue({ status: 'authenticated', address: OTHER });
    expect(await me()).toEqual({ ok: true, address: OTHER, imageUploadSignIn: true });
    readSession.mockResolvedValue({ status: 'missing' });
    expect(await me()).toEqual({ ok: true, address: null, imageUploadSignIn: true });
  });

  it('all: サインインした誰でも imageUpload', async () => {
    vi.stubEnv('IMAGE_UPLOAD_MODE', 'all');
    readSession.mockResolvedValue({ status: 'authenticated', address: OTHER });
    expect(await me()).toEqual({ ok: true, address: OTHER, imageUpload: true, imageUploadSignIn: true });
  });

  it.each([
    ['秘密が無い', 'IMAGE_OWNER_KEY_SECRET'],
    ['Blob の store が無い', 'BLOB_STORE_ID'],
    ['IP の枠の秘密が無い', 'IP_HASH_SECRET'],
  ])('%s ときはどちらも足さない (サインインの導線も出さない)', async (_label, key) => {
    vi.stubEnv(key, '');
    expect(await me()).toEqual({ ok: true, address: OWNER });
  });

  it('KV と Blob に触れない (セッションの読み取りだけ)', async () => {
    await me();
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(kv.kvLrange).not.toHaveBeenCalled();
    expect(blob.list).not.toHaveBeenCalled();
  });
});
