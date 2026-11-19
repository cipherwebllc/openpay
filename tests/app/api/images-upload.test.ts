// @vitest-environment node
// POST /api/images/upload (画像のアップロード) と、出品者の GET の imageUpload。
// 検査の順 (段階 → 同じ origin → IP の分ごと → セッション → 運営者 → 秘密と Blob → 用途と形式 → ウォレットと IP の 1 日 → 本文
// (1 MiB) → 先頭 byte → 保有の枚数 → 全体の 1 日 (最後・KV 障害で止める) → put)・本文は認証と枠を通るまで読まないこと
// (req.bodyUsed)・put の引数・ログにアドレス・path・URL を出さないことを固定する。Blob は mock (実 API は使わない)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x2222222222222222222222222222222222222222';
const SECRET = 'test-image-owner-secret-0123456789abcdef';
const BLOB_URL_BASE = 'https://teststore.public.blob.vercel-storage.com';
const MiB = 1024 * 1024;
const DAY = 86_400;

const state = vi.hoisted(() => ({ storeEnabled: true }));
const requireSession = vi.hoisted(() => vi.fn());
const checkIpRateLimit = vi.hoisted(() => vi.fn());
const checkReadRateLimit = vi.hoisted(() => vi.fn());
const hashIpBucket = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
const kv = vi.hoisted(() => ({ isKvConfigured: vi.fn(), kvIncr: vi.fn() }));
const blob = vi.hoisted(() => ({ list: vi.fn(), put: vi.fn() }));
const getSellerDisclosure = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableCreatorStore() {
        return state.storeEnabled;
      },
    },
  };
});
vi.mock('@/lib/siweSession', () => ({ requireSession }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIpBucket }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit, checkReadRateLimit }));
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/kv', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/kv')>()), ...kv }));
vi.mock('@vercel/blob', () => blob);
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/hostedStore')>()),
  getSellerDisclosure,
}));

import { POST } from '@/app/api/images/upload/route';
import { GET as getSeller } from '@/app/api/store/seller/route';
import { imageOwnerKey } from '@/lib/images/ownerKey';
import { IMAGE_CACHE_MAX_AGE_SEC } from '@/lib/images/blobStore';
import { imageUploadGlobalDailyKey } from '@/lib/images/dailyCap';

/** 先頭が JPEG / PNG の印の byte 列 (中身は詰め物)。 */
function jpegBytes(size = 2048): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}
function pngBytes(size = 2048): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

type PostOptions = {
  body?: BodyInit | null;
  type?: string | null;
  purpose?: string | null;
  headers?: Record<string, string>;
};

function post({ body = jpegBytes(), type = 'image/jpeg', purpose = 'product', headers = {} }: PostOptions = {}): Request {
  const query = purpose === null ? '' : `?purpose=${purpose}`;
  return new Request(`https://open-pay.jp/api/images/upload${query}`, {
    method: 'POST',
    headers: { ...(type === null ? {} : { 'content-type': type }), 'sec-fetch-site': 'same-origin', ...headers },
    ...(body === null ? {} : { body }),
  });
}

function session(address: string) {
  requireSession.mockResolvedValue({ ok: true, address });
}

function ownerPrefix(address = OWNER) {
  return `v1/${imageOwnerKey(address, SECRET)}/`;
}

/** 本文を読まずに止まり、Blob と全体の枠に届かない。 */
function expectStoppedBeforeBody(req: Request) {
  expect(req.bodyUsed).toBe(false);
  expect(blob.list).not.toHaveBeenCalled();
  expect(blob.put).not.toHaveBeenCalled();
  expect(kv.kvIncr).not.toHaveBeenCalled();
}

