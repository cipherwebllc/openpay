// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAP_COMMANDS,
  STATS_BASE_URL,
  WatchError,
  assess,
  dailySeries,
  fetchStats,
  main,
  probe,
  projectMonth,
} from '@/scripts/upstash-usage-watch.mjs';

const EMAIL = 'owner@example.test';
const KEY = 'SECRET_MGMT_KEY_123';
const DB = 'db-id-SECRET-456';
const ENV = { UPSTASH_MGMT_EMAIL: EMAIL, UPSTASH_MGMT_API_KEY: KEY, UPSTASH_DB_ID: DB };

// 2026-10-10T12:00Z: 10 月は 31 日 → 月末まで 21.5 日。
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const day = (d: number) => `2026-10-${String(d).padStart(2, '0')} 00:00:00 +0000 UTC`;

function stats(monthTotal: number, perDay: number | null, billing = 0.1) {
  return {
    total_monthly_requests: monthTotal,
    daily_net_commands: 3_000,
    total_monthly_billing: billing,
    dailyrequests: perDay === null ? undefined : [...Array.from({ length: 9 }, (_, i) => ({ x: day(i + 1), y: perDay })), { x: day(10), y: 3_000 }],
  };
}

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('upstash-usage-watch: 見込みと判定', () => {
  it('今月の実績 + 直近 7 日 (今日を除く) の平均 × 残り日数で見込む', () => {
    const p = projectMonth(stats(66_000, 7_000), NOW);
    expect(p.basis).toBe('trailing_7d');
    expect(p.avgDaily).toBe(7_000);
    expect(p.projected).toBe(Math.round(66_000 + 7_000 * 21.5));
  });

  it('日ごとの系列が無い・形が違うときは今月の実績の日割り', () => {
    const p = projectMonth(stats(66_000, null), NOW);
    expect(p.basis).toBe('month_to_date');
    expect(p.projected).toBe(Math.round((66_000 / 9.5) * 31));
    expect(dailySeries({ dailyrequests: [{ x: 'bad', y: 1 }, { x: day(1), y: -1 }, 'x'] })).toEqual([]);
  });

  it('上限 (既定 25 万 = 月 $0.5) を超えたら over・80% 超で warn・請求額が上限の金額を超えても over', () => {
    expect(DEFAULT_CAP_COMMANDS).toBe(250_000);
    expect(assess({ projected: 250_001, billing: 0 }, 250_000)).toBe('over');
    expect(assess({ projected: 250_000, billing: 0 }, 250_000)).toBe('warn');
    expect(assess({ projected: 200_001, billing: 0 }, 250_000)).toBe('warn');
    expect(assess({ projected: 200_000, billing: 0 }, 250_000)).toBe('ok');
    expect(assess({ projected: 100_000, billing: 0.51 }, 250_000)).toBe('over');
    expect(assess({ projected: 100_000, billing: Number.NaN }, 250_000)).toBe('ok');
  });

  it('今月の実績が無い応答は失敗 (見込みを 0 と偽らない)', () => {
    expect(() => projectMonth({}, NOW)).toThrow(WatchError);
  });
});

