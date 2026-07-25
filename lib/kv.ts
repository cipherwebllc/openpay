import 'server-only';

// Upstash Redis REST への薄い fetch wrapper。env (KV_REST_API_URL /
// KV_REST_API_TOKEN) 未設定時は ok:false / unconfigured を返し、呼出側で
// 「server log のみ」に degrade させる前提。

type KvOk<T> = { ok: true; value: T };
type KvErr = {
  ok: false;
  // network_error = fetch 自体の失敗 (DNS/接続断・KV に届いていない)。
  // http_error = KV が応答した上での失敗 (非2xx or Upstash {error})。
  // 「KV 到達不能」と「KV がコマンドを拒否」の切り分けが alert triage に効く。
  reason: 'unconfigured' | 'network_error' | 'http_error' | 'parse_error' | 'timeout';
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
    // それ以外の fetch reject は KV に届く前の network 障害 (DNS/ECONNRESET 等)。
    const { name, detail } = errInfo(e);
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'network_error', detail };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', status: res.status };
  }
  try {
    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) {
      return { ok: false, reason: 'http_error', detail: json.error };
    }
    // result も error も無い body ({} 等) を ok:true value:undefined に仕立てると、
    // <number> 等に型を偽った undefined が呼出側の比較 (`r.value <= cap` 等) を黙って
    // 誤らせる。result キーの欠落は契約違反として parse_error で表面化させる
    // (kvGet の miss は {result: null} で届くため 'result' in json は true)。
    if (!('result' in json)) {
      return { ok: false, reason: 'parse_error', detail: 'missing result key' };
    }
    return { ok: true, value: json.result as T };
  } catch (e) {
    return { ok: false, reason: 'parse_error', detail: errInfo(e).detail };
  }
}

type KvLpushAtomicOptions = {
  trimStart: number;
  trimStop: number;
  ttlSec: number;
};

const LPUSH_TRIM_EXPIRE = `
local length = redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return length
`;

// opts 指定時は list 更新と TTL を同じ EVAL に閉じる。LPUSH だけ成功して TTL が欠落し、
// 利用者ごとの一時キーが KV に永久残存する波及を断つ。
export function kvLpush(
  key: string,
  value: string,
  opts?: KvLpushAtomicOptions,
): Promise<KvResult<number>> {
  if (opts) {
    return kvEval<number>(LPUSH_TRIM_EXPIRE, [key], [
      value,
      String(opts.trimStart),
      String(opts.trimStop),
      String(opts.ttlSec),
    ]);
  }
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

// LREM key 0 value: value の全出現を原子的に削除 (削除数を返す)。read-modify-write を
// 避けて list から 1 要素を消す (例: 所有 handle index からの解放)。
export function kvLrem(key: string, value: string): Promise<KvResult<number>> {
  return call<number>(['LREM', key, '0', value]);
}

// EVAL: Lua スクリプトを原子実行する。compare-and-set (例: 所有者一致時のみ更新/削除) など
// nx/incr で表せない原子操作に使う。Upstash REST は EVAL + 標準 Lua (cjson 含む) を提供。
export function kvEval<T = unknown>(
  script: string,
  keys: string[],
  args: string[],
): Promise<KvResult<T>> {
  return call<T>(['EVAL', script, String(keys.length), ...keys, ...args]);
}

// --- Phase B hardening 用の原子プリミティブ (nonce 採番 / idempotency / gas budget) ---

type KvIncrAtomicOptions = {
  initialTtlSec: number;
};

const INCR_EXPIRE_ON_FIRST = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// 原子インクリメント (採番カウンタ・gas budget)。初回は 1。opts 指定時は初回 TTL も同じ
// EVAL に閉じる。旧実装で既に TTL を失った counter も検知して期限を張り直し、後続リクエストを
// 恒久拒否する波及を断つ。期限が在る通常キーは延長しないため、固定窓の意味論は維持する。
export function kvIncr(
  key: string,
  opts?: KvIncrAtomicOptions,
): Promise<KvResult<number>> {
  if (opts) {
    return kvEval<number>(INCR_EXPIRE_ON_FIRST, [key], [
      String(opts.initialTtlSec),
    ]);
  }
  return call<number>(['INCR', key]);
}

// 原子デクリメント (gas budget の refund 等)。INCR で消費した枠を戻すのに使う。
export function kvDecr(key: string): Promise<KvResult<number>> {
  return call<number>(['DECR', key]);
}

// 値取得。未存在は null。
export function kvGet(key: string): Promise<KvResult<string | null>> {
  return call<string | null>(['GET', key]);
}

// 複数 key を 1 round-trip で読む。shops の materialized summary / live snapshot のように
// 同一時点の公開データをまとめて確定し、N+1 の REST 呼出を避ける用途。入力順と返却順は Redis
// MGET の契約で一致し、未存在 key は対応位置の null になる。
export function kvMget(
  keys: readonly string[],
): Promise<KvResult<(string | null)[]>> {
  if (keys.length === 0) {
    return Promise.resolve({ ok: true, value: [] });
  }
  return call<(string | null)[]>(['MGET', ...keys]);
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

// SET key value EX ttl NX GET — 原子的 claim。成功 (キー新設) なら null、既存なら旧値。
// claim 判定と旧値読取りを 1 round-trip にし、NX 失敗→GET 間の昇格 race を消す (Redis ≥7)。
export function kvSetNxGet(
  key: string,
  value: string,
  ttlSec: number,
): Promise<KvResult<string | null>> {
  return call<string | null>(['SET', key, value, 'EX', String(ttlSec), 'NX', 'GET']);
}
