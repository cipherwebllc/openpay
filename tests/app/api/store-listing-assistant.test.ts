// @vitest-environment node
// POST /api/store/seller/listing-assistant (AI 出品アシスタント) と、出品者の GET の listingAssistant。
// 認可の順 (フラグ → 同じ origin → JSON → 出品者認証 → 運営者 → 日次の制限 → 入力 → Gemini)・商品を KV から読まないこと・
// 有料の本文・納品 URL・開示の欄の目印が Google 宛ての本文に 1 つも出ないことを固定する。実 API は使わない (fetch を mock)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { listingAssistantFactsOf } from '@/lib/store/listingAssistant';
import {
  COO_WORLD_DRAFT,
  emptyProductForm,
  existingProductForm,
  geminiBody,
  geminiQuotaBody,
  jpegBase64,
  jsonResponse,
  MARKERS,
  SELLER_FORM,
  sentGeminiBody,
  sentMaterial,
  SPEC_SEND_KEYS,
} from '../../_helpers/listingAssistantFixtures';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const DAILY_KEY = 'store-listing-assistant:global';
const COO_MEMO = 'Coo World向けの木目調スタンドライト';

const state = vi.hoisted(() => ({ storeEnabled: true, dailyAllowed: true }));
const requireSession = vi.hoisted(() => vi.fn());
const checkIpRateLimit = vi.hoisted(() => vi.fn());
const checkReadRateLimit = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
// 商品・本文・販売者情報を読む口 (facade) と KV の口。POST はどれにも触れない。
const productReads = vi.hoisted(() => ({
  getHostedProduct: vi.fn(),
  getHostedProductUpdateSnapshot: vi.fn(),
  getHostedContent: vi.fn(),
  listHostedForOwner: vi.fn(),
  listAvailableHostedForOwner: vi.fn(),
  getHostedProductsByIds: vi.fn(),
  getSellerDisclosure: vi.fn(),
}));
const kvCalls = vi.hoisted(() => ({
  kvGet: vi.fn(),
  kvMget: vi.fn(),
  kvLrange: vi.fn(),
  kvEval: vi.fn(),
  kvIncr: vi.fn(),
  kvSet: vi.fn(),
  kvGetDel: vi.fn(),
}));
const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

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
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '192.0.2.1', hashIpBucket: () => 'hashed-ip' }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit, checkReadRateLimit }));
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/kv', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/kv')>()), ...kvCalls }));
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/hostedStore')>()),
  ...productReads,
}));

import { POST } from '@/app/api/store/seller/listing-assistant/route';
import { GET as getSeller } from '@/app/api/store/seller/route';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://open-pay.jp/api/store/seller/listing-assistant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const cooBody = () => ({ memo: COO_MEMO, facts: listingAssistantFactsOf(emptyProductForm()) });

