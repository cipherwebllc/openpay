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

// A background reader owns its timers/abort controller, never the current payment's recovery latch.
export function recoverOrderDelivery(
  record: OrderDelivery,
  waitForReceipt: (hash: Hex, timeout: number) => Promise<{ status: 'success' | 'reverted' }>,
  onResolved: (outcome: Exclude<RelayRecoveryOutcome, { kind: 'unknown' }>) => void,
  { loadedAt, onHoldReleased }: { loadedAt: number; onHoldReleased: () => void },
): () => void {
  let active = true;
  let generation = 0;
  let cancelRound: (() => void) | undefined;
  const holdUntil = orderPaymentHoldUntil(record, loadedAt);
  const run = async (singleRead: boolean) => {
    const current = ++generation;
    const isCurrent = () => active && current === generation;
    const sleeps = new Map<ReturnType<typeof setTimeout>, () => void>();
    const requests = new Map<ReturnType<typeof setTimeout>, AbortController>();
    cancelRound = () => {
      for (const [timer, wake] of sleeps) { clearTimeout(timer); wake(); }
      for (const [timer, controller] of requests) { clearTimeout(timer); controller.abort(); }
    };
    // Retry live authorizations read-only. After the expiry checkpoint, keep one ordinary
    // round for unused/revert evidence: a single unused read must not delete the opening.
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
      if (singleRead) {
        onHoldReleased();
        singleRead = false;
      } else if (Date.now() >= holdUntil) return;
    } while (isCurrent());
  };
  const start = (singleRead: boolean) => {
    void run(singleRead).catch(() => {
      // RPC/storage failures retain the opening rather than fabricate payment or abandonment.
      // At expiry an unsuccessful read releases only the hold, with staff-assistance wording.
      if (active && singleRead) onHoldReleased();
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
