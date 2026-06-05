// Upstash Redis REST への薄い fetch wrapper。env (KV_REST_API_URL /
// KV_REST_API_TOKEN) 未設定時は ok:false / unconfigured を返し、呼出側で
// 「server log のみ」に degrade させる前提。

type KvOk<T> = { ok: true; value: T };
type KvErr = {
  ok: false;
  reason: 'unconfigured' | 'http_error' | 'parse_error' | 'timeout';
  status?: number;
  detail?: string;
};
type KvResult<T> = KvOk<T> | KvErr;

// Upstash REST は通常 <100ms。serverless 関数が応答しない接続に張り付くのを防ぐため
// 1 リクエストを bound する (これが無いと route の maxDuration まで slot を占有する)。
const KV_TIMEOUT_MS = 5_000;

// 投げられた値から name/detail を抽出する (Error / DOMException / 非Error を一様に扱う・
// realm 差異で instanceof Error が一致しないケースに依存しない)。
function errInfo(e: unknown): { name: string; detail: string } {
  const o = e as { name?: unknown; message?: unknown };
  return {
    name: typeof o?.name === 'string' ? o.name : '',
    detail: typeof o?.message === 'string' ? o.message : String(e),
  };
}

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
      signal: AbortSignal.timeout(KV_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout 発火は DOMException('TimeoutError')、明示 abort は 'AbortError'。
    const { name, detail } = errInfo(e);
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'http_error', detail };
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
    return { ok: false, reason: 'parse_error', detail: errInfo(e).detail };
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

// キー削除 (idempotency claim の解放等)。削除数を返す (無ければ 0)。
export function kvDel(key: string): Promise<KvResult<number>> {
  return call<number>(['DEL', key]);
}

// GETDEL: 値取得と削除を atomic に行う (Redis 6.2+)。one-time トークン (OAuth state 等) の
// 消費で get→del の TOCTOU を避けるために使う。未存在は null。
export function kvGetDel(key: string): Promise<KvResult<string | null>> {
  return call<string | null>(['GETDEL', key]);
}