describe('upstash-usage-watch: stats の取得', () => {
  it('stats だけを Basic 認証 (email:key) で呼ぶ', async () => {
    const fetchImpl = vi.fn(async () => okResponse(stats(1, 1)));
    await fetchStats({ email: EMAIL, apiKey: KEY, dbId: DB, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${STATS_BASE_URL}${DB}`);
    expect(url).toBe(`https://api.upstash.com/v2/redis/stats/${DB}`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${EMAIL}:${KEY}`).toString('base64')}`);
  });

  it('HTTP の失敗・通信の失敗・壊れた JSON は固定のコードだけ (URL や応答本文を含まない)', async () => {
    await expect(fetchStats({ email: EMAIL, apiKey: KEY, dbId: DB, fetchImpl: async () => new Response(`denied ${DB}`, { status: 401 }) })).rejects.toMatchObject({ code: 'stats_http_401', message: 'stats_http_401' });
    await expect(fetchStats({ email: EMAIL, apiKey: KEY, dbId: DB, fetchImpl: async () => { throw new Error(`connect ${STATS_BASE_URL}${DB}`); } })).rejects.toMatchObject({ message: 'stats_fetch_failed' });
    await expect(fetchStats({ email: EMAIL, apiKey: KEY, dbId: DB, fetchImpl: async () => new Response('<html>', { status: 200 }) })).rejects.toMatchObject({ message: 'stats_invalid_json' });
  });
});

describe('upstash-usage-watch: main', () => {
  async function run(argv: string[], deps: Record<string, unknown>) {
    const out: string[] = [];
    const code = await main(argv, { log: (l: string) => out.push(l), error: (l: string) => out.push(l), ...deps });
    return { code, text: out.join('\n') };
  }

  it('上限内は 0・数値だけを出し、キー・メール・DB ID は出さない', async () => {
    const { code, text } = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 5_000)) });
    expect(code).toBe(0);
    expect(text).toContain('projected month:');
    for (const secret of [EMAIL, KEY, DB]) expect(text).not.toContain(secret);
  });

  it('見込みが上限を超えたら 1 (通知)・80% 超は警告で 0・上限は変数で変えられる', async () => {
    const over = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 10_000)) });
    expect(over.code).toBe(1);
    expect(over.text).toContain('::error::Upstash projected monthly commands exceed the cap');
    const warn = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 7_000)) });
    expect(warn.code).toBe(0);
    expect(warn.text).toContain('::warning::');
    const raised = await run([], { env: { ...ENV, UPSTASH_CAP_COMMANDS: '500000' }, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 10_000)) });
    expect(raised.code).toBe(0);
  });

  it('Secrets の欠け・不正な上限・取得の失敗は固定のコードで 1 (本文や URL を出さない)', async () => {
    expect((await run([], { env: {}, now: NOW })).text).toContain('missing_env');
    expect((await run([], { env: { ...ENV, UPSTASH_CAP_COMMANDS: 'abc' }, now: NOW })).text).toContain('invalid_cap');
    const failed = await run([], { env: ENV, now: NOW, fetchImpl: async () => { throw new Error(`boom ${KEY} ${DB}`); } });
    expect(failed.code).toBe(1);
    expect(failed.text).toContain('stats_fetch_failed');
    for (const secret of [EMAIL, KEY, DB]) expect(failed.text).not.toContain(secret);
  });
});

describe('upstash-usage-watch: probe (stats の呼び出しが課金されないかの実測)', () => {
  function probeDeps(beforeTotal: number, afterTotal: number) {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      // 1 回目 = 前・最後 = 後。間の 100 回は前と同じ値。
      return okResponse(stats(calls === 102 ? afterTotal : beforeTotal, 8_640));
    });
    let clock = NOW;
    return { fetchImpl, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  }

  it('増分が背景 (日平均から出した待ち時間ぶん) + 呼び出し回数の半分以内なら「数えられていない」', async () => {
    // 日平均 8,640 = 0.1/秒 → 300 秒で背景 30。増分 40 は 30 + 50 以内。
    const deps = probeDeps(66_000, 66_040);
    const result = await probe({ env: ENV, ...deps, log: () => {} });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(102);
    expect(result).toMatchObject({ counted: false, delta: 40 });
    expect(result.background).toBeCloseTo(30);
  });

  it('増分が大きければ「数えられている」として main は 1', async () => {
    const deps = probeDeps(66_000, 66_200);
    const out: string[] = [];
    const code = await main(['--probe'], { env: ENV, ...deps, log: (l: string) => out.push(l), error: (l: string) => out.push(l) });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('APPEAR TO BE COUNTED');
  });
});