beforeEach(() => {
  state.storeEnabled = true;
  vi.stubEnv('IMAGE_UPLOAD_MODE', 'admin');
  vi.stubEnv('IMAGE_OWNER_KEY_SECRET', SECRET);
  vi.stubEnv('BLOB_STORE_ID', 'store_test');
  vi.stubEnv('ADMIN_WALLETS', `0x3333333333333333333333333333333333333333, ${OWNER}`);
  session(OWNER);
  hashIpBucket.mockReturnValue('hashed-ip');
  checkIpRateLimit.mockResolvedValue(true);
  checkReadRateLimit.mockResolvedValue(true);
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
  blob.list.mockResolvedValue({ blobs: [], hasMore: false });
  blob.put.mockImplementation(async (pathname: string) => ({ url: `${BLOB_URL_BASE}/${pathname}`, pathname }));
  getSellerDisclosure.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('images upload: 段階と入口', () => {
  it.each([
    ['未設定', undefined],
    ['off', 'off'],
    ['不正な値', 'yes-please'],
  ])('段階が %s なら 404 で、認証・KV・本文・Blob に届かない (不正な値はログに写さない)', async (_label, mode) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('IMAGE_UPLOAD_MODE', mode);
    const req = post();
    const response = await POST(req);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(requireSession).not.toHaveBeenCalled();
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expectStoppedBeforeBody(req);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('yes-please');
  });

  it.each([
    ['cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['same-site (サブドメイン)', { 'sec-fetch-site': 'same-site' }],
  ])('%s は 403 で、セッションを読まない', async (_label, headers) => {
    const req = post({ headers });
    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'cross_site_request' });
    expect(requireSession).not.toHaveBeenCalled();
    expectStoppedBeforeBody(req);
  });

  it('認証の前に IP の分ごとの制限 (60 回 / 60 秒) を通る。超えたら 429 でセッションを読まない', async () => {
    await POST(post());
    expect(checkIpRateLimit).toHaveBeenCalledWith('images-upload', 'hashed-ip', 60, 60);
    vi.clearAllMocks();
    checkIpRateLimit.mockResolvedValue(false);
    const req = post();
    const response = await POST(req);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(requireSession).not.toHaveBeenCalled();
    expectStoppedBeforeBody(req);
  });

  it('未認証は 401 で、本文を読まない (1 MiB を超える本文でも)', async () => {
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    });
    const req = post({ body: jpegBytes(MiB + 10) });
    const response = await POST(req);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(checkReadRateLimit).not.toHaveBeenCalled();
    expectStoppedBeforeBody(req);
  });

  it('段階 admin で運営者でないウォレットは 403 (本文を読まない)・ADMIN_WALLETS が空なら誰も通さない', async () => {
    session(OTHER);
    const req = post();
    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'forbidden' });
    expectStoppedBeforeBody(req);

    session(OWNER);
    vi.stubEnv('ADMIN_WALLETS', '');
    expect((await POST(post())).status).toBe(403);
  });

  it('段階 all なら運営者でなくても置ける', async () => {
    vi.stubEnv('IMAGE_UPLOAD_MODE', 'all');
    session(OTHER);
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(blob.put.mock.calls[0][0]).toMatch(new RegExp(`^${ownerPrefix(OTHER)}`));
  });

  it.each([
    ['秘密が無い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', undefined)],
    ['秘密が 32 byte 未満', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', 'x'.repeat(31))],
    ['BLOB_STORE_ID が無い', () => vi.stubEnv('BLOB_STORE_ID', undefined)],
    ['BLOB_STORE_ID が空白だけ', () => vi.stubEnv('BLOB_STORE_ID', '  ')],
  ])('%s なら 503 not_configured (本文を読まない)', async (_label, setup) => {
    setup();
    const req = post();
    const response = await POST(req);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'not_configured' });
    expectStoppedBeforeBody(req);
  });

  it.each([
    ['無い', null],
    ['知らない用途', 'banner'],
    ['大文字', 'PRODUCT'],
  ])('用途が %s なら 400 invalid_purpose', async (_label, purpose) => {
    const req = post({ purpose });
    const response = await POST(req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_purpose' });
    expectStoppedBeforeBody(req);
  });

  it.each([
    ['WebP', 'image/webp'],
    ['SVG', 'image/svg+xml'],
    ['JSON', 'application/json'],
    ['無い', null],
  ])('宣言した形式が %s なら 415 (本文を読まず、日次の回数も使わない)', async (_label, type) => {
    const req = post({ type });
    const response = await POST(req);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: 'unsupported_media_type' });
    expect(checkReadRateLimit).not.toHaveBeenCalled();
    expectStoppedBeforeBody(req);
  });

  it('Content-Type の大文字と parameter は許す', async () => {
    expect((await POST(post({ type: 'Image/JPEG; charset=binary' }))).status).toBe(200);
  });
});

describe('images upload: 1 日の回数', () => {
  it('ウォレット 30 回・IP 60 回 (UTC 日) を数える', async () => {
    await POST(post());
    expect(checkReadRateLimit).toHaveBeenCalledWith(`images:upload:wallet:${OWNER.toLowerCase()}`, 30, DAY);
    expect(checkReadRateLimit).toHaveBeenCalledWith('images:upload:ip:hashed-ip', 60, DAY);
  });

  it.each([
    ['ウォレット', 'images:upload:wallet:'],
    ['IP', 'images:upload:ip:'],
  ])('%s の枠を超えたら 429 と次の UTC 日までの秒数 (本文を読まない)', async (_label, prefix) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 19, 23, 0, 0)));
    checkReadRateLimit.mockImplementation(async (key: string) => !key.startsWith(prefix));
    const req = post();
    const response = await POST(req);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 3600 });
    expect(response.headers.get('retry-after')).toBe('3600');
    expectStoppedBeforeBody(req);
  });

  it('IP の hash が作れないときは IP の枠を飛ばす (共有の bucket に寄せない)', async () => {
    hashIpBucket.mockReturnValue(null);
    expect((await POST(post())).status).toBe(200);
    expect(checkReadRateLimit).toHaveBeenCalledTimes(1);
    expect(checkReadRateLimit).toHaveBeenCalledWith(`images:upload:wallet:${OWNER.toLowerCase()}`, 30, DAY);
  });
});

