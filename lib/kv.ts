// Upstash Redis REST API への薄い wrapper。@vercel/kv / @upstash/redis 等の
// package 依存を避け、fetch のみで動かす (alpha 段階の依存最小化)。
//
// 期待する env (Vercel KV を有効化すると自動 inject される):
//   KV_REST_API_URL    - https://xxxx.upstash.io
//   KV_REST_API_TOKEN  - 書込権限付き token
//
// 未設定時は kvLpush / kvLrange は { ok: false, reason: 'unconfigured' } を返す。
// 呼出側はそれを見て fallback (console log のみ) を選ぶ。

type KvResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unconfigured' | 'http_error' | 'parse_error'; status?: number; detail?: string };

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
