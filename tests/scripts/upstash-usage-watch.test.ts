// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAP_COMMANDS,
  STATS_BASE_URL,
  WatchError,
  assess,
  commandBreakdown,
  dailySeries,
  minuteDeltas,
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

function stats(monthTotal: unknown, perDay: number | null, billing: unknown = 0.1) {
  return {
    total_monthly_requests: monthTotal,
    daily_net_commands: 3_000,
    total_monthly_billing: billing,
    dailyrequests: perDay === null ? undefined : [...Array.from({ length: 9 }, (_, i) => ({ x: day(i + 1), y: perDay })), { x: day(10), y: 3_000 }],
  };
}

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('upstash-usage-watch: 見込みと判定', () => {
  it('今月の実績 + 直近 7 暦日 (今日を除く) の平均 × 残り日数で見込む', () => {
    const p = projectMonth(stats(66_000, 7_000), NOW);
    expect(p.basis).toBe('trailing_7d');
    expect(p.avgDaily).toBe(7_000);
    expect(p.projected).toBe(66_000 + 7_000 * 21.5);
  });

  it('7 暦日より古い日・同じ日の重なりは平均に入れない', () => {
    const s = { total_monthly_requests: 0, dailyrequests: [
      { x: '2026-09-20 00:00:00 +0000 UTC', y: 999_999 },
      { x: day(9), y: 1_000 },
      { x: '2026-10-09 12:00:00 +0000 UTC', y: 2_000 },
    ] };
    const p = projectMonth(s, NOW);
    expect(p.basis).toBe('trailing_1d');
    expect(p.avgDaily).toBe(2_000);
  });

  it('系列が無ければ今月の実績を経過時間 (小数の日) で伸ばす・1 日未満はデータ不足として見込まない', () => {
    const p = projectMonth(stats(66_000, null), NOW);
    expect(p.basis).toBe('month_to_date');
    expect(p.projected).toBeCloseTo((66_000 / 9.5) * 31);
    const monthStart = projectMonth(stats(500, null), Date.UTC(2026, 9, 1, 0, 30));
    expect(monthStart).toMatchObject({ basis: 'insufficient_data', projected: null });
  });

  it('数でない今月の実績・日ごとの値 (null・空文字・文字列) を 0 と取り違えない', () => {
    for (const bad of [null, '', '66000', undefined, -1]) expect(() => projectMonth({ total_monthly_requests: bad }, NOW)).toThrow(WatchError);
    expect(dailySeries({ dailyrequests: [{ x: day(9), y: null }, { x: day(8), y: '5' }, { x: 'bad', y: 1 }, 'x'] })).toEqual([]);
  });

  it('公式の例の形 (ナノ秒・その日の時刻) を UTC の日に丸め、時差の書かれていない点は読まない', () => {
    expect(dailySeries({ dailyrequests: [
      { x: '2026-10-09 15:12:52.799480932 +0000 UTC', y: 4_000 },
      { x: '2026-10-08 00:00:00', y: 9_999 },
    ] })).toEqual([{ date: Date.UTC(2026, 9, 9), count: 4_000 }]);
  });

  it('上限 (既定 25 万 = 月 $0.5): 見込みが超えたら over・80% 以上で warn・請求額 (単位未確認) は超えても warn だけ', () => {
    expect(DEFAULT_CAP_COMMANDS).toBe(250_000);
    expect(assess({ projected: 250_000.4, billing: 0 }, 250_000)).toEqual({ level: 'over', trigger: 'commands' });
    expect(assess({ projected: 250_000, billing: 0 }, 250_000)).toEqual({ level: 'warn', trigger: 'commands' });
    expect(assess({ projected: 200_000, billing: 0 }, 250_000)).toEqual({ level: 'warn', trigger: 'commands' });
    expect(assess({ projected: 199_999, billing: 0 }, 250_000)).toEqual({ level: 'ok', trigger: null });
    expect(assess({ projected: 100_000, billing: 222.3 }, 250_000)).toEqual({ level: 'warn', trigger: 'billing' });
    expect(assess({ projected: null, billing: 0.51 }, 250_000)).toEqual({ level: 'warn', trigger: 'billing' });
    expect(assess({ projected: null, billing: null }, 250_000)).toEqual({ level: 'unknown', trigger: null });
  });
});

