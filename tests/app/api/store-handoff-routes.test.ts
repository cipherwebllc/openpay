import { describe, it, expect, vi, beforeEach } from 'vitest';

const hold = vi.hoisted(() => ({
  enabled: true,
  rateOk: true,
  calls: [] as { fn: string; args: unknown[] }[],
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableStoreGasWallet() {
        return hold.enabled;
      },
    },
  };
});
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => hold.rateOk),
}));
vi.mock('@/lib/storeHandoffDeps', () => ({ handoffDeps: () => ({}), resolveDeps: () => ({}) }));
vi.mock('@/lib/storeHandoffResolve', () => ({
  resolveStoreHandoff: vi.fn(async (...args: unknown[]) => {
    hold.calls.push({ fn: 'resolve', args });
    return { ok: true, state: 'pending' };
  }),
}));
vi.mock('@/lib/storeHandoff', () => ({
  createHandoffSession: vi.fn(async (...args: unknown[]) => {
    hold.calls.push({ fn: 'create', args });
    return { ok: true, id: 'AAAAAAAAAAAAAAAAAAAAAA', token: 'ab'.repeat(32), expiresAt: 1 };
  }),
  submitHandoffAuth: vi.fn(async (...args: unknown[]) => {
    hold.calls.push({ fn: 'auth', args });
    return { ok: false, status: 409, error: 'slot_taken' };
  }),
  readHandoff: vi.fn(async (...args: unknown[]) => {
    hold.calls.push({ fn: 'read', args });
    return { ok: true, state: 'open', expiresAt: 1, txHash: null };
  }),
  recordHandoffTx: vi.fn(async (...args: unknown[]) => {
    hold.calls.push({ fn: 'tx', args });
    return { ok: true };
  }),
  closeHandoff: vi.fn(async (...args: unknown[]) => {
    hold.calls.push({ fn: 'close', args });
    return { ok: true, closed: true };
  }),
}));

import { POST as createPost } from '@/app/api/register/handoff/route';
import { GET as readGet } from '@/app/api/register/handoff/[id]/route';
import { POST as authPost } from '@/app/api/register/handoff/[id]/auth/route';
import { POST as txPost } from '@/app/api/register/handoff/[id]/tx/route';
import { POST as closePost } from '@/app/api/register/handoff/[id]/close/route';
import { POST as resolvePost } from '@/app/api/register/handoff/resolve/route';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const params = { params: Promise.resolve({ id: ID }) };
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://open-pay.jp/api/register/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('/api/register/handoff/*', () => {
  beforeEach(() => {
    hold.enabled = true;
    hold.rateOk = true;
    hold.calls.length = 0;
  });

  it('flag OFF ではすべて 404 (完全 inert)', async () => {
    hold.enabled = false;
    for (const res of [
      await createPost(json({})),
      await readGet(new Request(`https://open-pay.jp/api/register/handoff/${ID}`), params),
      await authPost(json({}), params),
      await txPost(json({}), params),
      await closePost(json({}), params),
      await resolvePost(json({})),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(hold.calls).toHaveLength(0);
  });

  it('作成と署名の受け取りは IP ごとの回数制限 (超えたら 429・本体に届かない)', async () => {
    hold.rateOk = false;
    expect((await createPost(json({}))).status).toBe(429);
    expect((await authPost(json({}), params)).status).toBe(429);
    expect((await resolvePost(json({}))).status).toBe(429);
    expect(hold.calls).toHaveLength(0);
  });

  it('壊れた JSON・大きすぎる本文は本体に渡さない', async () => {
    expect((await createPost(json('{not json'))).status).toBe(400);
    expect((await createPost(json({ pad: 'x'.repeat(5000) }))).status).toBe(413);
    expect(hold.calls).toHaveLength(0);
  });

  it('応答は no-store・失敗は status とエラー名をそのまま返す', async () => {
    const created = await createPost(json({ chainId: 80002 }));
    expect(created.status).toBe(200);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const auth = await authPost(json({ from: '0x' }), params);
    expect(auth.status).toBe(409);
    expect(await auth.json()).toEqual({ ok: false, error: 'slot_taken' });
  });

  it('お客様の読み取り (トークンなし) は IP ごとに制限し、端末の読み取り (トークンあり) には付けない', async () => {
    hold.rateOk = false;
    const pub = await readGet(new Request(`https://open-pay.jp/api/register/handoff/${ID}`), params);
    expect(pub.status).toBe(429);
    const device = await readGet(
      new Request(`https://open-pay.jp/api/register/handoff/${ID}`, {
        headers: { 'x-store-handoff-token': 'cd'.repeat(32) },
      }),
      params,
    );
    expect(device.status).toBe(200);
    expect(hold.calls.map((c) => c.fn)).toEqual(['read']);
  });

  it('読み取りトークンはヘッダから渡す (URL のクエリは使わない)', async () => {
    await readGet(
      new Request(`https://open-pay.jp/api/register/handoff/${ID}?t=from-query`, {
        headers: { 'x-store-handoff-token': 'cd'.repeat(32) },
      }),
      params,
    );
    expect(hold.calls[0].fn).toBe('read');
    expect(hold.calls[0].args.slice(0, 2)).toEqual([ID, 'cd'.repeat(32)]);
    await txPost(json({ txHash: '0x' }, { 'x-store-handoff-token': 'ef'.repeat(32) }), params);
    expect(hold.calls[1].fn).toBe('tx');
    expect(hold.calls[1].args.slice(0, 2)).toEqual([ID, 'ef'.repeat(32)]);
  });

  it('締め切りは端末のトークン (ヘッダ) を渡し、回数制限は付けない・応答は no-store', async () => {
    hold.rateOk = false;
    const res = await closePost(json({}, { 'x-store-handoff-token': 'ef'.repeat(32) }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, closed: true });
    expect(hold.calls[0]).toMatchObject({ fn: 'close', args: [ID, 'ef'.repeat(32), {}] });
  });
});
