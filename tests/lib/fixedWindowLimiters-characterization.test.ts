// @vitest-environment node
// 第 7 回レビュー C3/C11: 固定窓の limiter 3 つ (checkReadRateLimit・checkIpRateLimit・Agent Activity の共有 API 予算) を、
// lib/kv の本物の transport と小さな Upstash REST の偽物 (INCR / EXPIRE [NX] / pipeline / 期限) で固定する。
// 中の送り方 (単発の INCR + 初回だけ EXPIRE か、pipeline の INCR + EXPIRE NX か) を変えても、次が変わらないことを条件にする:
//   上限まで通る・超えたら拒否・窓が明けたら通る・KV 障害は通す (fail-open)・鍵の形と期限の長さ。
// 1 回の判定あたりのコマンド数も固定する (Upstash は pipeline の中身を 1 件ずつ数える = 月 $0.5 の予算に直結する)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/tokens', () => ({
  defaultDeploymentForSymbol: () => ({
    symbol: 'jpyc',
    address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    chainId: 137,
  }),
}));
vi.mock('@/lib/relay/forwarderConfig', () => ({ jpycForwarderFor: () => null }));

import { checkIpRateLimit, checkReadRateLimit } from '@/lib/relay/relayGuards';
import { fetchAgentActivity } from '@/lib/agent/activityServer';

const KV_URL = 'https://char-kv.test';
// 2026-10-10T00:00:30Z = 60 秒窓のちょうど中ほど。
const T0 = Date.UTC(2026, 9, 10, 0, 0, 30);
const HASHED_IP = 'a'.repeat(64);
const ACTIVITY_ADDRESS = `0x${'1'.repeat(40)}`;

// --- Upstash REST の偽物 (この test で使うコマンドだけ) ---
type Entry = { value: number; expiresAt: number | null };
type Fault = 'reject' | 'http500' | undefined;
const db = new Map<string, Entry>();
/** KV への往復ごとに、送ったコマンド名の列 (単発は 1 要素・pipeline は要素数ぶん)。 */
const trips: string[][] = [];
let inject: (commands: string[][]) => Fault = () => undefined;
let etherscanCalls = 0;

function live(key: string): Entry | undefined {
  const entry = db.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    db.delete(key);
    return undefined;
  }
  return entry;
}

function exec([name, key, ...args]: string[]): { result: number } | { error: string } {
  if (name === 'INCR') {
    const entry = live(key) ?? { value: 0, expiresAt: null };
    entry.value += 1;
    db.set(key, entry);
    return { result: entry.value };
  }
  if (name === 'EXPIRE') {
    const entry = live(key);
    if (!entry) return { result: 0 };
    if (args[1] === 'NX' && entry.expiresAt !== null) return { result: 0 };
    entry.expiresAt = Date.now() + Number(args[0]) * 1000;
    return { result: 1 };
  }
  return { error: `ERR unsupported command ${name}` };
}

/** Redis の TTL と同じ読み方: 無い = -2・期限なし = -1・ある = 残り秒 (切り上げ)。 */
function ttl(key: string): number {
  const entry = live(key);
  if (!entry) return -2;
  if (entry.expiresAt === null) return -1;
  return Math.ceil((entry.expiresAt - Date.now()) / 1000);
}

function seed(key: string, value: number, ttlSec: number): void {
  db.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

/** 判定 1 回ぶんのコマンド数 (Upstash の課金単位)。 */
function commandCount(): number {
  return trips.reduce((sum, trip) => sum + trip.length, 0);
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://api.etherscan.io/')) {
    etherscanCalls += 1;
    return Response.json({ status: '0', message: 'No transactions found', result: [] });
  }
  const pipeline = url === `${KV_URL}/pipeline`;
  const body = JSON.parse(String(init?.body)) as string[] | string[][];
  const commands = pipeline ? (body as string[][]) : [body as string[]];
  trips.push(commands.map(([name]) => name));
  const fault = inject(commands);
  if (fault === 'reject') throw new TypeError('fetch failed');
  if (fault === 'http500') return new Response('{"error":"ERR injected"}', { status: 500 });
  const results = commands.map(exec);
  return Response.json(pipeline ? results : results[0]);
});