describe('upstash-usage-watch: コマンドの種類ごとの内訳', () => {
  const point = (h: number, y: unknown) => ({ x: `2026-10-10 ${String(h).padStart(2, '0')}:00:00.123456789 +0000 UTC`, y });

  it('command_counts の種類ごとに最新・最古の点と合計を返し、最新の多い順に並べる (点の期間と数も)', () => {
    const b = commandBreakdown({
      command_counts: [
        { metric_identifier: 'get', data_points: [point(1, 10), point(2, 5)] },
        { metric_identifier: 'EVAL', data_points: [point(0, 30), point(3, 20)] },
        { metric_identifier: 'JSON.GET', data_points: [point(2, 0)] },
      ],
    });
    expect(b?.rows).toEqual([
      { command: 'EVAL', last: 20, first: 30, sum: 50 },
      { command: 'GET', last: 5, first: 10, sum: 15 },
      { command: 'JSON.GET', last: 0, first: 0, sum: 0 },
    ]);
    expect(b?.totalLast).toBe(25);
    expect(b?.from).toBe(Date.parse('2026-10-10T00:00:00.123Z'));
    expect(b?.to).toBe(Date.parse('2026-10-10T03:00:00.123Z'));
    expect(b?.points).toBe(2);
  });

  it('コマンド名の形でない名前・数でない値・時差の無い点は出さない/数えない・欄が無ければ null', () => {
    const b = commandBreakdown({
      command_counts: [
        { metric_identifier: 'owner@example.test', data_points: [point(1, 99)] },
        { metric_identifier: 'SET key value', data_points: [point(1, 99)] },
        { metric_identifier: 'SET', data_points: [point(1, '7'), point(2, null), { x: '2026-10-10 05:00:00', y: 4 }, point(3, 2)] },
        { metric_identifier: 'DEL' },
      ],
    });
    expect(b?.rows).toEqual([{ command: 'SET', last: 2, first: 2, sum: 2 }]);
    expect(commandBreakdown({})).toBeNull();
  });
});

