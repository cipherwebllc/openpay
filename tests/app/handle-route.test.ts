import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

// env.enableHandles / KV / session / store を制御するための hoisted state。
const h = vi.hoisted(() => ({
  enableHandles: true,
  kvConfigured: true,
  authed: true,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
    },
  };
});
vi.mock('@/lib/kv', () => ({ isKvConfigured: () => h.kvConfigured }));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    h.authed
      ? { ok: true, address: OWNER }
      : {
          ok: false,
          response: new Response(
            JSON.stringify({ ok: false, error: 'unauthenticated' }),
            { status: 401 },
          ),
        },
}));

const store = vi.hoisted(() => ({
  reserveOrUpdateHandle: vi.fn(),
  listHandlesForOwner: vi.fn(),
  listHandleRecordsForOwner: vi.fn(),
  resolveHandle: vi.fn(),
  releaseHandle: vi.fn(),
}));
vi.mock('@/lib/handleStore', () => store);

import { GET as mineGET, POST } from '@/app/api/handle/route';
import { GET as availGET, DELETE } from '@/app/api/handle/[handle]/route';

const ADDR = OWNER;
// 新スキーマの最小有効 config (マルチ方法)。
const CFG = { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }] };
function postReq(body: unknown) {
  return new Request('http://localhost/api/handle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = (handle: string) => ({ params: Promise.resolve({ handle }) });

beforeEach(() => {
  h.enableHandles = true;
  h.kvConfigured = true;
  h.authed = true;
  vi.clearAllMocks();
});

describe('POST /api/handle', () => {
  it('flag OFF → 404 (inert) and never touches the store', async () => {
    h.enableHandles = false;
    const res = await POST(postReq({ handle: 'alice', config: CFG }));
    expect(res.status).toBe(404);
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401', async () => {
    h.authed = false;
    const res = await POST(postReq({ handle: 'alice', config: CFG }));
    expect(res.status).toBe(401);
  });

  it('reserve success → 201 with owner from session', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({ status: 'created' });
    const res = await POST(postReq({ handle: '@Alice', config: CFG }));
    expect(res.status).toBe(201);
    const call = store.reserveOrUpdateHandle.mock.calls[0][0];
    expect(call.handle).toBe('alice'); // normalized
    expect(call.owner).toBe(OWNER);
    expect(call.config.methods[0].token).toBe('jpyc');
  });

  it('passes a validated profile through to the store', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({ status: 'created' });
    await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: { bio: 'hi', links: [{ label: 'X', url: 'https://x.com/a' }] },
      }),
    );
    const call = store.reserveOrUpdateHandle.mock.calls[0][0];
    expect(call.profile).toEqual({
      bio: 'hi',
      links: [{ label: 'X', url: 'https://x.com/a' }],
    });
  });

  it('invalid profile (non-https link) → 400 invalid_profile, no store hit', async () => {
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: { links: [{ label: 'x', url: 'http://insecure' }] },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_profile');
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });

  it('taken → 409, limit → 409', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({ status: 'taken' });
    expect((await POST(postReq({ handle: 'alice', config: CFG }))).status).toBe(409);
    store.reserveOrUpdateHandle.mockResolvedValue({ status: 'limit' });
    expect((await POST(postReq({ handle: 'bob', config: CFG }))).status).toBe(409);
  });

  it('reserved handle → 400 (reserved) without hitting the store', async () => {
    const res = await POST(postReq({ handle: 'pay', config: CFG }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('reserved');
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });

  it('invalid config → 400 (invalid_config) without hitting the store', async () => {
    const res = await POST(postReq({ handle: 'alice', config: { to: '0xnope', token: 'jpyc' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_config');
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });
});

describe('GET /api/handle (mine)', () => {
  it('flag OFF → 404', async () => {
    h.enableHandles = false;
    expect((await mineGET()).status).toBe(404);
  });
  it('returns owned handles with config/profile (for edit prefill)', async () => {
    store.listHandleRecordsForOwner.mockResolvedValue([
      {
        handle: 'alice',
        record: {
          owner: OWNER,
          config: CFG,
          profile: { bio: 'hi' },
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ]);
    const res = await mineGET();
    const json = await res.json();
    expect(json.handles).toEqual([
      { handle: 'alice', config: CFG, profile: { bio: 'hi' }, updatedAt: 2 },
    ]);
    expect(json.max).toBe(3);
  });
  it('KV エラー (null) → 502', async () => {
    store.listHandleRecordsForOwner.mockResolvedValue(null);
    expect((await mineGET()).status).toBe(502);
  });
});

describe('GET /api/handle/[handle] (availability)', () => {
  it('public: available when unclaimed', async () => {
    store.resolveHandle.mockResolvedValue({ ok: true, record: null });
    const res = await availGET(new Request('http://x'), params('alice'));
    const json = await res.json();
    expect(json.available).toBe(true);
  });
  it('KV エラーは available:false reason:unavailable (空きと誤答しない)', async () => {
    store.resolveHandle.mockResolvedValue({ ok: false });
    const res = await availGET(new Request('http://x'), params('alice'));
    const json = await res.json();
    expect(json.available).toBe(false);
    expect(json.reason).toBe('unavailable');
  });
  it('reserved word → available:false reason:reserved (no store hit)', async () => {
    const res = await availGET(new Request('http://x'), params('pay'));
    const json = await res.json();
    expect(json.available).toBe(false);
    expect(json.reason).toBe('reserved');
    expect(store.resolveHandle).not.toHaveBeenCalled();
  });
  it('flag OFF → 404', async () => {
    h.enableHandles = false;
    expect((await availGET(new Request('http://x'), params('alice'))).status).toBe(404);
  });
});

describe('DELETE /api/handle/[handle]', () => {
  it('forbidden (not owner) → 403', async () => {
    store.releaseHandle.mockResolvedValue('forbidden');
    expect((await DELETE(new Request('http://x'), params('alice'))).status).toBe(403);
  });
  it('released → 200', async () => {
    store.releaseHandle.mockResolvedValue('released');
    expect((await DELETE(new Request('http://x'), params('alice'))).status).toBe(200);
  });
  it('unauthenticated → 401', async () => {
    h.authed = false;
    expect((await DELETE(new Request('http://x'), params('alice'))).status).toBe(401);
  });
});
