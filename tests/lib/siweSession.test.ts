// lib/siweSession.ts (セッションの読み取りの実体) が、KV のセッションに残した署名の種類 (eoa / contract) を caller へ渡すこと。
// 運営の API (lib/adminAuth.ts の isAdminSession) は eoa だけを通すので、ここで落とすと運営者が締め出される
// (逆に、種類の無い古いセッションに種類を付けて返すと、スマートウォレットのセッションが運営の API を通る)。2026-11-25。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

const h = vi.hoisted(() => ({
  token: 'a'.repeat(64) as string | undefined,
  record: null as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (h.token === undefined ? undefined : { value: h.token }) }),
}));
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async () => ({ ok: true, value: h.record })),
}));

import { readSession, requireSession } from '@/lib/siweSession';

const ADDR = '0x00000000000000000000000000000000000000a1';

beforeEach(() => {
  h.token = 'a'.repeat(64);
  h.record = null;
});

describe('siweSession の署名の種類', () => {
  it.each(['eoa', 'contract'] as const)('KV のセッションの署名の種類 %s を readSession と requireSession が返す', async (signer) => {
    h.record = JSON.stringify({ address: ADDR, signer });
    expect(await readSession()).toEqual({ status: 'authenticated', address: getAddress(ADDR), signer });
    expect(await requireSession()).toEqual({ ok: true, address: getAddress(ADDR), signer });
  });

  it('種類の無い古いセッションは、種類を付けずに返す (運営の API は通さない)', async () => {
    h.record = JSON.stringify({ address: ADDR });
    expect(await readSession()).toEqual({ status: 'authenticated', address: getAddress(ADDR) });
    expect(await requireSession()).toEqual({ ok: true, address: getAddress(ADDR) });
  });
});
