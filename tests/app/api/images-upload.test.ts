// @vitest-environment node
// POST /api/images/upload (画像のアップロード) と、出品者の GET の imageUpload。
// 検査の順 (段階 → 同じ origin → IP の分ごと → セッション → 運営者 → 秘密と Blob → 用途と形式 → ウォレットと IP の 1 日 → 本文
// (1 MiB) → 先頭 byte → 保有の枚数 → 全体の 1 日 (最後・KV 障害で止める) → put)・本文は認証と枠を通るまで読まないこと
// (req.bodyUsed)・put の引数・ログにアドレス・path・URL を出さないことを固定する。Blob は mock (実 API は使わない)。
// 絶対の期限: 要求を受けてから IMAGE_UPLOAD_DEADLINE_MS (関数の上限 maxDuration より前) で、どの段で待っていても 503。
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

import { POST, maxDuration } from '@/app/api/images/upload/route';
import { GET as getSeller } from '@/app/api/store/seller/route';
import { imageOwnerKey } from '@/lib/images/ownerKey';
import {
  BLOB_LIST_DEADLINE_MS,
  BLOB_PUT_DEADLINE_MS,
  IMAGE_CACHE_MAX_AGE_SEC,
  IMAGE_UPLOAD_DEADLINE_MS,
} from '@/lib/images/blobStore';
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

/** 偽の timer で ms 後に value を返す (遅い KV・遅い Blob)。 */
function later<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** 応答を待たずに始める (応答がまだ無いことを、時を進めながら確かめるため)。 */
function start(req: Request = post()): { response?: Response } {
  const request: { response?: Response } = {};
  void POST(req).then((response) => {
    request.response = response;
  });
  return request;
}

beforeEach(() => {
  state.storeEnabled = true;
  vi.stubEnv('IMAGE_UPLOAD_MODE', 'admin');
  vi.stubEnv('IMAGE_OWNER_KEY_SECRET', SECRET);
  vi.stubEnv('BLOB_STORE_ID', 'store_test');
  // IP の枠の秘密 (出品者の GET の imageUpload が見る。POST の IP の bucket は hashIpBucket の mock で決める)。
  vi.stubEnv('IP_HASH_SECRET', 'test-ip-hash-secret-0123456789abcdef');
  vi.stubEnv('ADMIN_WALLETS', `0x3333333333333333333333333333333333333333, ${OWNER}`);
  session(OWNER);
  hashIpBucket.mockReturnValue('hashed-ip');
  checkIpRateLimit.mockResolvedValue(true);
  checkReadRateLimit.mockResolvedValue(true);
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
  // 前の test の mockResolvedValueOnce が残って次の test に漏れないよう、Blob の mock は毎回まっさらにする。
  blob.list.mockReset();
  blob.put.mockReset();
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

  it('ウォレットの枠で断ったら IP の枠を使わない', async () => {
    const counted: string[] = [];
    checkReadRateLimit.mockImplementation(async (key: string) => {
      counted.push(key.startsWith('images:upload:wallet:') ? 'wallet' : key.startsWith('images:upload:ip:') ? 'ip' : key);
      return !key.startsWith('images:upload:wallet:');
    });
    expect((await POST(post())).status).toBe(429);
    expect(counted).toEqual(['wallet']);
  });
});

