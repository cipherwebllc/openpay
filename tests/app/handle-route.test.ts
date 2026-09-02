import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

// env.enableHandles / KV / session / store を制御するための hoisted state。
const h = vi.hoisted(() => ({
  enableHandles: true,
  kvConfigured: true,
  authed: true,
  rateLimitAllowed: true,
}));

vi.mock('@/lib/relay/relayGuards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/relay/relayGuards')>();
  return { ...actual, checkReadRateLimit: async () => h.rateLimitAllowed };
});

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
const YOUTUBE_ID = 'dQw4w9WgXcQ';
const SPOTIFY_ID = '0123456789ABCDEFGHIJKL';
const AUDIUS_URL = 'https://audius.co/openpay/test-track';
const AUDIUS_ID = 'AbC123xYz';
// 新スキーマの最小有効 config (マルチ方法)。
const CFG = { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }] };
const savedRecord = (updatedAt: number) => ({
  owner: OWNER,
  config: CFG,
  createdAt: 1,
  updatedAt,
});
// 最小有効 storefront (店舗固有部分のみ・identity は handle 由来)。
const STORE = {
  chain: 'polygon',
  mode: 'storefront',
  feePayer: 'merchant',
  menu: [{ id: 'a', name: 'A', price: '500' }],
};
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
  h.rateLimitAllowed = true;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'created',
      record: savedRecord(101),
    });
    const res = await POST(postReq({ handle: '@Alice', config: CFG }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      status: 'created',
      updatedAt: 101,
    });
    const call = store.reserveOrUpdateHandle.mock.calls[0][0];
    expect(call.handle).toBe('alice'); // normalized
    expect(call.owner).toBe(OWNER);
    expect(call.config.methods[0].token).toBe('jpyc');
    expect(call.expectedUpdatedAt).toBeUndefined();
  });

  it('passes a validated profile through to the store', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'created',
      record: savedRecord(101),
    });
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

  it('passes normalized link image/embed fields through the HTTP boundary', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'created',
      record: savedRecord(101),
    });
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: {
          links: [
            {
              label: ' Image ',
              url: ' https://example.com ',
              imageUrl: ' https://images.example/card.png ',
            },
            {
              label: 'Video',
              url: `https://youtu.be/${YOUTUBE_ID}?si=share`,
              embed: true,
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].profile).toEqual({
      links: [
        {
          label: 'Image',
          url: 'https://example.com',
          imageUrl: 'https://images.example/card.png',
        },
        {
          label: 'Video',
          url: `https://youtu.be/${YOUTUBE_ID}?si=share`,
          embed: true,
        },
      ],
    });
  });

  it('resolves an Audius track from a manual 302 Location and stores only the server ID', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'created',
      record: savedRecord(101),
    });
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: {
          // undici fetch の実挙動は相対 Location (2026-08-01 実機確認)。絶対化して検証すること。
          location: `/v1/tracks/${AUDIUS_ID}?app_name=openpay`,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: {
          links: [
            {
              label: 'Audius',
              url: AUDIUS_URL,
              embed: true,
              embedResolved: {
                provider: 'audius',
                kind: 'track',
                id: 'Forged999',
              },
            },
            {
              label: 'Video',
              url: `https://youtu.be/${YOUTUBE_ID}`,
              embed: true,
              embedResolved: {
                provider: 'audius',
                kind: 'track',
                id: 'Forged888',
              },
            },
            {
              label: 'Plain',
              url: 'https://example.com',
              embedResolved: {
                provider: 'audius',
                kind: 'track',
                id: 'Forged777',
              },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.audius.co/v1/resolve?url=${encodeURIComponent(AUDIUS_URL)}&app_name=openpay`,
      {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      },
    );
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].profile).toEqual({
      links: [
        {
          label: 'Audius',
          url: AUDIUS_URL,
          embed: true,
          embedResolved: {
            provider: 'audius',
            kind: 'track',
            id: AUDIUS_ID,
          },
        },
        {
          label: 'Video',
          url: `https://youtu.be/${YOUTUBE_ID}`,
          embed: true,
        },
        { label: 'Plain', url: 'https://example.com' },
      ],
    });
  });

  it.each([
    ['non-302 response', 200, null],
    [
      'different Location host',
      302,
      `https://evil.example/v1/tracks/${AUDIUS_ID}?x=1`,
    ],
    [
      'non-track Location',
      302,
      `https://api.audius.co/v1/users/${AUDIUS_ID}?x=1`,
    ],
    ['missing Location', 302, null],
    ['too-short ID', 302, 'https://api.audius.co/v1/tracks/Ab?x=1'],
    [
      'too-long ID',
      302,
      'https://api.audius.co/v1/tracks/AbcdefghijklmnoPQ?x=1',
    ],
    [
      'invalid ID character',
      302,
      'https://api.audius.co/v1/tracks/Abc-123?x=1',
    ],
  ])(
    'rejects Audius resolve with %s before storing',
    async (_case, status, location) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(null, {
            status,
            headers: location ? { location } : undefined,
          }),
        ),
      );

      const res = await POST(
        postReq({
          handle: 'alice',
          config: CFG,
          profile: {
            links: [{ label: 'Audius', url: AUDIUS_URL, embed: true }],
          },
        }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: 'audius resolve failed',
      });
      expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
    },
  );

  it('turns an Audius resolve timeout into the exact save error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    );
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: {
          links: [{ label: 'Audius', url: AUDIUS_URL, embed: true }],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'audius resolve failed',
    });
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });

  it('does not let a forged Audius ID bypass a failed resolve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: {
          links: [
            {
              label: 'Audius',
              url: AUDIUS_URL,
              embed: true,
              embedResolved: {
                provider: 'audius',
                kind: 'track',
                id: AUDIUS_ID,
              },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('audius resolve failed');
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });

  it('enforces the provider-combined embed cap before any Audius fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: {
          links: [
            {
              label: 'Video',
              url: `https://youtu.be/${YOUTUBE_ID}`,
              embed: true,
            },
            {
              label: 'Spotify',
              url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
              embed: true,
            },
            { label: 'Audius 1', url: AUDIUS_URL, embed: true },
            {
              label: 'Audius 2',
              url: 'https://audius.co/openpay/second-track',
              embed: true,
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'invalid_profile',
      detail: 'too many embeds',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
  });

  it('re-resolves the same Audius URL on every explicit profile save', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'updated',
      record: savedRecord(201),
    });
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: `https://api.audius.co/v1/tracks/${AUDIUS_ID}/stream`,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const body = {
      handle: 'alice',
      config: CFG,
      profile: {
        links: [{ label: 'Audius', url: AUDIUS_URL, embed: true }],
      },
      expectedUpdatedAt: 200,
    };

    expect((await POST(postReq(body))).status).toBe(200);
    expect((await POST(postReq(body))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes a validated heading through the HTTP boundary to the store', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'created',
      record: savedRecord(101),
    });
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        profile: {
          links: [
            { kind: 'heading', label: ' Projects ', emoji: ' 📌 ' },
            { label: 'X', url: 'https://x.com/a', featured: true },
          ],
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].profile).toEqual({
      links: [
        { kind: 'heading', label: 'Projects', emoji: '📌' },
        { label: 'X', url: 'https://x.com/a', featured: true },
      ],
    });
  });

  it.each([
    [
      'url property',
      { kind: 'heading', label: 'Projects', url: 'https://example.com' },
    ],
    [
      'featured property',
      { kind: 'heading', label: 'Projects', featured: false },
    ],
    [
      'imageUrl property',
      { kind: 'heading', label: 'Projects', imageUrl: '' },
    ],
    ['embed property', { kind: 'heading', label: 'Projects', embed: false }],
    ['unknown kind', { kind: 'divider', label: 'Projects' }],
  ])(
    'rejects heading with %s before the store boundary',
    async (_case, link) => {
      const res = await POST(
        postReq({
          handle: 'alice',
          config: CFG,
          profile: { links: [link] },
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_profile');
      expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    [
      'unsupported embed',
      [{ label: 'Site', url: 'https://example.com', embed: true }],
      'embed not supported for this url',
    ],
    [
      'four embeds',
      [
        ...Array.from({ length: 3 }, (_, index) => ({
          label: `Video ${index}`,
          url: `https://youtu.be/${YOUTUBE_ID}?n=${index}`,
          embed: true,
        })),
        {
          label: 'Song',
          url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
          embed: true,
        },
      ],
      'too many embeds',
    ],
  ])(
    'rejects %s before the store boundary with the exact detail',
    async (_case, links, detail) => {
      const res = await POST(
        postReq({ handle: 'alice', config: CFG, profile: { links } }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: 'invalid_profile',
        detail,
      });
      expect(store.reserveOrUpdateHandle).not.toHaveBeenCalled();
    },
  );

  it('passes a validated storefront through to the store (店舗公開)', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'updated',
      record: savedRecord(201),
    });
    await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        storefront: STORE,
        expectedUpdatedAt: 200,
      }),
    );
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].storefront).toEqual(STORE);
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].expectedUpdatedAt).toBe(200);
  });

  it('storefront:null → null (clear) を store へ渡す (店舗取り下げ)', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'updated',
      record: savedRecord(201),
    });
    await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        storefront: null,
        expectedUpdatedAt: 200,
      }),
    );
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].storefront).toBeNull();
  });

  it('storefront 省略 → undefined を渡す (既存保持)', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'updated',
      record: savedRecord(201),
    });
    const res = await POST(
      postReq({ handle: 'alice', config: CFG, expectedUpdatedAt: 200 }),
    );
    expect(store.reserveOrUpdateHandle.mock.calls[0][0].storefront).toBeUndefined();
    expect(await res.json()).toMatchObject({
      status: 'updated',
      updatedAt: 201,
    });
  });

  it('掲載 index 満杯でも publish は成功し listing:index_full を明示する', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({
      status: 'updated',
      record: savedRecord(201),
      listing: 'index_full',
    });
    const res = await POST(
      postReq({
        handle: 'alice',
        config: CFG,
        storefront: { ...STORE, agentListing: true },
        expectedUpdatedAt: 200,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: 'updated',
      updatedAt: 201,
      listing: 'index_full',
    });
  });

  it('既存更新の expectedUpdatedAt 欠落/不一致 → 409 conflict', async () => {
    store.reserveOrUpdateHandle.mockResolvedValue({ status: 'conflict' });
    const missing = await POST(postReq({ handle: 'alice', config: CFG }));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ ok: false, error: 'conflict' });
    expect(
      store.reserveOrUpdateHandle.mock.calls[0][0].expectedUpdatedAt,
    ).toBeUndefined();

    const stale = await POST(
      postReq({ handle: 'alice', config: CFG, expectedUpdatedAt: 199 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, error: 'conflict' });
    expect(store.reserveOrUpdateHandle.mock.calls[1][0].expectedUpdatedAt).toBe(199);
  });

  it('invalid storefront (JPYC でない chain) → 400 invalid_storefront, no store hit', async () => {
    const res = await POST(
      postReq({ handle: 'alice', config: CFG, storefront: { ...STORE, chain: 'base' } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_storefront');
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
  it('includes storefront in mine when published (公開済み prefill)', async () => {
    store.listHandleRecordsForOwner.mockResolvedValue([
      {
        handle: 'shop',
        record: { owner: OWNER, config: CFG, storefront: STORE, createdAt: 1, updatedAt: 2 },
      },
    ]);
    const json = await (await mineGET()).json();
    expect(json.handles[0].storefront).toEqual(STORE);
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
  // C10: 無認証・無制限の read は @handle 空間の総当り列挙と KV read 圧力を招く。
  // IP 固定窓を store 参照の前に置く (429・列挙結果は返さない)。
  it('IP 固定窓の上限超過 → 429 rate_limited (store に触れない)', async () => {
    h.rateLimitAllowed = false;
    const res = await availGET(new Request('http://x'), params('alice'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(store.resolveHandle).not.toHaveBeenCalled();
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
