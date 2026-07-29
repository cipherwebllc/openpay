import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const STRANGER = '0x9999999999999999999999999999999999999999';
const TX = `0x${'a'.repeat(64)}`;

const state = vi.hoisted(() => ({
  enabled: true,
}));
const requireSession = vi.hoisted(() => vi.fn());
const checkIpRateLimit = vi.hoisted(() => vi.fn());
const clientIp = vi.hoisted(() => vi.fn(() => '203.0.113.10'));
const hashIp = vi.hoisted(() => vi.fn(() => 'hashed-ip'));
const listTipMessages = vi.hoisted(() => vi.fn());
const deleteTipMessages = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', () => ({
  env: {
    get enableTipMessage() {
      return state.enabled;
    },
  },
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession,
}));
vi.mock('@/lib/net/ipHash', () => ({
  clientIp,
  hashIp,
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit,
}));
vi.mock('@/lib/tipMessages', () => ({
  listTipMessages,
  deleteTipMessages,
}));

import {
  DELETE,
  GET,
  dynamic,
} from '@/app/api/tip-messages/route';

function request(method = 'GET', query = ''): Request {
  return new Request(`https://open-pay.jp/api/tip-messages${query}`, {
    method,
    headers: { 'x-vercel-forwarded-for': '203.0.113.10' },
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

beforeEach(() => {
  state.enabled = true;
  requireSession.mockReset();
  requireSession.mockResolvedValue({ ok: true, address: OWNER });
  checkIpRateLimit.mockReset();
  checkIpRateLimit.mockResolvedValue(true);
  clientIp.mockClear();
  hashIp.mockClear();
  listTipMessages.mockReset();
  listTipMessages.mockResolvedValue([]);
  deleteTipMessages.mockReset();
  deleteTipMessages.mockResolvedValue(true);
});

describe('/api/tip-messages', () => {
  it('force-dynamic で private inbox の静的化を防ぐ', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('flag OFF は GET/DELETE とも 404 + private no-store で完全 inert', async () => {
    state.enabled = false;

    const getResponse = await GET(request());
    const deleteResponse = await DELETE(request('DELETE'));

    expect(getResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expectPrivate(getResponse);
    expectPrivate(deleteResponse);
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(requireSession).not.toHaveBeenCalled();
    expect(listTipMessages).not.toHaveBeenCalled();
    expect(deleteTipMessages).not.toHaveBeenCalled();
  });

  it('判定順は flag → IP limiter → session、制限時は 429 + Retry-After', async () => {
    checkIpRateLimit.mockResolvedValue(false);

    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(checkIpRateLimit).toHaveBeenCalledWith(
      'tip-messages',
      'hashed-ip',
      30,
      60,
    );
    expect(requireSession).not.toHaveBeenCalled();
    expect(listTipMessages).not.toHaveBeenCalled();
  });

  it('IP limiter 障害は fail-open し、owner SIWE + inbox read を続行する', async () => {
    checkIpRateLimit.mockRejectedValue(new Error('limiter unavailable'));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(requireSession).toHaveBeenCalledOnce();
    expect(listTipMessages).toHaveBeenCalledWith(OWNER);
    expectPrivate(response);
  });

  it('未サインインは 401 の requireSession 応答にも private no-store を上書きする', async () => {
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'unauthenticated' },
        { status: 401, headers: { 'Cache-Control': 'public, max-age=60' } },
      ),
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(listTipMessages).not.toHaveBeenCalled();
  });

  it('SIWE storage 障害の 503 応答にも private no-store を付ける', async () => {
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'session_storage_unavailable' },
        { status: 503 },
      ),
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expectPrivate(response);
  });

  it('GET は query の他人 address を無視し、session owner の inbox だけを返す', async () => {
    listTipMessages.mockResolvedValue([
      {
        from: STRANGER,
        to: OWNER,
        amountWei: '1000000000000000000',
        chainId: 137,
        txHash: TX,
        message: '質問です',
        ts: 1_700_000_000_000,
      },
    ]);

    const response = await GET(
      request('GET', `?address=${STRANGER}`),
    );

    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(listTipMessages).toHaveBeenCalledWith(OWNER);
    expect(await response.json()).toEqual({
      items: [
        {
          from: STRANGER,
          amountWei: '1000000000000000000',
          chainId: 137,
          txHash: TX,
          message: '質問です',
          ts: 1_700_000_000_000,
        },
      ],
    });
  });

  it('GET の KV 障害は空 inbox に偽装せず 503 + private no-store', async () => {
    listTipMessages.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage_unavailable' });
    expectPrivate(response);
  });

  it('DELETE は body/query の address を受けず session owner の全件だけを削除する', async () => {
    const response = await DELETE(
      request('DELETE', `?address=${STRANGER}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deleteTipMessages).toHaveBeenCalledWith(OWNER);
    expectPrivate(response);
  });

  it('DELETE の KV 障害は 503 + private no-store', async () => {
    deleteTipMessages.mockResolvedValue(false);

    const response = await DELETE(request('DELETE'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage_unavailable' });
    expectPrivate(response);
  });
});
