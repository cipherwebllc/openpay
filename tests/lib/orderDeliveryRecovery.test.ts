import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDelivery } from '@/lib/orderDelivery';
import { orderPaymentHoldUntil, recoverOrderDelivery } from '@/lib/orderDeliveryRecovery';
import { bindingFixture } from '../_helpers/orderBinding';

const txHash = `0x${'ab'.repeat(32)}`;
function record(validFor = 300): OrderDelivery {
  const saved = bindingFixture('free', { chainId: 80002, tokenAddress: '0x0000000000000000000000000000000000000abc', merchant: '0x1111111111111111111111111111111111111111', handle: 'alice', orderId: 'old', items: [] }).record;
  const validBefore = String(Math.floor(Date.now() / 1000) + validFor);
  return { ...saved, bind: { ...saved.bind, validBefore }, intent: { ...saved.intent, validBefore, issuedAt: Date.now() } };
}

describe('background order expiry checkpoint', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T00:00:00Z')); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('caps the hold by expiry, issuance and loading time', () => {
    const now = Date.now();
    expect(orderPaymentHoldUntil(record(20), now)).toBe(now + 20_000);
    const saved = record(600);
    expect(orderPaymentHoldUntil(saved, now + 100_000)).toBe(now + 300_000);
    expect(orderPaymentHoldUntil({ ...saved, intent: { ...saved.intent, issuedAt: now + 600_000 } }, now)).toBe(now + 300_000);
  });

  it('aborts a pre-expiry request and waits for a new read, ignoring the old late reply', async () => {
    const saved = record(7);
    const reads: { at: number; signal: AbortSignal; finish: (r: Response) => void }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((finish) => {
      // Deliberately ignore abort to model a late reply already in transit.
      reads.push({ at: Date.now(), signal: init!.signal!, finish });
    }));
    const receipt = vi.fn().mockResolvedValue({ status: 'success' });
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(saved, receipt, resolved, { loadedAt: Date.now()});
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(reads).toHaveLength(2);
    expect(reads[1].at).toBe(Number(saved.intent.validBefore) * 1000);
    expect(reads[0].signal.aborted).toBe(true);
    reads[0].finish(Response.json({ ok: true, state: 'settled', txHash }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
    reads[1].finish(Response.json({ ok: true, state: 'indeterminate' }));
    await vi.advanceTimersByTimeAsync(0);
    // An unreadable checkpoint is not a chain result: nothing is resolved (the hold stays — #767 P1).
    expect(resolved).not.toHaveBeenCalled();
    cancel();
  });

  it('checks an already expired record immediately, then still requires two unused reads (with on-chain expiry proof) to abandon it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, state: 'unused', expiry: 'expired' }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(record(-1), vi.fn(), resolved, { loadedAt: Date.now()});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(resolved).toHaveBeenCalledWith({ kind: 'expired' });
    cancel();
  });

  // 第 7 回レビュー A6 (再レビュー反映): 端末の時計の holdUntil で読んだ結果がチェーン上でまだ期限前 (live) なら、
  // 保留を外さずに照会を続ける (旧署名がまだ成立しうる間に同じ店の新しい署名を許さない)。
  it('keeps the hold while the chain reports the signature live, then abandons once finality proves expiry', async () => {
    let expiry: 'live' | 'expired' = 'live';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, state: 'unused', expiry }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(record(-1), vi.fn(), resolved, { loadedAt: Date.now()});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled();
    // The ordinary rounds continue while live, still without resolving.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(2); expect(resolved).not.toHaveBeenCalled();
    expiry = 'expired';
    await vi.advanceTimersByTimeAsync(6000);
    expect(resolved).toHaveBeenCalledWith({ kind: 'expired' });
    cancel();
  });

  it('does not abandon on a plain unused read without on-chain expiry proof, even after the device clock passed expiry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, state: 'unused' }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(record(-1), vi.fn(), resolved, { loadedAt: Date.now()});
    await vi.advanceTimersByTimeAsync(90_000);
    expect(resolved).not.toHaveBeenCalled();
    cancel();
  });

  // #767 Codex 再レビュー P1: 端末の時計の期限を過ぎ、チェーンが読めない (live の後でも) ときに保留を外すと、旧署名が
  // まだ成立しうるのに同じ店の新しい署名を許して二重払いになりうる。チェーンの結果 (onResolved) 以外では外さない。
  it('never resolves on unreadable rounds after expiry (live → indeterminate), and stops reading after the bounded wait', async () => {
    let live = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(live ? { ok: true, state: 'unused', expiry: 'live' } : { ok: true, state: 'indeterminate' }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(record(-1), vi.fn(), resolved, { loadedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    live = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resolved).not.toHaveBeenCalled();
    // Reads continue (finality may still catch up) for the bounded wait after the checkpoint, then stop.
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    const readsAtCap = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchSpy.mock.calls.length).toBe(readsAtCap);
    expect(resolved).not.toHaveBeenCalled();
    cancel();
  });

  it('a record restored long after its expiry still completes ordinary rounds and abandons on proven expiry (#767 P1)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, state: 'unused', expiry: 'expired' }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(record(-20 * 60), vi.fn(), resolved, { loadedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled();
    // The single checkpoint read alone cannot abandon (two consecutive proven reads are required): the
    // ordinary round that follows (3 s + 6 s backoff) must still run even though expiry + 15 min has passed.
    await vi.advanceTimersByTimeAsync(9000);
    expect(resolved).toHaveBeenCalledWith({ kind: 'expired' });
    cancel();
  });

  it('shares the ten-second checkpoint budget between status and receipt reads', async () => {
    const saved = record(1);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ ok: true, state: 'settled', txHash })), 9000);
    }));
    const receipt = vi.fn((_hash, timeout: number) => new Promise<{ status: 'success' }>((_resolve, reject) => {
      setTimeout(() => reject(new Error('receipt unavailable')), timeout);
    }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(saved, receipt, resolved, { loadedAt: Date.now()});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(receipt).toHaveBeenCalledWith(txHash, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    // A receipt that cannot be read within the checkpoint budget is not a chain result.
    expect(resolved).not.toHaveBeenCalled();
    cancel();
  });

  it('unmount aborts the expiry read and cannot release or resolve into another checkout', async () => {
    let signal: AbortSignal | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const resolved = vi.fn();
    const cancel = recoverOrderDelivery(record(1), vi.fn(), resolved, { loadedAt: Date.now()});
    await vi.advanceTimersByTimeAsync(1000);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal!.aborted).toBe(true);
    expect(resolved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