describe('images upload: 本文', () => {
  it('ちょうど 1 MiB は通り、1 MiB を超えたら 413 (Blob と全体の枠に届かない)', async () => {
    expect((await POST(post({ body: jpegBytes(MiB) }))).status).toBe(200);
    vi.clearAllMocks();
    const req = post({ body: jpegBytes(MiB + 1) });
    const response = await POST(req);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: 'payload_too_large' });
    expect(req.bodyUsed).toBe(true);
    expect(blob.list).not.toHaveBeenCalled();
    expect(kv.kvIncr).not.toHaveBeenCalled();
  });

  it('本文が無ければ 400 invalid_body', async () => {
    const response = await POST(post({ body: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' });
  });

  it.each([
    ['PNG と宣言して JPEG', 'image/png', jpegBytes()],
    ['JPEG と宣言して PNG', 'image/jpeg', pngBytes()],
    ['JPEG と宣言して HTML', 'image/jpeg', new TextEncoder().encode('<html><script>alert(1)</script></html>')],
    ['JPEG と宣言して SVG', 'image/jpeg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['空', 'image/jpeg', new Uint8Array(0)],
    ['印だけ', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])],
  ])('先頭 byte が宣言と合わない (%s) なら 415 invalid_image (Blob と全体の枠に届かない)', async (_label, type, body) => {
    const response = await POST(post({ type, body }));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_image' });
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
    expect(kv.kvIncr).not.toHaveBeenCalled();
  });
});

describe('images upload: 保有の枚数と全体の枠', () => {
  it('自分の prefix だけを limit 201 で数え、200 枚あれば 409 image_limit (全体の枠を使わない)', async () => {
    blob.list.mockResolvedValue({ blobs: Array.from({ length: 200 }, (_, i) => ({ pathname: `x${i}` })), hasMore: true });
    const response = await POST(post());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'image_limit' });
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: ownerPrefix(), limit: 201 }));
    expect(kv.kvIncr).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });

  it('199 枚なら置ける', async () => {
    blob.list.mockResolvedValue({ blobs: Array.from({ length: 199 }, (_, i) => ({ pathname: `x${i}` })), hasMore: false });
    expect((await POST(post())).status).toBe(200);
  });

  it('list が失敗したら 503 storage_unavailable (置かない・全体の枠を使わない)', async () => {
    blob.list.mockRejectedValue(new Error(`Vercel Blob: failed for ${ownerPrefix()}`));
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(blob.put).not.toHaveBeenCalled();
    expect(kv.kvIncr).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('images.upload.failed', { code: 'list_failed' });
  });

  it('全体の 1 日の枠は最後 (list の後・put の前) に数える', async () => {
    const order: string[] = [];
    checkReadRateLimit.mockImplementation(async () => {
      order.push('daily');
      return true;
    });
    blob.list.mockImplementation(async () => {
      order.push('list');
      return { blobs: [], hasMore: false };
    });
    kv.kvIncr.mockImplementation(async () => {
      order.push('global');
      return { ok: true, value: 1 };
    });
    blob.put.mockImplementation(async (pathname: string) => {
      order.push('put');
      return { url: `${BLOB_URL_BASE}/${pathname}` };
    });
    expect((await POST(post())).status).toBe(200);
    expect(order).toEqual(['daily', 'daily', 'list', 'global', 'put']);
    expect(kv.kvIncr).toHaveBeenCalledWith(imageUploadGlobalDailyKey(), { initialTtlSec: 2 * DAY });
  });

  it('全体の枠 (200 回) を超えたら 429 (置かない)', async () => {
    kv.kvIncr.mockResolvedValue({ ok: true, value: 201 });
    const response = await POST(post());
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('rate_limited');
    expect(blob.put).not.toHaveBeenCalled();
    kv.kvIncr.mockResolvedValue({ ok: true, value: 200 });
    expect((await POST(post())).status).toBe(200);
  });

  it.each([
    ['KV が無い', () => kv.isKvConfigured.mockReturnValue(false)],
    ['KV の加算が失敗', () => kv.kvIncr.mockResolvedValue({ ok: false, reason: 'network', detail: 'down' })],
  ])('%s なら全体の枠を数えられないので 503 で止める (fail-closed)', async (_label, setup) => {
    setup();
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(blob.put).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('images.upload.failed', { code: 'global_count_unavailable' });
  });
});