function expectNoProductOrKvRead() {
  for (const spy of [...Object.values(productReads), ...Object.values(kvCalls)]) {
    expect(spy).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  state.storeEnabled = true;
  state.dailyAllowed = true;
  vi.stubEnv('ENABLE_STORE_LISTING_ASSISTANT', '1');
  vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
  vi.stubEnv('ADMIN_WALLETS', `${OTHER}, ${OWNER}`);
  vi.stubGlobal('fetch', fetchMock);
  requireSession.mockResolvedValue({ ok: true, address: OWNER });
  checkIpRateLimit.mockResolvedValue(true);
  checkReadRateLimit.mockImplementation(async (key: string) => (key === DAILY_KEY ? state.dailyAllowed : true));
  fetchMock.mockResolvedValue(jsonResponse(geminiBody()));
  productReads.getSellerDisclosure.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('listing assistant route: 入口の検査', () => {
  it.each([
    ['Store のフラグ OFF', () => { state.storeEnabled = false; }],
    ['アシスタントのフラグ OFF', () => { vi.stubEnv('ENABLE_STORE_LISTING_ASSISTANT', ''); }],
    ['アシスタントのフラグが 0', () => { vi.stubEnv('ENABLE_STORE_LISTING_ASSISTANT', '0'); }],
  ])('%s は 404 で、認証・回数・Google に届かない', async (_label, setup) => {
    setup();
    const response = await POST(post(cooBody()));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
    expect(requireSession).not.toHaveBeenCalled();
    expect(checkReadRateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('別 origin は 403・JSON でない Content-Type は 415 (認証の前)', async () => {
    const crossSite = await POST(post(cooBody(), { 'sec-fetch-site': 'cross-site' }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ ok: false, error: 'cross_site_request' });
    const sameSite = await POST(post(cooBody(), { 'sec-fetch-site': 'same-site' }));
    expect(sameSite.status).toBe(403);
    const textPlain = await POST(post(cooBody(), { 'content-type': 'text/plain' }));
    expect(textPlain.status).toBe(415);
    expect(await textPlain.json()).toEqual({ ok: false, error: 'unsupported_media_type' });
    expect(requireSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('本文は全体 1.5 MiB まで (超えたら 413)・JSON でなければ 400 (どちらも認証の前)', async () => {
    const tooLarge = await POST(post({ memo: 'a', facts: {}, pad: 'x'.repeat(1.5 * 1024 * 1024) }));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ ok: false, error: 'payload_too_large' });
    const notJson = await POST(post('{"memo":'));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ ok: false, error: 'invalid_json' });
    expect(requireSession).not.toHaveBeenCalled();
  });

  it('未認証は 401', async () => {
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }),
    });
    const response = await POST(post(cooBody()));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('出品者認証は IP と address の既存の制限 (scope listing-assistant) を通る', async () => {
    await POST(post(cooBody()));
    expect(checkIpRateLimit).toHaveBeenCalledWith('creator-store:listing-assistant', 'hashed-ip', 60, 60);
    expect(checkReadRateLimit).toHaveBeenCalledWith(`creator-store:listing-assistant:${OWNER}`, 60, 60);
  });

  it.each([
    ['運営者でない', () => { vi.stubEnv('ADMIN_WALLETS', OTHER); }],
    ['ADMIN_WALLETS が空', () => { vi.stubEnv('ADMIN_WALLETS', ''); }],
    ['ADMIN_WALLETS が未設定', () => { vi.stubEnv('ADMIN_WALLETS', undefined); }],
  ])('%s は 403 で、日次の回数を使わず Google に届かない', async (_label, setup) => {
    setup();
    const response = await POST(post(cooBody()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'forbidden' });
    expect(checkReadRateLimit).not.toHaveBeenCalledWith(DAILY_KEY, expect.anything(), expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('全体の日次 (UTC 日・20 回) を超えたら 429 rate_limited と次の UTC 日までの秒数', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 19, 23, 0, 0)));
    state.dailyAllowed = false;
    const response = await POST(post(cooBody()));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 3600 });
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(checkReadRateLimit).toHaveBeenCalledWith(DAILY_KEY, 20, 86_400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('日次の制限は入力の検証より前 (不正な入力も 1 回に数える・Google には届かない)', async () => {
    const response = await POST(post({ memo: COO_MEMO, facts: {}, content: MARKERS.content }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' });
    expect(checkReadRateLimit).toHaveBeenCalledWith(DAILY_KEY, 20, 86_400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['メモも画像も無い', { facts: {} }, 400, 'memo_or_image_required'],
    ['facts に未知の key', { memo: COO_MEMO, facts: { content: MARKERS.content } }, 400, 'invalid_facts'],
    ['JPEG でない', { memo: COO_MEMO, image: { mimeType: 'image/png', data: jpegBase64() }, facts: {} }, 400, 'invalid_image'],
    ['画像が 1 MiB を超える', { image: { mimeType: 'image/jpeg', data: jpegBase64(1024 * 1024 + 1) }, facts: {} }, 413, 'image_too_large'],
  ])('入力の不正 (%s)', async (_label, body, status, error) => {
    const response = await POST(post(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listing assistant route: Google に送るもの', () => {
  it('既存の商品 (有料の本文・納品 URL・開示の欄に目印) から作った送信と Google 宛ての本文に目印が無く、key が許可リストとちょうど同じ', async () => {
    // 画面の状態の全体 (商品のフォーム + 販売者情報) から、画面と同じ抽出で送信の中身を作る。
    const panelState = { productForm: existingProductForm(), sellerForm: SELLER_FORM };
    const image = { mimeType: 'image/jpeg' as const, data: jpegBase64() };
    const browserBody = { memo: COO_MEMO, image, facts: listingAssistantFactsOf(panelState.productForm) };
    const browserJson = JSON.stringify(browserBody);
    for (const marker of Object.values(MARKERS)) expect(browserJson).not.toContain(marker);
    expect(Object.keys(browserBody.facts).sort()).toEqual(SPEC_SEND_KEYS);

    const response = await POST(post(browserJson));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const googleJson = String(init?.body);
    for (const marker of Object.values(MARKERS)) expect(googleJson).not.toContain(marker);
    const material = sentMaterial(sentGeminiBody(init));
    expect(Object.keys(material.facts).sort()).toEqual(SPEC_SEND_KEYS);
    expect(material.memo).toBe(COO_MEMO);
    // この route は商品を KV から読まない (送るのは画面から届いた欄だけ)。
    expectNoProductOrKvRead();
  });

  it('成功は案を返し、ログに何も出さない', async () => {
    const response = await POST(post(cooBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      draft: {
        title: { value: COO_WORLD_DRAFT.title, fits: true },
        desc: { value: COO_WORLD_DRAFT.desc, fits: true },
        tags: { value: COO_WORLD_DRAFT.tags, fits: true },
        en: { value: COO_WORLD_DRAFT.en, fits: true },
        x: { value: COO_WORLD_DRAFT.x, fits: true },
        checks: { value: COO_WORLD_DRAFT.checks, fits: true },
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expectNoProductOrKvRead();
  });
});

describe('listing assistant route: Google の失敗', () => {
  it.each([
    ['無料枠の 429', () => jsonResponse(geminiQuotaBody('42s'), 429), 429, { ok: false, error: 'quota_exceeded', retryAfterSec: 42 }, { code: 'quota_exceeded', upstreamStatus: 429 }],
    ['SAFETY', () => jsonResponse(geminiBody(undefined, { finishReason: 'SAFETY' })), 422, { ok: false, error: 'blocked' }, { code: 'blocked' }],
    ['MAX_TOKENS', () => jsonResponse(geminiBody(undefined, { finishReason: 'MAX_TOKENS' })), 502, { ok: false, error: 'truncated' }, { code: 'truncated' }],
    ['JSON でない', () => jsonResponse(geminiBody(undefined, { text: 'こちらが案です' })), 502, { ok: false, error: 'bad_response' }, { code: 'bad_response' }],
    ['Google の 500', () => jsonResponse({ error: { code: 500, status: 'INTERNAL' } }, 500), 503, { ok: false, error: 'unavailable' }, { code: 'unavailable', upstreamStatus: 500 }],
  ])('%s', async (_label, respond, status, body, logged) => {
    fetchMock.mockResolvedValue(respond());
    const response = await POST(post({ ...cooBody(), memo: `${COO_MEMO} ${MARKERS.content}` }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get('retry-after')).toBe('retryAfterSec' in body ? String(body.retryAfterSec) : null);
    // ログは固定の code と Google の status だけ (メモ・画像・出力の本文を出さない)。
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('store.listing_assistant.failed', logged);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(MARKERS.content);
  });

  it('key が無ければ 503 not_configured (Google を呼ばない)', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const response = await POST(post(cooBody()));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('store.listing_assistant.failed', { code: 'not_configured' });
  });

  it('20 秒で 504 timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = POST(post(cooBody()));
    await vi.advanceTimersByTimeAsync(20_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('出品者の GET: listingAssistant', () => {
  it('フラグ ON かつ運営者なら true', async () => {
    const response = await getSeller(new Request('https://open-pay.jp/api/store/seller'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, seller: null, listingAssistant: true });
  });

  it.each([
    ['アシスタントのフラグ OFF', () => { vi.stubEnv('ENABLE_STORE_LISTING_ASSISTANT', ''); }],
    ['運営者でない', () => { vi.stubEnv('ADMIN_WALLETS', OTHER); }],
    ['ADMIN_WALLETS が空', () => { vi.stubEnv('ADMIN_WALLETS', ''); }],
  ])('%s なら false', async (_label, setup) => {
    setup();
    const response = await getSeller(new Request('https://open-pay.jp/api/store/seller'));
    expect(await response.json()).toEqual({ ok: true, seller: null, listingAssistant: false });
  });
});
