// lib/orderFeedAuth.ts (受注フィード/呼び出しの店側主体解決) の単体検証。
// このモジュールは「店員トークンでどこまで通すか」を決める認可の要なので、
// トークン経路 / SIWE 経路 / どちらも無い場合の分岐と、rotate/revoke 済トークンの即時失効、
// KV 障害を成功に丸めないこと、返す merchant が checksum 正規化されることを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const MERCHANT_LOWER = '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
const MERCHANT_CHECKSUM = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TOKEN = 'a'.repeat(43);

const hold = vi.hoisted(() => ({
  enableOrderToken: true,
  kv: new Map<string, string | null>(),
  kvFailures: new Set<string>(),
  session: null as
    | { ok: true; address: string }
    | { ok: false; response: unknown }
    | null,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderToken() {
        return hold.enableOrderToken;
      },
    },
  };
});

vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) =>
    hold.kvFailures.has(key)
      ? { ok: false, reason: 'kv_error' }
      : { ok: true, value: hold.kv.get(key) ?? null },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => hold.session,
}));

import { resolveOrderFeedMerchant } from '@/lib/orderFeedAuth';
import { orderTokenKey, orderTokenRevKey } from '@/lib/orderToken';

function req(token?: string): Request {
  return new Request('http://localhost/api/order/feed', {
    method: 'POST',
    headers: token ? { 'x-order-token': token } : {},
  });
}

beforeEach(() => {
  hold.enableOrderToken = true;
  hold.kv = new Map();
  hold.kvFailures = new Set();
  hold.session = {
    ok: false,
    response: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
  };
});

describe('resolveOrderFeedMerchant', () => {
  it('有効なトークン → merchant を checksum 正規化して返す (SIWE には触れない)', async () => {
    hold.kv.set(orderTokenRevKey(TOKEN), MERCHANT_LOWER);
    hold.kv.set(orderTokenKey(MERCHANT_CHECKSUM), TOKEN);

    const actor = await resolveOrderFeedMerchant(req(TOKEN));

    expect(actor).toEqual({ merchant: MERCHANT_CHECKSUM });
  });

  it('SIWE セッション所有者 → そのアドレスを merchant にする (トークン無し)', async () => {
    hold.session = { ok: true, address: MERCHANT_CHECKSUM };

    const actor = await resolveOrderFeedMerchant(req());

    expect(actor).toEqual({ merchant: MERCHANT_CHECKSUM });
  });

  it('トークンも有効セッションも無い → 主体は解決されず 401 応答を返す', async () => {
    const actor = await resolveOrderFeedMerchant(req());

    expect('response' in actor).toBe(true);
    const res = (actor as { response: NextResponse }).response;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('形式不正なトークンは KV を引かずに 401 (invalid_token)', async () => {
    const actor = await resolveOrderFeedMerchant(req('short'));

    const res = (actor as { response: NextResponse }).response;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_token' });
  });

  it('reverse lookup が無い / アドレスでない → 401', async () => {
    const missing = (await resolveOrderFeedMerchant(req(TOKEN))) as {
      response: NextResponse;
    };
    expect(missing.response.status).toBe(401);

    hold.kv.set(orderTokenRevKey(TOKEN), 'not-an-address');
    const broken = (await resolveOrderFeedMerchant(req(TOKEN))) as {
      response: NextResponse;
    };
    expect(broken.response.status).toBe(401);
  });

  it('rotate/revoke 済 (merchant の現行トークンと不一致) は即時失効 → 401', async () => {
    hold.kv.set(orderTokenRevKey(TOKEN), MERCHANT_LOWER);
    hold.kv.set(orderTokenKey(MERCHANT_CHECKSUM), 'b'.repeat(43));

    const actor = (await resolveOrderFeedMerchant(req(TOKEN))) as {
      response: NextResponse;
    };

    expect(actor.response.status).toBe(401);
    expect(await actor.response.json()).toEqual({ ok: false, error: 'invalid_token' });
  });

  it('KV 障害は成功にも 401 にも丸めず 503 (kv_error)', async () => {
    hold.kvFailures.add(orderTokenRevKey(TOKEN));
    const revFail = (await resolveOrderFeedMerchant(req(TOKEN))) as {
      response: NextResponse;
    };
    expect(revFail.response.status).toBe(503);
    expect(await revFail.response.json()).toEqual({ ok: false, error: 'kv_error' });

    hold.kvFailures.clear();
    hold.kv.set(orderTokenRevKey(TOKEN), MERCHANT_LOWER);
    hold.kvFailures.add(orderTokenKey(MERCHANT_CHECKSUM));
    const currentFail = (await resolveOrderFeedMerchant(req(TOKEN))) as {
      response: NextResponse;
    };
    expect(currentFail.response.status).toBe(503);
  });

  it('flag OFF ではトークンヘッダを無視して SIWE 経路へ落ちる', async () => {
    hold.enableOrderToken = false;
    hold.kv.set(orderTokenRevKey(TOKEN), MERCHANT_LOWER);
    hold.kv.set(orderTokenKey(MERCHANT_CHECKSUM), TOKEN);
    hold.session = { ok: true, address: MERCHANT_CHECKSUM };

    const actor = await resolveOrderFeedMerchant(req(TOKEN));

    expect(actor).toEqual({ merchant: MERCHANT_CHECKSUM });
  });
});