beforeEach(() => {
  db.clear();
  trips.length = 0;
  inject = () => undefined;
  etherscanCalls = 0;
  fetchMock.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', KV_URL);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'char-token');
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('ETHERSCAN_API_KEY', 'char-etherscan-key');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('checkReadRateLimit (時計に揃えた固定窓・鍵 rl:read:<key>:<floor(now/窓)>・期限 = 窓 × 2)', () => {
  const bucket = Math.floor(T0 / 60_000);
  const key = (b: number) => `rl:read:char:${b}`;

  it('上限まで通り、超えたら拒否し、時計の次の窓で通る', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) results.push(await checkReadRateLimit('char', 3, 60));
    expect(results).toEqual([true, true, true, false]);
    expect(db.get(key(bucket))?.value).toBe(4);
    expect(ttl(key(bucket))).toBe(120);

    // 窓の終わりの直前はまだ同じ窓。
    vi.setSystemTime((bucket + 1) * 60_000 - 1);
    expect(await checkReadRateLimit('char', 3, 60)).toBe(false);
    // 時計の分の境目で新しい鍵になり、通る (初回起点ではない)。
    vi.setSystemTime((bucket + 1) * 60_000);
    expect(await checkReadRateLimit('char', 3, 60)).toBe(true);
    expect(db.get(key(bucket + 1))?.value).toBe(1);
    expect(ttl(key(bucket + 1))).toBe(120);
  });

  it.each(['reject', 'http500'] as const)('KV 障害 (%s) は通す (fail-open)', async (fault) => {
    inject = () => fault;
    for (let i = 0; i < 3; i += 1) {
      await expect(checkReadRateLimit('char', 1, 60)).resolves.toBe(true);
    }
  });

  it('KV 未設定は KV に触れず通す', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    await expect(checkReadRateLimit('char', 1, 60)).resolves.toBe(true);
    expect(trips).toEqual([]);
  });

  it('1 回の判定のコマンド数 (現状): 窓の初回は INCR と EXPIRE の 2 往復 = 2・以降は INCR の 1 往復 = 1', async () => {
    await checkReadRateLimit('char', 3, 60);
    expect(trips).toEqual([['INCR'], ['EXPIRE']]);
    expect(commandCount()).toBe(2);
    trips.length = 0;
    await checkReadRateLimit('char', 3, 60);
    expect(trips).toEqual([['INCR']]);
    expect(commandCount()).toBe(1);
  });

  it('EXPIRE の往復だけが落ちると期限の無い鍵が残る (C11 の現状・鍵に時刻が入るので判定には効かない)', async () => {
    inject = (commands) => (commands.length === 1 && commands[0][0] === 'EXPIRE' ? 'reject' : undefined);
    await expect(checkReadRateLimit('char', 3, 60)).resolves.toBe(true);
    expect(ttl(key(bucket))).toBe(-1);
    // 次の窓は別の鍵なので、残った鍵は判定に影響しない。
    inject = () => undefined;
    vi.setSystemTime((bucket + 1) * 60_000);
    await expect(checkReadRateLimit('char', 3, 60)).resolves.toBe(true);
    expect(ttl(key(bucket + 1))).toBe(120);
  });
});

