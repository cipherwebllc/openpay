import 'server-only';

import { logger } from '@/lib/logger';

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

// 接続先の解決順: UPSTASH_REDIS_REST_URL/TOKEN (Upstash 直結・優先) → KV_REST_API_URL/TOKEN (互換)。
// KV_REST_API_* は Vercel の Storage 連携が注入・管理する名前で、手で書き換えた値が連携に戻される
// ことがある。連携に触られない別名を先に読み、接続先を運用者が確実に決められるようにする
// (2026-09-06 の障害対応で導入。障害の真因自体は minifier による Lua 破損 = lib/x402/reverify.ts)。
function endpoint(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

export function isKvConfigured(): boolean {
  return endpoint() !== null;
}

/** 接続先の診断情報 (ホスト名と採用した env 名のみ・トークンは含めない)。cron 応答や運用ログで
 *  「どの KV を叩いているか」を確かめるため (2026-09-06: env を切り替えても旧プロキシに残り続け、
 *  応答から接続先が読めず原因特定が遅れた)。 */
export function kvEndpointInfo(): {
  host: string | null;
  source: 'UPSTASH_REDIS_REST_URL' | 'KV_REST_API_URL' | null;
} {
  const ep = endpoint();
  if (!ep) return { host: null, source: null };
  let host: string | null = null;
  try {
    host = new URL(ep.url).host;
  } catch {
    host = null;
  }
  return {
    host,
    source: process.env.UPSTASH_REDIS_REST_URL ? 'UPSTASH_REDIS_REST_URL' : 'KV_REST_API_URL',
  };
}

// 1 往復の送信と HTTP 層の失敗の判定。本文の解釈 (単発 = {result}・pipeline = 要素ごとの配列) は呼出側。
async function post(path: '' | 'pipeline', body: unknown): Promise<KvResult<unknown>> {
  const ep = endpoint();
  if (!ep) return { ok: false, reason: 'unconfigured' };
  let res: Response;
  try {
    res = await fetch(`${ep.url}/${path}`, {
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
    // Upstash は Redis レベルの失敗 (WRONGTYPE / Lua 実行エラー / 引数不正 等) も非 2xx +
    // {error: "ERR ..."} で返す。body を捨てると detail が「400」だけになり、どのコマンドが
    // なぜ拒否されたか追えない (2026-09-06: reverify が 3 日間 503 で文言ゼロの実害)。
    // body の error 文字列だけを bounded に保持する (値・鍵は含めない)。
    let detail: string | undefined;
    try {
      const json = (await res.json()) as { error?: unknown };
      if (typeof json.error === 'string') detail = json.error.slice(0, 300);
    } catch {
      // body が JSON でない (proxy の HTML 等) 場合は status のみ。
    }
    return {
      ok: false,
      reason: 'http_error',
      status: res.status,
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  try {
    return { ok: true, value: await res.json() };
  } catch (e) {
    return { ok: false, reason: 'parse_error', detail: errInfo(e).detail };
  }
}

async function call<T>(body: unknown[]): Promise<KvResult<T>> {
  const sent = await post('', body);
  if (!sent.ok) return sent;
  try {
    const json = sent.value as { result?: T; error?: string };
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

// 原子インクリメント (採番カウンタ・gas budget)。初回は 1。opts 指定時は INCR と
// 「期限が無いときだけ期限を付ける」EXPIRE NX (Redis 7) を pipeline の 1 往復で送る。初回の INCR で
// できたキーにも、旧実装で TTL を失った counter にも同じ 1 命令で期限が付き (後続リクエストを恒久拒否する
// 波及を断つ)、期限が在るキーは延長しないため初回起点の固定窓の意味論は維持する。
// 以前は INCR・TTL・EXPIRE を 1 本の EVAL に閉じていたが、Upstash は EVAL を「本体 1 + 中の命令」で数えるので
// 1 回 3〜4 コマンドかかり、rate limit が KV 消費の最大要因だった (2026-10-01 本番実測)。pipeline は中の命令数
// だけ = 常に 2。2 命令は原子的でないので、窓の起点は「最初に成功した EXPIRE NX」になる (旧 Lua の「最初の INCR」と
// 厳密には同じでない)。同じ pipeline の INCR の直後に実行されるので、差は Upstash 内で他の要求が間に入った分だけ。
// 旧 Lua は「値 0 で期限ありのキーが INCR で 1 になる」と期限を張り直したが、opts 付きのキーを DECR / SET 0 する
// 呼出元は無い (2026-10-02 確認)。
// EXPIRE だけが失敗しても INCR の数は返す: 取れた「超過」の判定を捨てない。期限は次の呼び出しの EXPIRE NX が付ける。
export async function kvIncr(
  key: string,
  opts?: KvIncrAtomicOptions,
): Promise<KvResult<number>> {
  if (!opts) return call<number>(['INCR', key]);
  const sent = await post('pipeline', [
    ['INCR', key],
    ['EXPIRE', key, String(opts.initialTtlSec), 'NX'],
  ]);
  if (!sent.ok) return sent;
  const incr = Array.isArray(sent.value)
    ? (sent.value[0] as { result?: unknown; error?: unknown } | null | undefined)
    : undefined;
  if (incr && typeof incr.error === 'string') {
    return { ok: false, reason: 'http_error', detail: incr.error.slice(0, 300) };
  }
  if (!incr || typeof incr.result !== 'number') {
    return { ok: false, reason: 'parse_error', detail: 'unexpected pipeline result' };
  }
  const expire = (sent.value as unknown[])[1] as { result?: unknown; error?: unknown } | null | undefined;
  if (!expire || typeof expire.result !== 'number') noteExpireFailure(expire?.error);
  return { ok: true, value: incr.result };
}

// EXPIRE NX だけの失敗は INCR の数を返すので呼出側から見えない。失敗が続くと日付を含まない窓キー (IP 別 rate limit 等)
// が失効せず拒否し続けうるため、運用で気づけるよう警告する。鍵・値は出さない (鍵は IP の HMAC やアドレスを含む)。
// 1 instance 10 分に 1 回まで: 障害時に Sentry へ同じ警告を溢れさせない。
const EXPIRE_FAILURE_LOG_INTERVAL_MS = 10 * 60_000;
let lastExpireFailureLogAt = -Infinity;
function noteExpireFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastExpireFailureLogAt < EXPIRE_FAILURE_LOG_INTERVAL_MS) return;
  lastExpireFailureLogAt = now;
  logger.warn('kv.incr_expire_failed', {
    detail: typeof error === 'string' ? error.slice(0, 120) : 'unexpected pipeline result',
  });
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

// EXISTS k1 k2 …: 存在するキーの数 (1 コマンド)。空振りの多い定期処理を、対象が在るときだけ動かす判定に使う。
export function kvExists(keys: readonly string[]): Promise<KvResult<number>> {
  return call<number>(['EXISTS', ...keys]);
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
