// 本物の Lua を vitest 内で実行するためのハーネス (wasmoon = C Lua 5.4 の WASM ビルド)。
//
// これまで CAS 系テストは `vi.mock('@/lib/kv')` の kvEval が Lua のセマンティクスを
// TypeScript で再実装しているだけだったので、**Lua 文字列そのもの** (構文誤り・KEYS/ARGV の
// ズレ・redis.call の綴り) は実 Redis に当てるまで検出できなかった。ここでは lib/ の Lua 定数を
// そのまま実行し、redis.call / cjson を in-memory の fake store に繋ぐ。
//
// ⚠️ エミュレータであって Upstash 実機ではない。既知の差異は下記 KNOWN DIVERGENCES を参照。
// money-path の CAS は引き続き実機 smoke (掟 15) を省略しない。
//
// ## KNOWN DIVERGENCES (本番 Upstash Lua との差)
// 1. Lua のバージョン: 本番 Redis は Lua 5.1 (数値はすべて double・整数 subtype 無し)、
//    wasmoon は Lua 5.4 (整数 subtype あり)。本リポの script は `//` 整数除算や math.type 分岐を
//    使わないので実害は低いが、`tostring(1)` が 5.1 で "1"・5.4 でも "1" と一致する一方、
//    `tostring(1.0)` は 5.1 が "1"・5.4 が "1.0" になる。
// 2. cjson は JSON.stringify/parse の shim。
//    - 空テーブル `{}` は cjson と同じく `{}` (配列 `[]` ではない) にエンコードされる。
//      逆に言うと `cjson.decode('[]')` を再エンコードすると `{}` になる (本物の cjson も同じ)。
//    - 数値の書式が違う: 本物の cjson は `%.14g` なので 1/3 が `0.33333333333333`、
//      この shim は JS の既定 (17 桁) で `0.3333333333333333`。整数と 14 桁以内の
//      小数は一致する。
//    - Lua 5.4 の整数/浮動小数の区別は JSON に出ない (5.4 で `1.0` を encode すると
//      本物の cjson は `1.0`、この shim は `1`)。
//    - JSON の `null` は本物の cjson が `cjson.null` (lightuserdata) にするのに対し、
//      この shim は **キーごと落とす** (wasmoon が JS の null を Lua に push できないため)。
//      本リポの record に null は現れない。
// 3. redis.call のエラーは JS の例外として上がる。Lua の pcall では捕捉できるが、
//    エラーメッセージの文言は実 Redis と一致しない。
// 4. Lua 数値をコマンド引数に渡すと実 Redis は整数へ切り捨てて文字列化する。ここでも同じ
//    挙動を実装しているが、丸めモードの端の差は保証しない。
import { LuaFactory } from 'wasmoon';

// Redis が Lua に返す値の形。status reply は {ok=...}、error reply は {err=...}。
type RedisReply =
  | string
  | number
  | boolean
  | { ok: string }
  | { err: string }
  | (string | number)[];

// Lua → RESP 変換後に kvEval の呼び元が受け取る形。
export type RedisLuaValue =
  | string
  | number
  | null
  | RedisLuaValue[];

export type FakeRedisStore = {
  /** 文字列値 (GET/SET/INCR)。 */
  readonly strings: Map<string, string>;
  /** リスト (LPUSH/LREM/LTRIM/LLEN)。index 0 が head。 */
  readonly lists: Map<string, string[]>;
  /** sorted set (ZADD/ZSCORE/...)。member -> score。 */
  readonly zsets: Map<string, Map<string, number>>;
  /** set (SISMEMBER)。script 側に SADD が無いのでテストから直接 seed する。 */
  readonly sets: Map<string, Set<string>>;
  /** 仮想時計 (ms)。TTL/EXPIRE の検証で advance して進める。 */
  now(): number;
  setNow(ms: number): void;
  advance(ms: number): void;
  /** TTL を秒で設定 (仮想時計基準)。key が無ければ何もしない。 */
  setTtl(key: string, ttlSec: number): void;
  /** TTL 秒。key 無し = -2 / TTL 無し = -1 (Redis の TTL と同じ)。 */
  getTtl(key: string): number;
  /** TTL を外す。外せたら true。 */
  persist(key: string): boolean;
  /** キーを型に関わらず削除する (TTL も落とす)。存在したら true。 */
  delete(key: string): boolean;
  /** 期限切れキーを掃除する (コマンド実行前に自動で呼ばれる)。 */
  purgeExpired(): void;
  /** 存在するキー名 (期限切れを除く)。 */
  keys(): string[];
};

