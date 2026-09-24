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
    const resolved = vi.fn(); const released = vi.fn();
    const cancel = recoverOrderDelivery(saved, receipt, resolved, { loadedAt: Date.now(), onHoldReleased: released });
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(reads).toHaveLength(2);
    expect(reads[1].at).toBe(Number(saved.intent.validBefore) * 1000);
    expect(reads[0].signal.aborted).toBe(true);
    reads[0].finish(Response.json({ ok: true, state: 'settled', txHash }));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
    reads[1].finish(Response.json({ ok: true, state: 'indeterminate' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled();
    cancel();
  });

  it('checks an already expired record immediately, then still requires two unused reads to abandon it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, state: 'unused' }));
    const resolved = vi.fn(); const released = vi.fn();
    const cancel = recoverOrderDelivery(record(-1), vi.fn(), resolved, { loadedAt: Date.now(), onHoldReleased: released });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(released).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
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
    const resolved = vi.fn(); const released = vi.fn();
    const cancel = recoverOrderDelivery(saved, receipt, resolved, { loadedAt: Date.now(), onHoldReleased: released });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(receipt).toHaveBeenCalledWith(txHash, 1000);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled();
    cancel();
  });

  it('unmount aborts the expiry read and cannot release or resolve into another checkout', async () => {
    let signal: AbortSignal | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const resolved = vi.fn(); const released = vi.fn();
    const cancel = recoverOrderDelivery(record(1), vi.fn(), resolved, { loadedAt: Date.now(), onHoldReleased: released });
    await vi.advanceTimersByTimeAsync(1000);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal!.aborted).toBe(true);
    expect(released).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
