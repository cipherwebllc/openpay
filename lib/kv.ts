// Upstash Redis REST への薄い fetch wrapper。env (KV_REST_API_URL /
// KV_REST_API_TOKEN) 未設定時は ok:false / unconfigured を返し、呼出側で
// 「server log のみ」に degrade させる前提。

type KvOk<T> = { ok: true; value: T };
type KvErr = {
  ok: false;
  reason: 'unconfigured' | 'http_error' | 'parse_error';
  status?: number;
  detail?: string;
};
type KvResult<T> = KvOk<T> | KvErr;

function endpoint(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

export function isKvConfigured(): boolean {
  return endpoint() !== null;
}

async function call<T>(body: unknown[]): Promise<KvResult<T>> {
  const ep = endpoint();
  if (!ep) return { ok: false, reason: 'unconfigured' };
  let res: Response;
  try {
    res = await fetch(`${ep.url}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ep.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (e) {
    return {
      ok: false,
      reason: 'http_error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', status: res.status };
  }
  try {
    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) {
      return { ok: false, reason: 'http_error', detail: json.error };
    }
    return { ok: true, value: json.result as T };
  } catch (e) {
    return {
      ok: false,
      reason: 'parse_error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export function kvLpush(key: string, value: string): Promise<KvResult<number>> {
  return call<number>(['LPUSH', key, value]);
}

export function kvLrange(
  key: string,
  start: number,
  stop: number,
): Promise<KvResult<string[]>> {
  return call<string[]>(['LRANGE', key, String(start), String(stop)]);
}

export function kvLlen(key: string): Promise<KvResult<number>> {
  return call<number>(['LLEN', key]);
}

// LPUSH 直後の cap 用: 0..stop で先頭側を残し古い entry を捨てる。
export function kvLtrim(
  key: string,
  start: number,
  stop: number,
): Promise<KvResult<'OK'>> {
  return call<'OK'>(['LTRIM', key, String(start), String(stop)]);
}

// --- Phase B hardening 用の原子プリミティブ (nonce 採番 / idempotency / gas budget) ---

// 原子インクリメント (採番カウンタ・gas budget)。初回は 1。
export function kvIncr(key: string): Promise<KvResult<number>> {
  return call<number>(['INCR', key]);
}

// 値取得。未存在は null。
export function kvGet(key: string): Promise<KvResult<string | null>> {
  return call<string | null>(['GET', key]);
}

// SET key value [EX ttl] [NX]。nx 時、既存キーなら null (set されず)、新規なら 'OK'。
// idempotency (SET NX) や seed 値の保存に使う。
export function kvSet(
  key: string,
  value: string,
  opts: { nx?: boolean; ttlSec?: number } = {},
): Promise<KvResult<'OK' | null>> {
  const cmd: string[] = ['SET', key, value];
  if (opts.ttlSec !== undefined) cmd.push('EX', String(opts.ttlSec));
  if (opts.nx) cmd.push('NX');
  return call<'OK' | null>(cmd);
}

// TTL 設定 (採番カウンタ等の自然失効)。設定できれば 1、キー無しは 0。
export function kvExpire(key: string, ttlSec: number): Promise<KvResult<number>> {
  return call<number>(['EXPIRE', key, String(ttlSec)]);
}