export function createFakeRedisStore(nowMs = 0): FakeRedisStore {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const expiry = new Map<string, number>();
  let clock = nowMs;

  const exists = (key: string): boolean =>
    strings.has(key) || lists.has(key) || zsets.has(key) || sets.has(key);

  const drop = (key: string): void => {
    strings.delete(key);
    lists.delete(key);
    zsets.delete(key);
    sets.delete(key);
    expiry.delete(key);
  };

  const store: FakeRedisStore = {
    strings,
    lists,
    zsets,
    sets,
    now: () => clock,
    setNow: (ms: number) => {
      clock = ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setTtl: (key: string, ttlSec: number) => {
      if (!exists(key)) return;
      expiry.set(key, clock + ttlSec * 1000);
    },
    getTtl: (key: string) => {
      store.purgeExpired();
      if (!exists(key)) return -2;
      const at = expiry.get(key);
      if (at === undefined) return -1;
      return Math.ceil((at - clock) / 1000);
    },
    persist: (key: string) => {
      store.purgeExpired();
      if (!exists(key) || !expiry.has(key)) return false;
      expiry.delete(key);
      return true;
    },
    delete: (key: string) => {
      store.purgeExpired();
      const had = exists(key);
      drop(key);
      return had;
    },
    purgeExpired: () => {
      for (const [key, at] of [...expiry]) {
        if (at <= clock) drop(key);
      }
    },
    keys: () => {
      store.purgeExpired();
      return [
        ...new Set([...strings.keys(), ...lists.keys(), ...zsets.keys(), ...sets.keys()]),
      ];
    },
  };
  return store;
}

// Redis はコマンド引数の Lua 数値を整数へ切り捨てて文字列化する。
function argToString(value: unknown): string {
  if (typeof value === 'number') return String(Math.trunc(value));
  if (typeof value === 'string') return value;
  if (value === true) return '1';
  if (value === false || value === null || value === undefined) {
    throw new Error('Lua redis lib command arguments must be strings or integers');
  }
  return String(value);
}

// score の文字列表現 (Redis は整数なら小数点を付けない・無限大は inf/-inf)。
function formatScore(score: number): string {
  if (score === Number.POSITIVE_INFINITY) return 'inf';
  if (score === Number.NEGATIVE_INFINITY) return '-inf';
  return String(score);
}

function parseScore(raw: string): number {
  const lowered = raw.toLowerCase();
  if (lowered === '+inf' || lowered === 'inf') return Number.POSITIVE_INFINITY;
  if (lowered === '-inf') return Number.NEGATIVE_INFINITY;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error('value is not a valid float');
  return n;
}

// ZRANGEBYSCORE の min/max ('(' 前置で排他)。
function parseRangeBound(raw: string): { value: number; exclusive: boolean } {
  if (raw.startsWith('(')) {
    return { value: parseScore(raw.slice(1)), exclusive: true };
  }
  return { value: parseScore(raw), exclusive: false };
}

// score 昇順 → 同点は member の辞書順 (Redis と同じ)。
function sortedMembers(zset: Map<string, number>): { member: string; score: number }[] {
  return [...zset]
    .map(([member, score]) => ({ member, score }))
    .sort((a, b) => (a.score === b.score ? (a.member < b.member ? -1 : 1) : a.score - b.score));
}

function normalizeIndex(index: number, length: number): number {
  return index < 0 ? Math.max(length + index, 0) : index;
}

// §1 のコマンド集合を fake store に対して実装する交換台。返り値は Redis が Lua へ渡す形。
export function dispatchRedisCommand(
  store: FakeRedisStore,
  command: string,
  rawArgs: unknown[],
): RedisReply {
  store.purgeExpired();
  const cmd = command.toUpperCase();
  const args = rawArgs.map(argToString);
  const key = args[0];

  switch (cmd) {
    case 'GET': {
      const value = store.strings.get(key);
      return value === undefined ? false : value;
    }
    case 'SET': {
      const value = args[1];
      let nx = false;
      let xx = false;
      let get = false;
      let keepTtl = false;
      let ttlMs: number | null = null;
      for (let i = 2; i < args.length; i += 1) {
        const opt = args[i].toUpperCase();
        if (opt === 'NX') nx = true;
        else if (opt === 'XX') xx = true;
        else if (opt === 'GET') get = true;
        else if (opt === 'KEEPTTL') keepTtl = true;
        else if (opt === 'EX') {
          ttlMs = Number(args[i + 1]) * 1000;
          i += 1;
        } else if (opt === 'PX') {
          ttlMs = Number(args[i + 1]);
          i += 1;
        } else throw new Error(`SET: unsupported option ${opt}`);
      }
      const existed = store.strings.has(key);
      const previous = store.strings.get(key);
      if ((nx && existed) || (xx && !existed)) {
        // 条件不成立: GET 付きなら旧値 (未存在は nil)、無しなら nil。
        return get ? (previous === undefined ? false : previous) : false;
      }
      store.strings.set(key, value);
      if (ttlMs !== null) store.setTtl(key, ttlMs / 1000);
      else if (!keepTtl) store.persist(key);
      if (get) return previous === undefined ? false : previous;
      return { ok: 'OK' };
    }
    case 'DEL': {
      let removed = 0;
      for (const k of args) {
        if (store.delete(k)) removed += 1;
      }
      return removed;
    }
    case 'EXISTS': {
      let count = 0;
      for (const k of args) {
        if (store.strings.has(k) || store.lists.has(k) || store.zsets.has(k) || store.sets.has(k)) {
          count += 1;
        }
      }
      return count;
    }
    case 'TTL':
      return store.getTtl(key);
    case 'EXPIRE': {
      if (store.getTtl(key) === -2) return 0;
      store.setTtl(key, Number(args[1]));
      return 1;
    }
    case 'PERSIST':
      return store.persist(key) ? 1 : 0;
    case 'INCR': {
      const current = store.strings.get(key);
      if (current !== undefined && !/^-?\d+$/.test(current)) {
        throw new Error('value is not an integer or out of range');
      }
      const next = (current === undefined ? 0 : Number(current)) + 1;
      store.strings.set(key, String(next));
      return next;
    }
    case 'TYPE': {
      if (store.strings.has(key)) return { ok: 'string' };
      if (store.lists.has(key)) return { ok: 'list' };
      if (store.zsets.has(key)) return { ok: 'zset' };
      if (store.sets.has(key)) return { ok: 'set' };
      return { ok: 'none' };
    }
    case 'LLEN':
      return store.lists.get(key)?.length ?? 0;
    case 'LPUSH': {
      const list = store.lists.get(key) ?? [];
      for (const value of args.slice(1)) list.unshift(value);
      store.lists.set(key, list);
      return list.length;
    }
    case 'LREM': {
      const list = store.lists.get(key);
      if (!list) return 0;
      const count = Number(args[1]);
      const value = args[2];
      let removed = 0;
      if (count === 0) {
        const kept = list.filter((v) => {
          if (v === value) {
            removed += 1;
            return false;
          }
          return true;
        });
        list.length = 0;
        list.push(...kept);
      } else {
        const limit = Math.abs(count);
        const order = count > 0 ? [...list.keys()] : [...list.keys()].reverse();
        const drop = new Set<number>();
        for (const index of order) {
          if (drop.size >= limit) break;
          if (list[index] === value) drop.add(index);
        }
        removed = drop.size;
        const kept = list.filter((_, index) => !drop.has(index));
        list.length = 0;
        list.push(...kept);
      }
      if (list.length === 0) store.lists.delete(key);
      return removed;
    }
    case 'LTRIM': {
      const list = store.lists.get(key);
      if (!list) return { ok: 'OK' };
      const start = normalizeIndex(Number(args[1]), list.length);
      const rawStop = Number(args[2]);
      const stop = rawStop < 0 ? list.length + rawStop : rawStop;
      const kept = start > stop ? [] : list.slice(start, stop + 1);
      if (kept.length === 0) store.lists.delete(key);
      else store.lists.set(key, kept);
      return { ok: 'OK' };
    }
    case 'ZADD': {
      const zset = store.zsets.get(key) ?? new Map<string, number>();
      let added = 0;
      for (let i = 1; i < args.length; i += 2) {
        const score = parseScore(args[i]);
        const member = args[i + 1];
        if (!zset.has(member)) added += 1;
        zset.set(member, score);
      }
      store.zsets.set(key, zset);
      return added;
    }
    case 'ZREM': {
      const zset = store.zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const member of args.slice(1)) {
        if (zset.delete(member)) removed += 1;
      }
      if (zset.size === 0) store.zsets.delete(key);
      return removed;
    }
    case 'ZSCORE': {
      const score = store.zsets.get(key)?.get(args[1]);
      return score === undefined ? false : formatScore(score);
    }
    case 'ZREVRANK': {
      const zset = store.zsets.get(key);
      if (!zset) return false;
      const reversed = sortedMembers(zset).reverse();
      const index = reversed.findIndex((entry) => entry.member === args[1]);
      return index === -1 ? false : index;
    }
    case 'ZREVRANGE': {
      const zset = store.zsets.get(key);
      const reversed = zset ? sortedMembers(zset).reverse() : [];
      const start = normalizeIndex(Number(args[1]), reversed.length);
      const rawStop = Number(args[2]);
      const stop = rawStop < 0 ? reversed.length + rawStop : rawStop;
      const slice = start > stop ? [] : reversed.slice(start, stop + 1);
      const withScores = args.slice(3).some((a) => a.toUpperCase() === 'WITHSCORES');
      return slice.flatMap((entry) =>
        withScores ? [entry.member, formatScore(entry.score)] : [entry.member],
      );
    }
    case 'ZRANGEBYSCORE': {
      const zset = store.zsets.get(key);
      const min = parseRangeBound(args[1]);
      const max = parseRangeBound(args[2]);
      let withScores = false;
      let offset = 0;
      let count = -1;
      for (let i = 3; i < args.length; i += 1) {
        const opt = args[i].toUpperCase();
        if (opt === 'WITHSCORES') withScores = true;
        else if (opt === 'LIMIT') {
          offset = Number(args[i + 1]);
          count = Number(args[i + 2]);
          i += 2;
        } else throw new Error(`ZRANGEBYSCORE: unsupported option ${opt}`);
      }
      let entries = (zset ? sortedMembers(zset) : []).filter(
        (entry) =>
          (min.exclusive ? entry.score > min.value : entry.score >= min.value) &&
          (max.exclusive ? entry.score < max.value : entry.score <= max.value),
      );
      entries = entries.slice(offset, count < 0 ? undefined : offset + count);
      return entries.flatMap((entry) =>
        withScores ? [entry.member, formatScore(entry.score)] : [entry.member],
      );
    }
    case 'SISMEMBER':
      return store.sets.get(key)?.has(args[1]) ? 1 : 0;
    default:
      throw new Error(`Unknown Redis command in Lua script: ${command}`);
  }
}

