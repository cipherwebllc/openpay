import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// KV は hoisted ホルダで制御 (grant は実 grantEntitlement → 実 lib/kv 経路を走らせる)。
const kv = vi.hoisted(() => ({
  get: vi.fn(async () => ({ ok: true, value: null as string | null })),
  set: vi.fn(async () => ({ ok: true, value: 'OK' as 'OK' | null })),
  del: vi.fn(async () => ({ ok: true, value: 1 })),
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: (...a: unknown[]) => kv.get(...(a as [])),
  kvSet: (...a: unknown[]) => kv.set(...(a as [])),
  kvDel: (...a: unknown[]) => kv.del(...(a as [])),
}));

// status は SIWE 必須。requireSession を差し替え (admin grant は requireAdminAuth=実コード)。
const session = vi.hoisted(() => ({
  ok: false as boolean,
  address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    session.ok
      ? { ok: true, address: session.address }
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));

import { GET as statusGET } from '@/app/api/entitlement/status/route';
import { POST as grantPOST } from '@/app/api/entitlement/grant/route';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const DAY = 86_400_000;

const ORIG_TOKEN = process.env.PAYMENT_LOG_ADMIN_TOKEN;
const ORIG_BYPASS = process.env.ALPHA_ENTITLEMENT_BYPASS;

beforeEach(() => {
  kv.get.mockReset().mockResolvedValue({ ok: true, value: null });
  kv.set.mockReset().mockResolvedValue({ ok: true, value: 'OK' });
  kv.del.mockReset().mockResolvedValue({ ok: true, value: 1 });
  session.ok = false;
  delete process.env.ALPHA_ENTITLEMENT_BYPASS; // 既定 = bypass on
});
afterEach(() => {
  if (ORIG_TOKEN === undefined) delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
  else process.env.PAYMENT_LOG_ADMIN_TOKEN = ORIG_TOKEN;
  if (ORIG_BYPASS === undefined) delete process.env.ALPHA_ENTITLEMENT_BYPASS;
  else process.env.ALPHA_ENTITLEMENT_BYPASS = ORIG_BYPASS;
});

function grantReq(auth?: string, body: unknown = { wallet: WALLET }): Request {
  return new Request('http://localhost/api/entitlement/grant', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /api/entitlement/status', () => {
  it('未ログイン → 401', async () => {
    session.ok = false;
    const res = await statusGET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('ログイン済 + bypass on (既定) → 200 entitled pro・KV を読まない', async () => {
    session.ok = true;
    const res = await statusGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      entitled: true,
      tier: 'pro',
      expiresAt: null,
      bypass: true,
    });
    expect(kv.get).not.toHaveBeenCalled(); // bypass は短絡
  });

  it('ログイン済 + bypass off + 保存済 basic(未来満了) → 200 tier:basic', async () => {
    session.ok = true;
    process.env.ALPHA_ENTITLEMENT_BYPASS = '0';
    const expiresAt = Date.now() + 10 * DAY;
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'basic', expiresAt }),
    });
    const res = await statusGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      entitled: true,
      tier: 'basic',
      expiresAt,
      bypass: false,
    });
  });
});

describe('POST /api/entitlement/grant', () => {
  it('admin token 未設定 → 503 admin_token_not_configured', async () => {
    delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
    const res = await grantPOST(grantReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'admin_token_not_configured' });
  });

  it('誤った Bearer → 401 unauthorized', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    const res = await grantPOST(grantReq('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('正規 auth + 本文が JSON でない → 400 invalid_json', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    const res = await grantPOST(grantReq('Bearer secret', '{bad'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('正規 auth + 不正 wallet → 400 invalid_wallet', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    const res = await grantPOST(grantReq('Bearer secret', { wallet: '0x0' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_wallet' });
  });

  it('正規 auth + 既定 (tier 省略=pro・days 省略=30) → 200・付与内容を検査', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    const before = Date.now();
    const res = await grantPOST(grantReq('Bearer secret', { wallet: WALLET }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      wallet: string;
      tier: string;
      days: number;
      expiresAt: number;
    };
    expect(json.ok).toBe(true);
    expect(json.wallet).toBe(WALLET); // checksummed
    expect(json.tier).toBe('pro');
    expect(json.days).toBe(30);
    // expiresAt ≈ now + 30 日 (実時計のため窓で確認)
    expect(json.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(json.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY + 5_000);
    // KV へ JSON で永続化
    expect(kv.set).toHaveBeenCalledOnce();
    const [key, value] = kv.set.mock.calls[0] as unknown as [string, string, unknown];
    expect(key).toBe(`entitlement:${WALLET.toLowerCase()}`);
    expect(JSON.parse(value)).toMatchObject({ tier: 'pro' });
  });

  it('正規 auth + tier=basic・days=7 → 200 tier:basic days:7', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    const res = await grantPOST(
      grantReq('Bearer secret', { wallet: WALLET, tier: 'basic', days: 7 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tier: 'basic', days: 7 });
  });

  it('KV 書込失敗 (永続化できず) → 503 grant_failed', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    kv.set.mockResolvedValue({ ok: false, value: null }); // 書込 NG
    kv.get.mockResolvedValue({ ok: true, value: null }); // read-back も未 landed
    const res = await grantPOST(grantReq('Bearer secret', { wallet: WALLET }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'grant_failed' });
  });
});