describe('upstash-usage-watch: 1 分ごとの増え方 (--minutes)', () => {
  const at = (m: number, y: unknown) => ({ x: `2026-10-10 16:${String(m).padStart(2, '0')}:30.5 +0000 UTC`, y });

  it('累計の隣り合う差を分ごとに足し、増えた分だけを返す (日付の変わり目で減ったら値そのものを増分)', () => {
    const rows = minuteDeltas({
      command_counts: [
        { metric_identifier: 'GET', data_points: [at(0, 100), at(1, 103), at(2, 103), at(3, 2)] },
        { metric_identifier: 'TYPE', data_points: [at(0, 50), at(1, 59)] },
        { metric_identifier: 'bad name!', data_points: [at(0, 0), at(1, 999)] },
      ],
    });
    expect(rows).toEqual([
      { minute: Date.parse('2026-10-10T16:01:00Z'), total: 12, commands: { GET: 3, TYPE: 9 } },
      { minute: Date.parse('2026-10-10T16:03:00Z'), total: 2, commands: { GET: 2 } },
    ]);
    expect(minuteDeltas({})).toEqual([]);
  });

  it('main --minutes は 1 分ごとの行を出して 0 (判定はしない・秘密は出さない)', async () => {
    const out: string[] = [];
    const body = { command_counts: [{ metric_identifier: 'EVAL', data_points: [at(14, 10), at(15, 15)] }] };
    const code = await main(['--minutes'], { env: ENV, fetchImpl: async () => okResponse(body), log: (l: string) => out.push(l), error: (l: string) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('  16:15     5  EVAL 5');
    for (const secret of [EMAIL, KEY, DB]) expect(out.join('\n')).not.toContain(secret);
  });
});

describe('upstash-usage-watch: stats の取得', () => {
  it('stats だけを Basic 認証 (email:key) で呼び、転送は追わない', async () => {
    const fetchImpl = vi.fn(async () => okResponse(stats(1, 1)));
    await fetchStats({ email: EMAIL, apiKey: KEY, dbId: DB, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${STATS_BASE_URL}${DB}`);
    expect(url).toBe(`https://api.upstash.com/v2/redis/stats/${DB}`);
    expect(init.redirect).toBe('error');
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
    expect(text).toContain('commands by type: n/a (command_counts missing)');
    for (const secret of [EMAIL, KEY, DB]) expect(text).not.toContain(secret);
  });

  it('内訳 (command_counts) と今日の読み書き・今月の Lua 実行数をログに出す', async () => {
    const body = {
      ...stats(66_000, 5_000),
      daily_read_requests: 1_200,
      daily_write_requests: 800,
      total_monthly_script_requests: 9_000,
      command_counts: [
        { metric_identifier: 'EVAL', data_points: [{ x: day(9), y: 300 }, { x: day(10), y: 100 }] },
        { metric_identifier: 'GET', data_points: [{ x: day(10), y: 100 }] },
      ],
    };
    const { code, text } = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(body) });
    expect(code).toBe(0);
    expect(text).toContain('today reads / writes: 1,200 / 800・scripts this month: 9,000');
    expect(text).toContain('commands by type (command_counts・2026-10-09 00:00 … 2026-10-10 00:00 UTC・up to 2 points each・sum of latest points 200):');
    expect(text).toContain('    EVAL: latest 100 (50.0%)・first 300・sum 400');
    expect(text).toContain('    GET: latest 100 (50.0%)・first 100・sum 100');
  });

  it('見込みが上限を超えたら 1・請求額 (単位未確認) の超過は警告で 0・80% 以上は警告で 0・上限は変数で変えられる', async () => {
    const over = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 10_000)) });
    expect(over.code).toBe(1);
    expect(over.text).toContain('::error::Upstash projected monthly commands exceed the cap');
    const billing = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 1_000, 222.3)) });
    expect(billing.code).toBe(0);
    expect(billing.text).toContain('::warning::total_monthly_billing exceeds $0.50 if it is in dollars (unit unverified)');
    expect(billing.text).toContain('dailyrequests: 10 points → 10 UTC days (2026-10-01 … 2026-10-10)');
    const warn = await run([], { env: ENV, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 7_000)) });
    expect(warn.code).toBe(0);
    expect(warn.text).toContain('::warning::');
    const raised = await run([], { env: { ...ENV, UPSTASH_CAP_COMMANDS: '500000' }, now: NOW, fetchImpl: async () => okResponse(stats(66_000, 10_000)) });
    expect(raised.code).toBe(0);
  });

  it('月初でデータが 1 日未満なら失敗にせず警告', async () => {
    const r = await run([], { env: ENV, now: Date.UTC(2026, 9, 1, 0, 30), fetchImpl: async () => okResponse(stats(500, null, 0)) });
    expect(r.code).toBe(0);
    expect(r.text).toContain('needs at least one day of data');
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

describe('upstash-usage-watch: probe (stats の呼び出しがコマンドに数えられるかの実測)', () => {
  // 読み取りの順: 対照の前・後、試験の前、(試験の呼び出し calls 回)、試験の後。
  function probeDeps(totals: { controlStart: unknown; controlEnd: unknown; probeStart: unknown; probeEnd: unknown }, calls = 10) {
    const sequence = [totals.controlStart, totals.controlEnd, totals.probeStart, ...Array.from({ length: calls }, () => totals.probeStart), totals.probeEnd];
    let i = 0;
    const fetchImpl = vi.fn(async () => okResponse({ total_monthly_requests: sequence[Math.min(i++, sequence.length - 1)] }));
    let clock = NOW + 20 * 60_000; // :20 (毎時の cron の外)
    return { fetchImpl, now: () => clock, sleep: async (ms: number) => { clock += ms; }, calls };
  }

  it('試験区間の増分 − 対照区間の増分 が呼び出しの半分以内なら「数えられていない」', async () => {
    const deps = probeDeps({ controlStart: 1_000, controlEnd: 1_030, probeStart: 1_030, probeEnd: 1_062 });
    const result = await probe({ env: ENV, ...deps, log: () => {} });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(14);
    expect(result).toEqual({ verdict: 'not_counted', controlDelta: 30, probeDelta: 32 });
  });

  it('差が呼び出しの半分を超えれば「数えられている」として main は 1', async () => {
    const deps = probeDeps({ controlStart: 1_000, controlEnd: 1_030, probeStart: 1_030, probeEnd: 1_070 });
    const out: string[] = [];
    const code = await main(['--probe'], { env: ENV, ...deps, log: (l: string) => out.push(l), error: (l: string) => out.push(l) });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('APPEAR TO BE COUNTED');
  });

  it('既定は 200 回 (+ 読み取り 4 回) を 5 秒の timeout で呼ぶ', async () => {
    const deps = probeDeps({ controlStart: 1_000, controlEnd: 1_030, probeStart: 1_030, probeEnd: 1_060 }, 200);
    const result = await probe({ env: ENV, fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep, log: () => {} });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(204);
    expect(result.verdict).toBe('not_counted');
  });

  it('stats が更新されない (対照の増分 0)・数値の欠け・月の変わり目 (減少)・対照区間に利用の山 (差 < −calls/2) は「判定できない」で 1', async () => {
    for (const totals of [
      { controlStart: 1_000, controlEnd: 1_000, probeStart: 1_000, probeEnd: 1_000 },
      { controlStart: 1_000, controlEnd: 1_040, probeStart: 1_040, probeEnd: 1_050 },
      { controlStart: 1_000, controlEnd: null, probeStart: 1_000, probeEnd: 1_100 },
      { controlStart: 1_000, controlEnd: 1_030, probeStart: 1_030, probeEnd: 5 },
    ]) {
      const out: string[] = [];
      const code = await main(['--probe'], { env: ENV, ...probeDeps(totals), log: (l: string) => out.push(l), error: (l: string) => out.push(l) });
      expect(code).toBe(1);
      expect(out.join('\n')).toContain('inconclusive');
    }
  });
});