describe('images upload: 置く', () => {
  it('public・suffix なし・上書きなし・1 年のキャッシュで、v1/<ownerKey>/<purpose>/<id>.jpg に置き、その URL を返す', async () => {
    const bytes = jpegBytes(4096);
    const response = await POST(post({ body: bytes }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const [pathname, body, options] = blob.put.mock.calls[0];
    expect(pathname).toMatch(/^v1\/[A-Za-z0-9_-]{22}\/product\/[A-Za-z0-9_-]{22}\.jpg$/);
    expect(pathname.startsWith(ownerPrefix())).toBe(true);
    expect(Buffer.compare(Buffer.from(body as Buffer), Buffer.from(bytes))).toBe(0);
    expect(options).toMatchObject({
      access: 'public',
      contentType: 'image/jpeg',
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: IMAGE_CACHE_MAX_AGE_SEC,
    });
    expect(IMAGE_CACHE_MAX_AGE_SEC).toBe(365 * DAY);
    // 長く生きる token を渡さない (OIDC は SDK が解決する)。
    expect(options).not.toHaveProperty('token');
    expect(await response.json()).toEqual({ ok: true, url: `${BLOB_URL_BASE}/${pathname}` });
  });

  it('PNG は .png・用途は path に入る・id は毎回違う', async () => {
    await POST(post({ body: pngBytes(), type: 'image/png', purpose: 'avatar' }));
    await POST(post({ body: pngBytes(), type: 'image/png', purpose: 'avatar' }));
    const [first, second] = blob.put.mock.calls.map((call) => call[0] as string);
    expect(first).toMatch(new RegExp(`^${ownerPrefix()}avatar/[A-Za-z0-9_-]{22}\\.png$`));
    expect(second).not.toBe(first);
    expect(blob.put.mock.calls[0][2]).toMatchObject({ contentType: 'image/png' });
  });

  it('put が失敗したら 502 upload_failed (固定の code だけをログに出す)', async () => {
    blob.put.mockRejectedValue(new Error('Vercel Blob: This blob already exists'));
    const response = await POST(post());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'upload_failed' });
    expect(logger.warn).toHaveBeenCalledWith('images.upload.failed', { code: 'put_failed' });
  });

  it('ログ (logger・console) にアドレス・ownerKey・path・URL・SDK の文を出さない', async () => {
    const consoleCalls = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    await POST(post());
    blob.list.mockRejectedValueOnce(new Error(`sdk-marker list ${ownerPrefix()}`));
    await POST(post());
    kv.kvIncr.mockResolvedValueOnce({ ok: false, reason: 'network', detail: 'down' });
    await POST(post());
    blob.put.mockRejectedValueOnce(new Error(`sdk-marker put ${BLOB_URL_BASE}/${ownerPrefix()}x.jpg`));
    await POST(post());
    const logged = JSON.stringify([
      ...Object.values(logger).map((fn) => fn.mock.calls),
      ...consoleCalls.map((spy) => spy.mock.calls),
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    for (const secretish of [OWNER, OWNER.toLowerCase(), imageOwnerKey(OWNER, SECRET), 'v1/', BLOB_URL_BASE, 'sdk-marker']) {
      expect(logged).not.toContain(secretish);
    }
  });
});

describe('出品者の GET: imageUpload', () => {
  async function imageUploadFlag(): Promise<unknown> {
    const response = await getSeller(new Request('https://open-pay.jp/api/store/seller'));
    expect(response.status).toBe(200);
    return ((await response.json()) as { imageUpload?: unknown }).imageUpload;
  }

  it('段階 admin・運営者・秘密と Blob の設定がそろえば true', async () => {
    expect(await imageUploadFlag()).toBe(true);
  });

  it('段階 all なら運営者でなくても true', async () => {
    vi.stubEnv('IMAGE_UPLOAD_MODE', 'all');
    session(OTHER);
    expect(await imageUploadFlag()).toBe(true);
  });

  it.each([
    ['段階が未設定 (off)', () => vi.stubEnv('IMAGE_UPLOAD_MODE', undefined)],
    ['段階 admin で運営者でない', () => session(OTHER)],
    ['ADMIN_WALLETS が空', () => vi.stubEnv('ADMIN_WALLETS', '')],
    ['秘密が無い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', undefined)],
    ['秘密が短い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', 'short')],
    ['Blob の store が無い', () => vi.stubEnv('BLOB_STORE_ID', undefined)],
  ])('%s なら false (画面は今の URL の欄のまま)', async (_label, setup) => {
    setup();
    expect(await imageUploadFlag()).toBe(false);
  });

  it('GET は Blob に触れない', async () => {
    await imageUploadFlag();
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });
});
