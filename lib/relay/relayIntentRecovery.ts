import type { Hex } from 'viem';
import type { RelayIntentMetadata } from '@/lib/paymentIntentStorage';

type RelayStatusResponse =
  | { ok: true; state: 'settled'; txHash: Hex | null }
  | { ok: true; state: 'unused' }
  | { ok: true; state: 'indeterminate' };

type Timer = ReturnType<typeof setTimeout>;

type RecoveryRuntime = {
  intent: RelayIntentMetadata;
  isMounted: () => boolean;
  registerSleep: (timer: Timer, wake: () => void) => void;
  clearSleep: (timer: Timer) => void;
  registerFetch: (timer: Timer, controller: AbortController) => void;
  clearFetch: (timer: Timer, controller: AbortController) => void;
  waitForReceipt:
    | ((hash: Hex, timeout: number) => Promise<{ status: 'success' | 'reverted' }>)
    | null;
};

export type RelayRecoveryOutcome =
  | { kind: 'settled'; txHash: Hex; success: boolean }
  | { kind: 'expired' }
  | { kind: 'unknown' };

const BACKOFF_MS = [3_000, 6_000, 12_000, 24_000, 45_000] as const;
const FETCH_TIMEOUT_MS = 10_000;
const DEADLINE_MS = 90_000;

function isRelayStatusResponse(value: unknown): value is RelayStatusResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  if (body.ok !== true) return false;
  if (body.state === 'unused' || body.state === 'indeterminate') return true;
  return (
    body.state === 'settled' &&
    (body.txHash === null ||
      (typeof body.txHash === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(body.txHash)))
  );
}

async function sleep(
  delayMs: number,
  runtime: RecoveryRuntime,
): Promise<boolean> {
  return new Promise((resolve) => {
    const wake = () => resolve(runtime.isMounted());
    const timer = setTimeout(() => {
      runtime.clearSleep(timer);
      wake();
    }, delayMs);
    runtime.registerSleep(timer, wake);
  });
}

async function readStatus(
  runtime: RecoveryRuntime,
  deadline: number,
): Promise<RelayStatusResponse | null> {
  const controller = new AbortController();
  const remainingMs = Math.max(1, deadline - Date.now());
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(FETCH_TIMEOUT_MS, remainingMs),
  );
  runtime.registerFetch(timer, controller);
  try {
    const response = await fetch('/api/relay/jpyc/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lookup: 'nonce',
        chainId: runtime.intent.chainId,
        from: runtime.intent.from,
        nonce: runtime.intent.nonce,
      }),
      signal: controller.signal,
    });
    const body: unknown = await response.json();
    return response.ok && isRelayStatusResponse(body) ? body : null;
  } catch {
    // status の fetch/RPC/KV 障害は送金結果を変えず、deadline まで同じ intent の read を続ける。
    return null;
  } finally {
    clearTimeout(timer);
    runtime.clearFetch(timer, controller);
  }
}

export async function resolveRelayIntent(
  runtime: RecoveryRuntime,
): Promise<RelayRecoveryOutcome> {
  const deadline = Date.now() + DEADLINE_MS;
  let consecutiveUnused = 0;

  for (const delayMs of BACKOFF_MS) {
    if (!(await sleep(delayMs, runtime))) return { kind: 'unknown' };
    if (Date.now() > deadline) break;

    const status = await readStatus(runtime, deadline);
    if (!runtime.isMounted()) return { kind: 'unknown' };
    if (!status || status.state === 'indeterminate') {
      consecutiveUnused = 0;
      continue;
    }
    if (status.state === 'unused') {
      consecutiveUnused++;
      if (
        consecutiveUnused >= 2 &&
        Math.floor(Date.now() / 1000) >= Number(runtime.intent.validBefore)
      ) {
        return { kind: 'expired' };
      }
      continue;
    }

    consecutiveUnused = 0;
    if (status.txHash === null || !runtime.waitForReceipt) continue;
    try {
      const receipt = await runtime.waitForReceipt(
        status.txHash,
        Math.max(
          1,
          Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()),
        ),
      );
      return {
        kind: 'settled',
        txHash: status.txHash,
        success: receipt.status === 'success',
      };
    } catch {
      // txHash 確定後の receipt RPC 障害も、新規署名へ倒さず deadline まで同じ hash を再照会する。
    }
  }

  return { kind: 'unknown' };
}