// Lua → RESP 変換 (Redis の規則):
//   number -> integer (切り捨て) / string -> bulk string / true -> 1 / false,nil -> null
//   table  -> multi bulk (nil で打ち切り) / {ok=..} -> status / {err=..} -> error
function luaToResp(value: unknown): RedisLuaValue {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return 1;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const out: RedisLuaValue[] = [];
    for (const element of value) {
      if (element === null || element === undefined) break; // nil で打ち切り
      out.push(luaToResp(element));
    }
    return out;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.err === 'string') throw new Error(record.err);
    if (typeof record.ok === 'string') return record.ok;
    // 穴のある table ({1,nil,3}) は wasmoon が配列にできず object で返す。Redis と同じく
    // index 1 から辿り、最初の nil で打ち切る (hash だけの table は空配列になる)。
    const out: RedisLuaValue[] = [];
    for (let i = 1; ; i += 1) {
      const element = record[String(i)];
      if (element === null || element === undefined) break;
      out.push(luaToResp(element));
    }
    return out;
  }
  return null;
}

// JSON の null は wasmoon が Lua へ push できない (本物の cjson は cjson.null)。
// キーごと落として「その値は無かった」形に寄せる — 上の KNOWN DIVERGENCES 2 を参照。
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null).map(stripNulls);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

