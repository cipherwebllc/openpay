import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { callListKey } from '@/lib/orderRelay';
import { orderTokenKey, orderTokenRevKey } from '@/lib/orderToken';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TOKEN = 'a'.repeat(43);

const hold = vi.hoisted(() => ({
  enabled: true,
  tokenEnabled: false,
  configured: true,
  signedIn: true,
  rows: [] as string[],
  kv: {} as Record<string, string | null>,
  lastRangeKey: '',
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderCall() {
        return hold.enabled;
      },
      get enableOrderToken() {
        return hold.tokenEnabled;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.signedIn
      ? { ok: true, address: MERCHANT }
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.configured,
  kvGet: async (key: string) => ({
    ok: true,
    value: key in hold.kv ? hold.kv[key] : null,
  }),
  kvLrange: async (key: string) => {
    hold.lastRangeKey = key;
    return { ok: true, value: hold.rows };
  },
  kvEval: async (_script: string, _keys: string[], args: string[]) => {
    const before = hold.rows.length;
    hold.rows = hold.rows.filter((raw) => {
      try {
        return JSON.parse(raw).id !== args[0];
      } catch {
        return true;
      }
    });
    return { ok: true, value: before - hold.rows.length };
  },
}));

import { GET, POST } from '@/app/api/order/calls/route';

function get(headers?: Record<string, string>) {
  return new Request('http://localhost/api/order/calls', { headers });
}

function post(id: string, headers?: Record<string, string>) {
  return new Request('http://localhost/api/order/calls', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id, done: true }),
  });
}

beforeEach(() => {
  hold.enabled = true;
  hold.tokenEnabled = false;
  hold.configured = true;
  hold.signedIn = true;
  hold.rows = [];
  hold.kv = {};
  hold.lastRangeKey = '';
});

describe('/api/order/calls', () => {
  it('SIWE 未認証は 401、認証時は session merchant だけを読む', async () => {
    hold.signedIn = false;
    expect((await GET(get())).status).toBe(401);
    hold.signedIn = true;
    expect((await GET(get())).status).toBe(200);
    expect(hold.lastRangeKey).toBe(callListKey(MERCHANT));
  });

  it('店員 token は reverse lookup + 現行一致で認可し、旧 token は 401', async () => {
    hold.tokenEnabled = true;
    hold.signedIn = false;
    hold.kv[orderTokenRevKey(TOKEN)] = MERCHANT;
    hold.kv[orderTokenKey(MERCHANT)] = TOKEN;
    expect((await GET(get({ 'x-order-token': TOKEN }))).status).toBe(200);
    hold.kv[orderTokenKey(MERCHANT)] = 'b'.repeat(43);
    expect((await GET(get({ 'x-order-token': TOKEN }))).status).toBe(401);
  });

  it('GET は 15分以内だけを返し、不正 raw を除外して新しい順', async () => {
    const now = Date.now();
    hold.rows = [
      JSON.stringify({ id: 'new', handle: 'coffee', table: '2', ts: now - 1_000 }),
      'bad-json',
      JSON.stringify({ id: 'old', handle: 'coffee', table: '1', ts: now - 16 * 60_000 }),
      JSON.stringify({ id: 'middle', handle: 'coffee', table: '3', ts: now - 60_000 }),
    ];
    const json = await (await GET(get())).json();
    expect(json.calls.map((call: { id: string }) => call.id)).toEqual(['new', 'middle']);
  });

  // C11: 店主固有の呼出一覧を共有キャッシュ (CDN/proxy) に載せない。
  it('GET 成功応答に Cache-Control: private, no-store', async () => {
    const res = await GET(get());
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('POST {id,done:true} は原子削除し、再実行は removed=0 の冪等', async () => {
    hold.rows = [JSON.stringify({ id: 'call-1', handle: 'coffee', table: '2', ts: Date.now() })];
    const first = await POST(post('call-1'));
    expect(await first.json()).toMatchObject({ ok: true, removed: 1 });
    const second = await POST(post('call-1'));
    expect(await second.json()).toMatchObject({ ok: true, removed: 0 });
  });
});
