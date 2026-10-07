import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = vi.hoisted(() => ({
  set: vi.fn(),
  mget: vi.fn(),
  setNxGet: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  kvSet: kv.set,
  kvMget: kv.mget,
  kvSetNxGet: kv.setNxGet,
}));

import { kvHandoffStore } from '@/lib/storeHandoffDeps';
import type { HandoffAuth, HandoffSession } from '@/lib/storeHandoff';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const session = { v: 1, chainId: 80002 } as unknown as HandoffSession;
const auth = { v: 1, nonce: '0x01' } as unknown as HandoffAuth;

describe('kvHandoffStore (Upstash への写像)', () => {
  beforeEach(() => {
    kv.set.mockReset();
    kv.mget.mockReset();
    kv.setNxGet.mockReset();
  });

  it('セッションは NX + TTL で置き、既存なら false・KV 障害は null', async () => {
    kv.set.mockResolvedValueOnce({ ok: true, value: 'OK' });
    expect(await kvHandoffStore.putSession(ID, session, 600)).toBe(true);
    expect(kv.set).toHaveBeenCalledWith(`storehandoff:v1:${ID}`, JSON.stringify(session), { nx: true, ttlSec: 600 });
    kv.set.mockResolvedValueOnce({ ok: true, value: null });
    expect(await kvHandoffStore.putSession(ID, session, 600)).toBe(false);
    kv.set.mockResolvedValueOnce({ ok: false, error: 'down' });
    expect(await kvHandoffStore.putSession(ID, session, 600)).toBeNull();
  });

  it('読み取りは 3 キーを 1 往復で・壊れた値と形の違う tx は無いものとして扱う・KV 障害は null', async () => {
    kv.mget.mockResolvedValueOnce({ ok: true, value: [JSON.stringify(session), '{broken', 'not-a-hash'] });
    expect(await kvHandoffStore.read(ID)).toEqual({ session, auth: null, txHash: null, closed: false });
    expect(kv.mget).toHaveBeenCalledWith([
      `storehandoff:v1:${ID}`,
      `storehandoff:v1:${ID}:auth`,
      `storehandoff:v1:${ID}:tx`,
    ]);
    kv.mget.mockResolvedValueOnce({ ok: false, error: 'down' });
    expect(await kvHandoffStore.read(ID)).toBeNull();
  });

  it('署名の枠は SET NX GET で取り、既存があれば返す', async () => {
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: null });
    expect(await kvHandoffStore.claimAuth(ID, auth, 300)).toEqual({ existing: null });
    expect(kv.setNxGet).toHaveBeenCalledWith(`storehandoff:v1:${ID}:auth`, JSON.stringify(auth), 300);
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: JSON.stringify(auth) });
    expect(await kvHandoffStore.claimAuth(ID, auth, 300)).toEqual({ existing: auth });
    kv.setNxGet.mockResolvedValueOnce({ ok: false, error: 'down' });
    expect(await kvHandoffStore.claimAuth(ID, auth, 300)).toBeNull();
  });

  it('署名の枠に締め切りの印があれば、読み取りは closed・署名の枠取りは closed (置けていない)', async () => {
    const mark = JSON.stringify({ v: 1, closed: true, at: 1 });
    kv.mget.mockResolvedValueOnce({ ok: true, value: [JSON.stringify(session), mark, null] });
    expect(await kvHandoffStore.read(ID)).toEqual({ session, auth: null, txHash: null, closed: true });
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: mark });
    expect(await kvHandoffStore.claimAuth(ID, auth, 300)).toEqual({ existing: null, closed: true });
  });

  it('締め切りは同じ枠に SET NX GET で印を置く: 空き・締め切り済みは closed、署名が先なら署名を返す・壊れた値と障害は null', async () => {
    const mark = { v: 1 as const, closed: true as const, at: 1 };
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: null });
    expect(await kvHandoffStore.closeSlot(ID, mark, 300)).toEqual({ closed: true });
    expect(kv.setNxGet).toHaveBeenCalledWith(`storehandoff:v1:${ID}:auth`, JSON.stringify(mark), 300);
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: JSON.stringify(mark) });
    expect(await kvHandoffStore.closeSlot(ID, mark, 300)).toEqual({ closed: true });
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: JSON.stringify(auth) });
    expect(await kvHandoffStore.closeSlot(ID, mark, 300)).toEqual({ closed: false, existing: auth });
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: '{broken' });
    expect(await kvHandoffStore.closeSlot(ID, mark, 300)).toBeNull();
    kv.setNxGet.mockResolvedValueOnce({ ok: false, error: 'down' });
    expect(await kvHandoffStore.closeSlot(ID, mark, 300)).toBeNull();
  });

  it('tx は SET NX GET で最初の 1 件だけ記録し、記録済みの hash を返す・読めない値と障害は null', async () => {
    const tx = `0x${'ab'.repeat(32)}` as const;
    const other = `0x${'cd'.repeat(32)}`;
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: null });
    expect(await kvHandoffStore.putTx(ID, tx, 300)).toBe(tx);
    expect(kv.setNxGet).toHaveBeenCalledWith(`storehandoff:v1:${ID}:tx`, tx, 300);
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: other });
    expect(await kvHandoffStore.putTx(ID, tx, 300)).toBe(other);
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: 'junk' });
    expect(await kvHandoffStore.putTx(ID, tx, 300)).toBeNull();
    kv.setNxGet.mockResolvedValueOnce({ ok: false, error: 'down' });
    expect(await kvHandoffStore.putTx(ID, tx, 300)).toBeNull();
  });

  it('既存値が壊れている・文字列 "null" のときは置けていないので成功にしない (null = 止める)', async () => {
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: '{broken' });
    expect(await kvHandoffStore.claimAuth(ID, auth, 300)).toBeNull();
    kv.setNxGet.mockResolvedValueOnce({ ok: true, value: 'null' });
    expect(await kvHandoffStore.claimAuth(ID, auth, 300)).toBeNull();
  });
});