describe('images upload: IP を数えられないとき', () => {
  it('IP の bucket が作れない (IP_HASH_SECRET が無い・接続元が分からない) なら 503 で、セッション・本文・枠に届かない', async () => {
    hashIpBucket.mockReturnValue(null);
    const req = post();
    const response = await POST(req);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'not_configured' });
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(requireSession).not.toHaveBeenCalled();
    expect(checkReadRateLimit).not.toHaveBeenCalled();
    expectStoppedBeforeBody(req);
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
  const blobs = (count: number) => Array.from({ length: count }, (_, i) => ({ pathname: `x${i}` }));

  it('自分の prefix だけを数え、200 枚あれば 409 image_limit (全体の枠を使わない)', async () => {
    blob.list.mockResolvedValue({ blobs: blobs(200), hasMore: true, cursor: 'c1' });
    const response = await POST(post());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'image_limit' });
    expect(blob.list).toHaveBeenCalledTimes(1);
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: ownerPrefix(), limit: 200, cursor: undefined }));
    expect(kv.kvIncr).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });

  it('199 枚なら置ける (最後のページ)', async () => {
    blob.list.mockResolvedValue({ blobs: blobs(199), hasMore: false });
    expect((await POST(post())).status).toBe(200);
  });

  it('1 ページ目が 199 枚で続きがあれば、同じ prefix で cursor を追って数える (200 枚に届けば 409)', async () => {
    blob.list
      .mockResolvedValueOnce({ blobs: blobs(199), hasMore: true, cursor: 'c1' })
      .mockResolvedValueOnce({ blobs: blobs(1), hasMore: true, cursor: 'c2' });
    const response = await POST(post());
    expect(response.status).toBe(409);
    expect(blob.list).toHaveBeenCalledTimes(2);
    expect(blob.list.mock.calls[1][0]).toMatchObject({ prefix: ownerPrefix(), limit: 1, cursor: 'c1' });
    expect(blob.put).not.toHaveBeenCalled();
  });

  it('続きのページが空で終われば 199 枚として置ける', async () => {
    blob.list
      .mockResolvedValueOnce({ blobs: blobs(150), hasMore: true, cursor: 'c1' })
      .mockResolvedValueOnce({ blobs: blobs(49), hasMore: false });
    expect((await POST(post())).status).toBe(200);
    expect(blob.list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['続きのページで失敗', () => blob.list.mockResolvedValueOnce({ blobs: blobs(10), hasMore: true, cursor: 'c1' }).mockRejectedValueOnce(new Error('page 2'))],
    ['続きがあるのに cursor が無い', () => blob.list.mockResolvedValueOnce({ blobs: blobs(10), hasMore: true })],
  ])('%s なら 503 storage_unavailable (置かない)', async (_label, setup) => {
    setup();
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(blob.put).not.toHaveBeenCalled();
    expect(kv.kvIncr).not.toHaveBeenCalled();
  });

  it('list が締切 (cursor を追う全体で 5 秒) までに終わらなければ 503 で、signal は AbortError で中断する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let signal: AbortSignal | undefined;
    blob.list.mockImplementation((options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    });
    const pending = POST(post());
    await vi.advanceTimersByTimeAsync(BLOB_LIST_DEADLINE_MS);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(logger.warn).toHaveBeenCalledWith('images.upload.failed', { code: 'list_deadline' });
    expect(blob.put).not.toHaveBeenCalled();
  });

  it('list の締切はページごとではなく合計: 1 ページ目が 4 秒で返り 2 ページ目が応答しなければ、list を始めて 5 秒で 503', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signals: AbortSignal[] = [];
    blob.list
      .mockImplementationOnce((options: { abortSignal: AbortSignal }) => {
        signals.push(options.abortSignal);
        return later(4_000, { blobs: blobs(10), hasMore: true, cursor: 'c1' });
      })
      .mockImplementationOnce((options: { abortSignal: AbortSignal }) => {
        signals.push(options.abortSignal);
        return new Promise(() => {});
      });
    const request = start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(blob.list).toHaveBeenCalledTimes(2);
    expect(blob.list.mock.calls[1][0]).toMatchObject({ prefix: ownerPrefix(), cursor: 'c1' });
    // 2 ページ目を呼んでから 5 秒ではない (締切を数え直さない)。
    await vi.advanceTimersByTimeAsync(BLOB_LIST_DEADLINE_MS - 4_000 - 1);
    expect(request.response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.response?.status).toBe(503);
    expect(await request.response?.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    // 2 つのページは同じ signal (1 つの締切) を受け、締切で AbortError で止まる。
    expect(signals[1]).toBe(signals[0]);
    expect(signals[1].aborted).toBe(true);
    expect((signals[1].reason as DOMException).name).toBe('AbortError');
    expect(logger.warn.mock.calls).toEqual([['images.upload.failed', { code: 'list_deadline' }]]);
    expect(blob.put).not.toHaveBeenCalled();
    expect(kv.kvIncr).not.toHaveBeenCalled();
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

  it('全体の 1 日の枠は最後 (ウォレット → IP → list の後・put の前) に数える', async () => {
    const order: string[] = [];
    checkReadRateLimit.mockImplementation(async (key: string) => {
      order.push(key.startsWith('images:upload:wallet:') ? 'wallet' : key.startsWith('images:upload:ip:') ? 'ip' : key);
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
    expect(order).toEqual(['wallet', 'ip', 'list', 'global', 'put']);
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

  it('put が締切 (10 秒) までに終わらなければ 503 storage_unavailable で、signal は AbortError で中断する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let signal: AbortSignal | undefined;
    blob.put.mockImplementation((_pathname: string, _body: unknown, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    });
    const pending = POST(post());
    await vi.advanceTimersByTimeAsync(BLOB_PUT_DEADLINE_MS);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(logger.warn).toHaveBeenCalledWith('images.upload.failed', { code: 'put_deadline' });
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

describe('images upload: 絶対の期限 (関数の上限より前に必ず固定の code で返す)', () => {
  const never = () => new Promise<never>(() => {});
  const failures = () => logger.warn.mock.calls.map(([, detail]) => (detail as { code: string }).code);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('期限は関数の上限 (maxDuration) の 5 秒以上前で、list と put の上限はその内側', () => {
    expect(maxDuration * 1000 - IMAGE_UPLOAD_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    expect(BLOB_LIST_DEADLINE_MS).toBeLessThan(IMAGE_UPLOAD_DEADLINE_MS);
    expect(BLOB_PUT_DEADLINE_MS).toBeLessThan(IMAGE_UPLOAD_DEADLINE_MS);
  });

  it('前段 (KV 4 秒 × 2・list 3 秒) がどれも上限の内側で 11 秒を使った後に put が応答しなければ、開始から 15 秒で 503 (put の 10 秒を待たない)', async () => {
    checkReadRateLimit.mockImplementationOnce(() => later(4_000, true)).mockImplementationOnce(() => later(4_000, true));
    blob.list.mockImplementation(() => later(3_000, { blobs: [], hasMore: false }));
    let signal: AbortSignal | undefined;
    blob.put.mockImplementation((_pathname: string, _body: unknown, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return never();
    });
    const request = start();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(blob.put).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_DEADLINE_MS - 11_000 - 1);
    expect(request.response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.response?.status).toBe(503);
    expect(await request.response?.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(request.response?.headers.get('cache-control')).toBe('private, no-store');
    // put は期限で AbortError で止まる (SDK の送り直しを続けさせない)。
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(failures()).toEqual(['route_deadline', 'put_deadline']);
    // 残る timer は無い (put の 10 秒の timer も片づく)。
    expect(vi.getTimerCount()).toBe(0);
  });

  it('前段で 12 秒を使った後に list が応答しなければ、開始から 15 秒で 503 (list の 5 秒を待たない・全体の枠を使わない)', async () => {
    checkReadRateLimit.mockImplementationOnce(() => later(12_000, true));
    let signal: AbortSignal | undefined;
    blob.list.mockImplementation((options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return never();
    });
    const request = start();
    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_DEADLINE_MS - 1);
    expect(blob.list).toHaveBeenCalledTimes(1);
    expect(request.response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.response?.status).toBe(503);
    expect(await request.response?.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(failures()).toEqual(['route_deadline', 'list_deadline']);
    expect(kv.kvIncr).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['IP の分ごとの制限 (KV)', () => { checkIpRateLimit.mockImplementation(never); }],
    ['セッション (KV)', () => { requireSession.mockImplementation(never); }],
    ['ウォレットの 1 日の枠 (KV)', () => { checkReadRateLimit.mockImplementationOnce(never); }],
    ['IP の 1 日の枠 (KV)', () => { checkReadRateLimit.mockImplementationOnce(async () => true).mockImplementationOnce(never); }],
    ['全体の 1 日の枠 (KV)', () => { kv.kvIncr.mockImplementation(never); }],
  ])('%s が応答しなくても、開始から 15 秒で 503 storage_unavailable (Blob に置かない)', async (_label, setup) => {
    setup();
    const request = start();
    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_DEADLINE_MS - 1);
    expect(request.response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.response?.status).toBe(503);
    expect(await request.response?.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(failures()).toEqual(['route_deadline']);
    expect(blob.put).not.toHaveBeenCalled();
  });

  it('本文が届ききらなくても、開始から 15 秒で 503 storage_unavailable', async () => {
    const req = new Request('https://open-pay.jp/api/images/upload?purpose=product', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'sec-fetch-site': 'same-origin' },
      // 先頭だけ届いて、続きも終わりも来ない本文。
      body: new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(jpegBytes(16)) }),
      duplex: 'half',
    } as RequestInit);
    const request = start(req);
    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_DEADLINE_MS - 1);
    expect(request.response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.response?.status).toBe(503);
    expect(await request.response?.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(failures()).toEqual(['route_deadline']);
    expect(blob.list).not.toHaveBeenCalled();
  });

  it('期限の後に前段 (セッション) が返っても、続きは Blob に触れず、全体の枠も使わず、ログも足さない', async () => {
    requireSession.mockImplementation(() => later(IMAGE_UPLOAD_DEADLINE_MS + 1_000, { ok: true, address: OWNER }));
    const request = start();
    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_DEADLINE_MS);
    expect(request.response?.status).toBe(503);
    await vi.advanceTimersByTimeAsync(60_000);
    // 続きは本文まで進んで止まる (list を始めない)。
    expect(checkReadRateLimit).toHaveBeenCalledTimes(2);
    expect(blob.list).not.toHaveBeenCalled();
    expect(kv.kvIncr).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
    expect(failures()).toEqual(['route_deadline']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('期限の後に全体の枠 (KV) が返っても、put を始めない', async () => {
    kv.kvIncr.mockImplementation(() => later(IMAGE_UPLOAD_DEADLINE_MS + 1_000, { ok: true, value: 1 }));
    const request = start();
    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_DEADLINE_MS);
    expect(request.response?.status).toBe(503);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kv.kvIncr).toHaveBeenCalledTimes(1);
    expect(blob.put).not.toHaveBeenCalled();
    expect(failures()).toEqual(['route_deadline']);
  });

  it('期限の内側で終われば 200 で、期限の timer を残さない', async () => {
    checkReadRateLimit.mockImplementationOnce(() => later(4_000, true));
    blob.list.mockImplementation(() => later(4_000, { blobs: [], hasMore: false }));
    blob.put.mockImplementation((pathname: string) => later(6_000, { url: `${BLOB_URL_BASE}/${pathname}` }));
    const request = start();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(request.response?.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('images upload: 単調時計の期限 (timer の callback より先に期限をまたいだとき)', () => {
  let now = 1_000;
  const failures = () => logger.warn.mock.calls.map(([, detail]) => (detail as { code: string }).code);

  beforeEach(() => {
    now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  it('list の間に期限をまたいだら、全体の枠を使わず put もせず 503 (route_deadline は 1 回)', async () => {
    blob.list.mockImplementation(async () => {
      // 同期の処理・event loop の遅れで、期限の timer が走る前に 15 秒を過ぎた。
      now += IMAGE_UPLOAD_DEADLINE_MS + 1;
      return { blobs: [], hasMore: false };
    });
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(kv.kvIncr).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
    expect(failures()).toEqual(['route_deadline']);
  });

  it('全体の枠を数える間に期限をまたいだら、put をしない', async () => {
    kv.kvIncr.mockImplementation(async () => {
      now += IMAGE_UPLOAD_DEADLINE_MS + 1;
      return { ok: true, value: 1 };
    });
    const response = await POST(post());
    expect(response.status).toBe(503);
    expect(blob.put).not.toHaveBeenCalled();
    expect(failures()).toEqual(['route_deadline']);
  });

  it('期限の内側なら今までどおり置く', async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(blob.put).toHaveBeenCalledTimes(1);
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
    // IP の枠を数えられないと POST は 503 not_configured になるので、欄を出さない (押すたびに 503 にしない)。
    ['IP の枠の秘密 (IP_HASH_SECRET) が無い', () => vi.stubEnv('IP_HASH_SECRET', undefined)],
    ['IP の枠の秘密が 32 byte より短い', () => vi.stubEnv('IP_HASH_SECRET', 'a'.repeat(31))],
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