type LuaEngine = Awaited<ReturnType<LuaFactory['createEngine']>>;

let enginePromise: Promise<LuaEngine> | null = null;
// 同一エンジンのグローバル (KEYS/ARGV/redis) を共有するため、実行は直列化する。
let queue: Promise<unknown> = Promise.resolve();

async function getEngine(): Promise<LuaEngine> {
  // enableProxy:false が要 — 既定 (proxy) だと JS object が Lua に **userdata** として入り、
  // script の `type(o)~='table'` ガードが全部 falsy 側に落ちる。
  enginePromise ??= new LuaFactory().createEngine({ enableProxy: false });
  return enginePromise;
}

/** vitest の afterAll から呼んで WASM エンジンを解放する。 */
export async function closeRedisLuaEngine(): Promise<void> {
  if (!enginePromise) return;
  const engine = await enginePromise;
  enginePromise = null;
  engine.global.close();
}

/**
 * lib/ の Lua 定数をそのまま実行する。KEYS/ARGV/redis/cjson を注入し、返り値を
 * Redis の Lua → RESP 規則で変換して返す (= kvEval の呼び元が受け取る形)。
 */
export function runRedisLua(
  script: string,
  keys: string[],
  argv: string[],
  store: FakeRedisStore,
): Promise<RedisLuaValue> {
  const run = queue.then(async () => {
    const lua = await getEngine();
    lua.global.set('KEYS', keys);
    lua.global.set('ARGV', argv);
    lua.global.set('redis', {
      call: (command: string, ...args: unknown[]) =>
        dispatchRedisCommand(store, command, args),
      // pcall は例外を投げずに {err=...} を返す (Redis と同じ)。
      pcall: (command: string, ...args: unknown[]) => {
        try {
          return dispatchRedisCommand(store, command, args);
        } catch (e) {
          return { err: e instanceof Error ? e.message : String(e) };
        }
      },
      status_reply: (message: string) => ({ ok: message }),
      error_reply: (message: string) => ({ err: message }),
    });
    lua.global.set('cjson', {
      encode: (value: unknown) => JSON.stringify(value),
      decode: (raw: string) => stripNulls(JSON.parse(raw)),
    });
    try {
      // script 中の top-level `return` を許すため無名関数で包む。local は関数内に閉じるので
      // 次の実行へグローバル汚染が漏れない。
      const result = await lua.doString(`return (function() ${script} end)()`);
      return luaToResp(result);
    } finally {
      // 次の呼び出しへ KEYS/ARGV を持ち越さない (undefined は push できないので空配列)。
      lua.global.set('KEYS', []);
      lua.global.set('ARGV', []);
    }
  });
  // 失敗しても後続の実行を止めない (queue 自体は常に解決させる)。
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
