import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const SESSION_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enablePro: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  status: { pro: true, expiresAt: 999_000, bypass: false } as {
    pro: boolean;
    expiresAt: number | null;
    bypass: boolean;
  },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePro() {
        return hold.enablePro;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));
vi.mock('@/lib/proPlan', () => ({
  getProStatus: async () => hold.status,
}));

import { GET } from '@/app/api/pro/status/route';

beforeEach(() => {
  hold.enablePro = true;
  hold.session = { ok: true, address: SESSION_ADDR };
  hold.status = { pro: true, expiresAt: 999_000, bypass: false };
});

describe('GET /api/pro/status', () => {
  it('flag OFF → 404 (認証より前)', async () => {
    hold.enablePro = false;
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('ログイン済 → pro/expiresAt/bypass を返す', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      pro: true,
      expiresAt: 999_000,
      bypass: false,
    });
  });

  it('未加入 → pro=false', async () => {
    hold.status = { pro: false, expiresAt: null, bypass: false };
    const res = await GET();
    expect(await res.json()).toMatchObject({ ok: true, pro: false });
  });
});
