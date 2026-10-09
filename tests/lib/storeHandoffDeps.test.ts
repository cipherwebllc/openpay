import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress } from 'viem';

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
const hold = vi.hoisted(() => ({
  feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' as string | undefined,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get feeReceiver() {
        return hold.feeReceiver;
      },
    },
  };
});

import { handoffDeps, handoffMac, kvHandoffStore, resolveDeps } from '@/lib/storeHandoffDeps';
import type { HandoffAuth, HandoffSession } from '@/lib/storeHandoff';
import { isStoreDeviceChain } from '@/lib/storeDevicePayment';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { feeReceiverFor } from '@/lib/relay/forwarderSettleService';
import {
  MAX_VALUE,
  getBalance,
  jpycAddressFor,
  readAuthorizationUsed,
} from '@/lib/relay/relayProvider';

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

// C6 (第 7 回レビュー): 本番の依存で「検証に効く値」の出所を 1 か所に固定する。
describe('handoffDeps / resolveDeps (本番の依存の出所)', () => {
  afterEach(() => {
    hold.feeReceiver = '0x428483FbA62eDCef1E3a100d3799F6d71759c560';
  });

  it('上限は中継と同じ MAX_VALUE・手数料 1 wei と有効窓 180 秒は deps に置かない (lib/storeDevicePayment の定数が効く)', () => {
    const d = handoffDeps();
    expect(d.maxValue).toBe(MAX_VALUE);
    expect('expectedFeeValue' in d).toBe(false);
    expect('maxValidityWindowSec' in d).toBe(false);
    expect(d.store).toBe(kvHandoffStore);
    expect(d.isAllowedChain).toBe(isStoreDeviceChain);
    expect(d.jpycAddressFor).toBe(jpycAddressFor);
    expect(d.forwarderFor).toBe(jpycForwarderFor);
    expect(d.getBalance).toBe(getBalance);
    expect(d.readAuthorizationUsed).toBe(readAuthorizationUsed);
    expect(d.mac).toBe(handoffMac);
  });

  it('受取口は中継と同じ feeReceiverFor (checksum 済み・未設定は null) を、作成/署名と結論が同じ関数で使う', () => {
    const checksummed = getAddress('0x428483fba62edcef1e3a100d3799f6d71759c560');
    hold.feeReceiver = '0x428483fba62edcef1e3a100d3799f6d71759c560';
    expect(handoffDeps().feeReceiverFor(137)).toBe(checksummed);
    expect(resolveDeps().feeReceiverFor(137)).toBe(checksummed);
    expect(handoffDeps().feeReceiverFor).toBe(feeReceiverFor);
    expect(resolveDeps().feeReceiverFor).toBe(feeReceiverFor);
    hold.feeReceiver = undefined;
    expect(handoffDeps().feeReceiverFor(137)).toBeNull();
    expect(resolveDeps().feeReceiverFor(137)).toBeNull();
    hold.feeReceiver = 'not-an-address';
    expect(handoffDeps().feeReceiverFor(137)).toBeNull();
  });
});
