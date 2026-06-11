import { describe, it, expect, vi, beforeEach } from 'vitest';

// KV 未設定 + セッション無し (cookie 無し) を固定。token 交換/同期の本体は
// lib/freee (freee.test) と lib/freeeSync (freeeSync.test) で担保。ここは route ガードを確認。
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => false,
  kvGet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvSet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvDel: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const flags = vi.hoisted(() => ({ enableFreeeSync: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (target, prop) =>
        prop === 'enableFreeeSync' ? flags.enableFreeeSync : Reflect.get(target, prop),
    }),
  };
});

import { GET as authorizeGET } from '@/app/api/freee/authorize/route';
import { GET as callbackGET } from '@/app/api/freee/callback/route';
import { GET as statusGET } from '@/app/api/freee/status/route';
import { GET as mappingGET, POST as mappingPOST } from '@/app/api/freee/mapping/route';
import { POST as syncPOST } from '@/app/api/freee/sync/route';

describe('freee routes ガード', () => {
  beforeEach(() => {
    flags.enableFreeeSync = true;
  });
  it('authorize: KV 未設定 → 503 kv_not_configured', async () => {
    const res = await authorizeGET(
      new Request('http://localhost/api/freee/authorize?returnTo=/ja/history'),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('callback: code/state 無し → / へ freee=error リダイレクト', async () => {
    const res = await callbackGET(new Request('http://localhost/api/freee/callback'));
    expect(res.status).toBe(307); // NextResponse.redirect default
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('freee=error');
    expect(loc).toContain('reason=missing_params');
  });

  it('status: 未ログイン → 401 unauthenticated', async () => {
    const res = await statusGET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('mapping GET: 未ログイン → 401', async () => {
    const res = await mappingGET();
    expect(res.status).toBe(401);
  });

  it('sync: 未ログイン → 401 (entitlement/freee に到達しない)', async () => {
    const res = await syncPOST(
      new Request('http://localhost/api/freee/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('freee kill-switch (flag OFF)', () => {
  beforeEach(() => {
    flags.enableFreeeSync = false;
  });

  it('authorize GET → 503 freee_disabled', async () => {
    const res = await authorizeGET(
      new Request('http://localhost/api/freee/authorize?returnTo=/ja/history'),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'freee_disabled' });
  });

  it('callback GET → 307 リダイレクトで freee=error + reason=disabled', async () => {
    const res = await callbackGET(new Request('http://localhost/api/freee/callback'));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('freee=error');
    expect(loc).toContain('reason=disabled');
  });

  it('status GET → 503 freee_disabled', async () => {
    const res = await statusGET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'freee_disabled' });
  });

  it('mapping GET → 503 freee_disabled', async () => {
    const res = await mappingGET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'freee_disabled' });
  });

  it('mapping POST → 503 freee_disabled (body 読取り前にゲートが効く)', async () => {
    const res = await mappingPOST(
      new Request('http://localhost/api/freee/mapping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'freee_disabled' });
  });

  it('sync POST → 503 freee_disabled (body 読取り前にゲートが効く)', async () => {
    const res = await syncPOST(
      new Request('http://localhost/api/freee/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'freee_disabled' });
  });
});
