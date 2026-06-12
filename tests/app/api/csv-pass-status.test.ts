import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const SESSION_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enableCsvPass: true,
  feeReceiverConfigured: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  status: { active: true, expiresAt: 999_000, bypass: false } as {
    active: boolean;
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
      get enableCsvPass() {
        return hold.enableCsvPass;
      },
      get feeReceiverConfigured() {
        return hold.feeReceiverConfigured;
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
vi.mock('@/lib/csvPass', () => ({
  getCsvPassStatus: async () => hold.status,
}));

import { GET } from '@/app/api/csv-pass/status/route';

beforeEach(() => {
  hold.enableCsvPass = true;
  hold.feeReceiverConfigured = true;
  hold.session = { ok: true, address: SESSION_ADDR };
  hold.status = { active: true, expiresAt: 999_000, bypass: false };
});

describe('GET /api/csv-pass/status', () => {
  it('flag OFF → 404 (認証より前)', async () => {
    hold.enableCsvPass = false;
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'csvpass_disabled' });
  });

  it('FEE_RECEIVER 未設定 → 503 (認証前)', async () => {
    hold.feeReceiverConfigured = false;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'csvpass_misconfigured' });
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('ログイン済 → active/expiresAt/bypass を返す', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      active: true,
      expiresAt: 999_000,
      bypass: false,
    });
  });

  it('未保持 → active=false', async () => {
    hold.status = { active: false, expiresAt: null, bypass: false };
    const res = await GET();
    expect(await res.json()).toMatchObject({ ok: true, active: false });
  });
});