describe('checkIpRateLimit (初回起点の固定窓・鍵 iprl:v1:<scope>:<HMAC>・期限 = 窓)', () => {
  const key = `iprl:v1:char-scope:${HASHED_IP}`;

  it('上限まで通り、超えたら拒否し、初回から窓の長さが経つと通る (途中の呼び出しで期限を延ばさない)', async () => {
    expect(await checkIpRateLimit('char-scope', HASHED_IP, 3, 60)).toBe(true);
    vi.setSystemTime(T0 + 10_000);
    const results: boolean[] = [];
    for (let i = 0; i < 3; i += 1) results.push(await checkIpRateLimit('char-scope', HASHED_IP, 3, 60));
    expect(results).toEqual([true, true, false]);
    expect(ttl(key)).toBe(50);

    vi.setSystemTime(T0 + 60_000 - 1);
    expect(await checkIpRateLimit('char-scope', HASHED_IP, 3, 60)).toBe(false);
    vi.setSystemTime(T0 + 60_000);
    expect(await checkIpRateLimit('char-scope', HASHED_IP, 3, 60)).toBe(true);
    expect(db.get(key)?.value).toBe(1);
    expect(ttl(key)).toBe(60);
  });

  it.each(['reject', 'http500'] as const)('KV 障害 (%s) は通す (fail-open)', async (fault) => {
    inject = () => fault;
    for (let i = 0; i < 3; i += 1) {
      await expect(checkIpRateLimit('char-scope', HASHED_IP, 1, 60)).resolves.toBe(true);
    }
  });

  it('KV 未設定・IP の HMAC が無いときは KV に触れず通す', async () => {
    await expect(checkIpRateLimit('char-scope', null, 1, 60)).resolves.toBe(true);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    await expect(checkIpRateLimit('char-scope', HASHED_IP, 1, 60)).resolves.toBe(true);
    expect(trips).toEqual([]);
  });

  it('1 回の判定のコマンド数: 毎回 pipeline の 1 往復で INCR + EXPIRE NX = 2', async () => {
    await checkIpRateLimit('char-scope', HASHED_IP, 3, 60);
    await checkIpRateLimit('char-scope', HASHED_IP, 3, 60);
    expect(trips).toEqual([['INCR', 'EXPIRE'], ['INCR', 'EXPIRE']]);
    expect(commandCount()).toBe(4);
  });
});

describe('Agent Activity の共有 API 予算 (分 120・日 30,000・UTC)', () => {
  const minuteKey = (ms: number) => `agent:activity:budget:m:${Math.floor(ms / 60_000)}`;
  const dayKey = 'agent:activity:budget:d:2026-10-10';

  it('分 120 回まで通り、121 回目は busy で上流を呼ばず、次の分で通る', async () => {
    for (let i = 0; i < 120; i += 1) {
      expect(await fetchAgentActivity(ACTIVITY_ADDRESS)).toMatchObject({ ok: true });
    }
    expect(await fetchAgentActivity(ACTIVITY_ADDRESS)).toEqual({ ok: false, reason: 'busy' });
    expect(etherscanCalls).toBe(120);
    expect(ttl(minuteKey(T0))).toBe(120);
    expect(ttl(dayKey)).toBe(2 * 24 * 60 * 60);

    vi.setSystemTime((Math.floor(T0 / 60_000) + 1) * 60_000);
    expect(await fetchAgentActivity(ACTIVITY_ADDRESS)).toMatchObject({ ok: true });
    expect(etherscanCalls).toBe(121);
  });

  it('日 30,000 回まで通り、30,001 回目は busy', async () => {
    seed(dayKey, 29_999, 3600);
    expect(await fetchAgentActivity(ACTIVITY_ADDRESS)).toMatchObject({ ok: true });
    expect(await fetchAgentActivity(ACTIVITY_ADDRESS)).toEqual({ ok: false, reason: 'busy' });
    expect(etherscanCalls).toBe(1);
    // 期限のある日の鍵は EXPIRE NX で延ばさない。
    expect(ttl(dayKey)).toBe(3600);
  });

  it.each(['reject', 'http500'] as const)('KV 障害 (%s) は通す (閲覧を止めない fail-open)', async (fault) => {
    inject = () => fault;
    expect(await fetchAgentActivity(ACTIVITY_ADDRESS)).toMatchObject({ ok: true });
    expect(etherscanCalls).toBe(1);
  });

  it('1 回の閲覧のコマンド数: 分と日の pipeline 2 往復 × (INCR + EXPIRE NX) = 4', async () => {
    await fetchAgentActivity(ACTIVITY_ADDRESS);
    expect(trips).toEqual([['INCR', 'EXPIRE'], ['INCR', 'EXPIRE']]);
    expect(commandCount()).toBe(4);
  });
});
