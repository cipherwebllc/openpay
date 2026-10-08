// lib/relay/authorizationUsedLookup.ts: 署名が使われうる時刻のブロックに絞って、AuthorizationUsed を小分けに探す。
// 無料枠の RPC の範囲制限 (実測 2026-10-08: drpc 100・Alchemy 10 ブロック) を偽のチェーンで再現する。
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  AuthorizationLookupIncomplete,
  findAuthorizationUsedInWindow,
  type AuthorizationLogClient,
} from '@/lib/relay/authorizationUsedLookup';

const TX = `0x${'ab'.repeat(32)}` as Hex;
const OTHER = `0x${'cd'.repeat(32)}` as Hex;

type Chain = {
  /** ブロック番号 → 時刻 (秒)。0..latest。 */
  ts: bigint[];
  /** ブロック番号 → そのブロックの対象ログの tx hash。 */
  logs: Map<bigint, Hex>;
  /** 1 回の getLogs で許すブロック数 (これを超えると throw)。 */
  maxRange: bigint;
  /** getLogs をいつも失敗させる (RPC 障害)。 */
  down?: boolean;
};

/** 時刻 start から、各ブロックの間隔 gaps を順に足したチェーン。 */
function chain(start: bigint, gaps: number[], logs: [number, Hex][] = [], maxRange = 10n): Chain {
  const ts = [start];
  for (const g of gaps) ts.push(ts[ts.length - 1] + BigInt(g));
  return { ts, logs: new Map(logs.map(([b, h]) => [BigInt(b), h])), maxRange };
}

function client(c: Chain) {
  const calls = { latest: 0, block: 0, logs: [] as [bigint, bigint][] };
  const api: AuthorizationLogClient = {
    latestBlock: async () => {
      calls.latest += 1;
      const n = BigInt(c.ts.length - 1);
      return { number: n, timestamp: c.ts[Number(n)] };
    },
    blockTimestamp: async (n) => {
      calls.block += 1;
      const t = c.ts[Number(n)];
      if (t === undefined) throw new Error(`no block ${n}`);
      return t;
    },
    logs: async (from, to) => {
      calls.logs.push([from, to]);
      if (c.down) throw new Error('rpc down');
      if (to - from + 1n > c.maxRange) throw new Error('range too large');
      const out: Hex[] = [];
      for (let b = from; b <= to; b++) {
        const h = c.logs.get(b);
        if (h) out.push(h);
      }
      return out;
    },
  };
  return { api, calls };
}

const OPTS = { lookbackBlocks: 10_000n };
const T0 = 1_800_000_000n;
const every2s = (n: number) => Array.from({ length: n }, () => 2);

