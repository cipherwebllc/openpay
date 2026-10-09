'use client';

import type { Hex } from 'viem';
import type { OrderDelivery } from '@/lib/orderDelivery';
import { resolveRelayIntent, type RelayRecoveryOutcome } from '@/lib/relay/relayIntentRecovery';
import { AUTHORIZATION_VALIDITY_WINDOW_SEC } from '@/lib/jpycEip3009';

export function orderPaymentHoldUntil(record: OrderDelivery, loadedAt: number): number {
  // A future browser timestamp must not stretch this checkout's hold beyond five minutes.
  return Math.min(Number(record.intent.validBefore) * 1000,
    record.intent.issuedAt + AUTHORIZATION_VALIDITY_WINDOW_SEC * 1000,
    loadedAt + AUTHORIZATION_VALIDITY_WINDOW_SEC * 1000);
}

// How long to keep reading after the device-clock expiry checkpoint while the chain cannot yet prove
// expiry (finality lag / unreadable status). The hold itself is never lifted without a chain result.
const POST_EXPIRY_READ_MS = 15 * 60_000;

// A background reader owns its timers/abort controller, never the current payment's recovery latch.
// The same-merchant payment hold is lifted only by a chain result (onResolved: settled, or expired
// proven at a finalized block). A device-clock expiry or an unreadable status never lifts it: the old
// signature may still settle, and a second signature would double-pay (#767 Codex re-review P1).
export function recoverOrderDelivery(
  record: OrderDelivery,
  waitForReceipt: (hash: Hex, timeout: number) => Promise<{ status: 'success' | 'reverted' }>,
  onResolved: (outcome: Exclude<RelayRecoveryOutcome, { kind: 'unknown' }>) => void,
  { loadedAt }: { loadedAt: number },
): () => void {
  let active = true;
  let generation = 0;
  let cancelRound: (() => void) | undefined;
  const holdUntil = orderPaymentHoldUntil(record, loadedAt);
  // Count the bounded wait from this page load too: a record restored long after its expiry must still
  // get full ordinary rounds (two consecutive proven-expired reads) instead of stopping right after the
  // single checkpoint read and holding the shop forever (#767 Codex 3rd review P1).
  const readUntil = Math.max(holdUntil, loadedAt) + POST_EXPIRY_READ_MS;
  const run = async (singleRead: boolean) => {
    const current = ++generation;
    const isCurrent = () => active && current === generation;
    const sleeps = new Map<ReturnType<typeof setTimeout>, () => void>();
    const requests = new Map<ReturnType<typeof setTimeout>, AbortController>();
    cancelRound = () => {
      for (const [timer, wake] of sleeps) { clearTimeout(timer); wake(); }
      for (const [timer, controller] of requests) { clearTimeout(timer); controller.abort(); }
    };
    // Retry read-only until a chain result. The device-clock checkpoint only starts a fresh read;
    // past it, keep reading for a bounded time (finality catching up), then stop and keep the hold.
    do {
      const outcome = await resolveRelayIntent({
        intent: record.intent, isMounted: isCurrent,
        registerSleep: (timer, wake) => { sleeps.set(timer, wake); },
        clearSleep: (timer) => { sleeps.delete(timer); },
        registerFetch: (timer, controller) => { requests.set(timer, controller); },
        clearFetch: (timer) => { requests.delete(timer); },
        waitForReceipt,
      }, { singleRead });
      // An earlier round's in-flight receipt must not release or overwrite the expiry check.
      if (!isCurrent()) return;
      if (outcome.kind !== 'unknown') {
        clearTimeout(expiryTimer);
        onResolved(outcome);
        return;
      }
      singleRead = false;
      if (Date.now() >= readUntil) return;
    } while (isCurrent());
  };
  const start = (singleRead: boolean) => {
    void run(singleRead).catch(() => {
      // RPC/storage failures retain the opening and the hold rather than fabricate payment or
      // abandonment (a reload starts a fresh read).
    });
  };
  const expiryTimer = setTimeout(() => {
    // Supersede a sleeping round or a pre-expiry request; neither counts as the fresh check.
    generation++;
    cancelRound?.();
    start(true);
  }, Math.max(0, holdUntil - Date.now()));
  start(false);
  return () => {
    active = false;
    clearTimeout(expiryTimer);
    cancelRound?.();
  };
}
