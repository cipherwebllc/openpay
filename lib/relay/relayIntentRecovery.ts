import type { Hex } from 'viem';
import type { RelayIntentMetadata } from '@/lib/paymentIntentStorage';

type RelayStatusResponse =
  | { ok: true; state: 'settled'; txHash: Hex | null }
  // expiry: サーバがチェーンで観測した署名の期限。'expired' = finalized で期限切れかつ未使用 (もう成立しない)・
  // 'live' = チェーン上ではまだ期限前・無し = 観測できなかった。
  | { ok: true; state: 'unused'; expiry?: 'expired' | 'live' }
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
  // live: 最後に受け取った status が「unused かつチェーン上ではまだ期限前 (expiry: 'live')」だった
  // (旧署名がまだ成立しうるので、呼出元は保留を外さずに照会を続けられる)。
  | { kind: 'unknown'; live?: true };

const BACKOFF_MS = [3_000, 6_000, 12_000, 24_000, 45_000] as const;
const FETCH_TIMEOUT_MS = 10_000;
const DEADLINE_MS = 90_000;

function isRelayStatusResponse(value: unknown): value is RelayStatusResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  if (body.ok !== true) return false;
  if (body.state === 'unused') {
    return body.expiry === undefined || body.expiry === 'expired' || body.expiry === 'live';
  }
  if (body.state === 'indeterminate') return true;
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
        // 署名の期限を渡し、期限切れ未使用の証明 (expiry) をチェーンで取ってもらう。
        validBefore: runtime.intent.validBefore,
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
  { singleRead = false }: { singleRead?: boolean } = {},
): Promise<RelayRecoveryOutcome> {
  // Background order holds need a fresh read at expiry without waiting through backoff.
  // Its status + receipt work share the fetch timeout; ordinary recovery is unchanged.
  const deadline = Date.now() + (singleRead ? FETCH_TIMEOUT_MS : DEADLINE_MS);
  let consecutiveUnused = 0;
  // 最後に受け取った status がチェーン上で期限前 (unused + expiry: 'live') だったか。応答が無い回 (fetch 失敗) は変えない。
  let lastLive = false;
  const unknown = (): RelayRecoveryOutcome => (lastLive ? { kind: 'unknown', live: true } : { kind: 'unknown' });

  for (const delayMs of singleRead ? [0] : BACKOFF_MS) {
    if (delayMs ? !(await sleep(delayMs, runtime)) : !runtime.isMounted()) return unknown();
    if (Date.now() > deadline) break;

    const status = await readStatus(runtime, deadline);
    if (!runtime.isMounted()) return unknown();
    if (!status || status.state === 'indeterminate') {
      // 応答なし/indeterminate は「連続 unused」を切る (従来どおり)。lastLive は応答があったときだけ更新する。
      consecutiveUnused = 0;
      if (status) lastLive = false;
      continue;
    }
    lastLive = status.state === 'unused' && status.expiry === 'live';
    if (status.state === 'unused') {
      consecutiveUnused++;
      // ラッチ解除 (= 新しい署名を許す) は、連続 unused かつ最新の応答がチェーン上で期限切れと証明済みのときだけ。
      // 端末の時計には戻らない (証明が無い・live なら期限まで unknown のまま): 端末の時計が進んでいると、まだ
      // 有効な署名のラッチを外して二重払いを許しうる (第 7 回レビュー A6)。
      if (consecutiveUnused >= 2 && status.expiry === 'expired') {
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

  return unknown();
}