describe('findAuthorizationUsedInWindow', () => {
  it('10 ブロックまでの RPC (Alchemy 無料枠) でも、有効期限の前のブロックから見つける', async () => {
    // 3,000 ブロック (2 秒おき)。署名の期限は 2,500 番の時刻・使われたのは 2,450 番。
    const c = chain(T0, every2s(3000), [[2450, TX]], 10n);
    const { api, calls } = client(c);
    const validBefore = c.ts[2500];
    expect(await findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 210 }, OPTS)).toBe(TX);
    // 検索したのは期限の前 210 秒 (約 105 ブロック) の中だけ
    for (const [from, to] of calls.logs) {
      expect(c.ts[Number(from)]).toBeGreaterThanOrEqual(validBefore - 210n);
      expect(c.ts[Number(to)]).toBeLessThan(validBefore);
    }
    expect(calls.latest + calls.block + calls.logs.length).toBeLessThanOrEqual(40);
  });

  it('100 ブロックまでの RPC (drpc 無料枠): 20 分の窓でも少ない問い合わせで見つける', async () => {
    const c = chain(T0, every2s(5000), [[3900, TX]], 100n);
    const { api, calls } = client(c);
    const validBefore = c.ts[4000];
    expect(await findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 1200 }, OPTS)).toBe(TX);
    expect(calls.logs.every(([f, t]) => t - f + 1n <= 100n)).toBe(true);
    expect(calls.latest + calls.block + calls.logs.length).toBeLessThanOrEqual(30);
  });

  it('範囲を探しきって無ければ null (範囲の外のログ = 期限の後・窓より前は拾わない)', async () => {
    const c = chain(T0, every2s(3000), [[2500, TX], [2390, OTHER]], 10n);
    const { api } = client(c);
    // 期限 = 2,500 番の時刻 (そのブロックでは使えない)・窓 210 秒 = 2,395 番より後
    const validBefore = c.ts[2500];
    expect(await findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 210 }, OPTS)).toBeNull();
  });

  it('validAfter より前のブロックも探さない', async () => {
    const c = chain(T0, every2s(3000), [[2450, TX]], 100n);
    const { api, calls } = client(c);
    const validBefore = c.ts[2500];
    const validAfter = c.ts[2460];
    expect(await findAuthorizationUsedInWindow(api, { validAfter, validBefore, maxWindowSec: 1200 }, OPTS)).toBeNull();
    expect(Math.min(...calls.logs.map(([f]) => Number(f)))).toBeGreaterThan(2460);
  });

  it('ブロックの間隔がばらばら (Avalanche は tx が無いとブロックが出ない) でも範囲の端を正しく求める', async () => {
    // 1 秒・30 秒・1 秒… が混ざる
    const gaps = Array.from({ length: 2000 }, (_, i) => (i % 7 === 0 ? 30 : 1));
    const c = chain(T0, gaps, [[1500, TX]], 10n);
    const { api, calls } = client(c);
    const validBefore = c.ts[1520] + 1n;
    expect(await findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 120 }, OPTS)).toBe(TX);
    for (const [from, to] of calls.logs) {
      expect(c.ts[Number(from)]).toBeGreaterThanOrEqual(validBefore - 120n);
      expect(c.ts[Number(to)]).toBeLessThan(validBefore);
    }
  });

  it('まだ範囲の時刻のブロックが無ければ、ログを探さず null', async () => {
    const c = chain(T0, every2s(100), [], 10n);
    const { api, calls } = client(c);
    const validBefore = c.ts[100] + 500n; // 窓の始まり (期限 − 210 秒) が最新ブロックより後
    expect(await findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 210 }, OPTS)).toBeNull();
    expect(calls.logs).toHaveLength(0);
  });

  it('問い合わせの上限を超えたら throw (探しきれないのを「無い」と言わない)', async () => {
    // 10 ブロックずつで 20 分 (約 600 ブロック) は上限 60 回を超える
    const c = chain(T0, every2s(5000), [], 10n);
    const { api } = client(c);
    const validBefore = c.ts[4000];
    await expect(
      findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 1200 }, OPTS),
    ).rejects.toBeInstanceOf(AuthorizationLookupIncomplete);
  });

  it('最小の範囲でも拒まれる (RPC 障害) なら throw', async () => {
    const c = { ...chain(T0, every2s(3000), [[2450, TX]], 10n), down: true };
    const { api } = client(c);
    await expect(
      findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore: c.ts[2500], maxWindowSec: 210 }, OPTS),
    ).rejects.toBeInstanceOf(AuthorizationLookupIncomplete);
  });

  it('範囲がまるごと遡り幅 (今の 1 回検索と同じ 10,000 ブロック) より古いなら、探さずに throw (「無い」と言わない)', async () => {
    const c = chain(T0, every2s(3000), [[100, TX]], 100n);
    const { api, calls } = client(c);
    const validBefore = c.ts[150];
    await expect(
      findAuthorizationUsedInWindow(api, { validAfter: 0n, validBefore, maxWindowSec: 1200 }, { lookbackBlocks: 2_000n }),
    ).rejects.toThrow(/lookback/);
    expect(calls.logs).toHaveLength(0);
  });

  it('範囲の一部が遡り幅の外: 探せる所で見つかれば返し、見つからなければ throw', async () => {
    // 遡り幅 2,000 → 1,000 番より古いブロックは探せない。範囲は 950〜1,050 番あたり。
    const c = chain(T0, every2s(3000), [[1020, TX]], 100n);
    const validBefore = c.ts[1050];
    const opts = { lookbackBlocks: 2_000n };
    expect(await findAuthorizationUsedInWindow(client(c).api, { validAfter: 0n, validBefore, maxWindowSec: 200 }, opts)).toBe(TX);
    const missing = chain(T0, every2s(3000), [[960, TX]], 100n); // 探せない所にある
    await expect(
      findAuthorizationUsedInWindow(client(missing).api, { validAfter: 0n, validBefore, maxWindowSec: 200 }, opts),
    ).rejects.toThrow(/lookback/);
  });

  it('時間の締め切りを過ぎたら、待っている問い合わせも打ち切って throw (route の時間切れに波及させない)', async () => {
    const c = chain(T0, every2s(3000), [], 10n);
    const { api } = client(c);
    const slow: typeof api = { ...api, logs: (f, t) => new Promise((r) => setTimeout(() => r(api.logs(f, t)), 40)) };
    const started = Date.now();
    await expect(
      findAuthorizationUsedInWindow(slow, { validAfter: 0n, validBefore: c.ts[2500], maxWindowSec: 210 }, { ...OPTS, deadlineMs: 100 }),
    ).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('問い合わせが返らない (RPC が固まる) ときも締め切りで throw', async () => {
    const c = chain(T0, every2s(3000), [], 10n);
    const { api } = client(c);
    const hung: typeof api = { ...api, logs: () => new Promise(() => {}) };
    await expect(
      findAuthorizationUsedInWindow(hung, { validAfter: 0n, validBefore: c.ts[2500], maxWindowSec: 210 }, { ...OPTS, deadlineMs: 50 }),
    ).rejects.toThrow(/deadline/);
  });
});
