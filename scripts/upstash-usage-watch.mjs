#!/usr/bin/env node
// Upstash の使用量の監視 (plans/upstash-usage-watch.md・.github/workflows/upstash-usage-watch.yml から毎日 1 回)。
//
// 本番 DB は従量課金 ($0.2 / 10 万コマンド)。user の上限は月 $0.5 = 25 万コマンド (2026-09-29)。超えてよいのは
// モバイルオーダーの利用増の分だけなので、今月の見込みが上限を超えそうなら workflow を失敗させて通知 (GitHub のメール) し、
// user が判断する。上限は GitHub の変数 UPSTASH_CAP_COMMANDS で PR なしに変えられる。
//
// 呼ぶのは Upstash Developer API の stats (GET /v2/redis/stats/{id}) だけ。Read Only の管理キーでも
// database の詳細 (GET /v2/redis/database/{id}) は既定で接続用のパスワード・トークンを返すので、それは呼ばない。
// ログに出すのは数値と固定のエラーコードだけ (キー・メール・DB ID・応答本文・fetch の例外文は出さない)。
//
// 使い方:
//   node scripts/upstash-usage-watch.mjs          # 毎日の確認
//   node scripts/upstash-usage-watch.mjs --probe  # stats の呼び出しがコマンド (課金) に数えられないかの実測 (初回に 1 回)
import { pathToFileURL } from 'node:url';

export const STATS_BASE_URL = 'https://api.upstash.com/v2/redis/stats/';
/** 従量課金の単価 (料金ページ: $0.20 per 100K commands)。 */
export const DOLLARS_PER_COMMAND = 0.2 / 100_000;
/** 月の上限 (コマンド数)。月 $0.5 = 25 万。GitHub の変数 UPSTASH_CAP_COMMANDS で上書きできる。 */
export const DEFAULT_CAP_COMMANDS = 250_000;
/** この割合を超えたら警告 (失敗にはしない)。 */
export const WARN_RATIO = 0.8;
const DAY_MS = 24 * 60 * 60 * 1000;

export class WatchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** stats を 1 回読む。失敗は固定のコードだけを持つ WatchError (応答本文や URL を含む例外文を外へ出さない)。 */
export async function fetchStats({ email, apiKey, dbId, fetchImpl = fetch }) {
  const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');
  let res;
  try {
    res = await fetchImpl(`${STATS_BASE_URL}${encodeURIComponent(dbId)}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new WatchError('stats_fetch_failed');
  }
  if (!res.ok) throw new WatchError(`stats_http_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new WatchError('stats_invalid_json');
  }
}

/** stats の日ごとの系列 (`dailyrequests`: [{ x: '2026-09-28 00:00:00 +0000 UTC', y: 7000 }, ...]) を読む。形が違えば空。 */
export function dailySeries(stats) {
  const raw = stats?.dailyrequests;
  if (!Array.isArray(raw)) return [];
  const points = [];
  for (const point of raw) {
    const date = typeof point?.x === 'string' ? Date.parse(point.x.replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T')) : NaN;
    const count = Number(point?.y);
    if (Number.isFinite(date) && Number.isFinite(count) && count >= 0) points.push({ date, count });
  }
  return points.sort((a, b) => a.date - b.date);
}

/**
 * 今月の見込み = 今月の実績 + 直近 7 日 (今日を除く・日ごとの系列) の平均 × 月末までの残り。
 * 系列が取れなければ今月の実績の日割りで出す (月初は数字が暴れるので系列を優先する)。月は UTC の暦月とみなす (推定)。
 */
export function projectMonth(stats, nowMs) {
  const monthTotal = Number(stats?.total_monthly_requests);
  if (!Number.isFinite(monthTotal) || monthTotal < 0) throw new WatchError('stats_missing_monthly_total');
  const now = new Date(nowMs);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const remainingDays = (monthEnd - nowMs) / DAY_MS;
  const fullDays = dailySeries(stats).filter((p) => p.date < todayStart).slice(-7);
  if (fullDays.length > 0) {
    const avgDaily = fullDays.reduce((sum, p) => sum + p.count, 0) / fullDays.length;
    return { monthTotal, avgDaily, projected: Math.round(monthTotal + avgDaily * remainingDays), basis: `trailing_${fullDays.length}d` };
  }
  const elapsedDays = Math.max((nowMs - monthStart) / DAY_MS, 1);
  const avgDaily = monthTotal / elapsedDays;
  return { monthTotal, avgDaily, projected: Math.round(avgDaily * ((monthEnd - monthStart) / DAY_MS)), basis: 'month_to_date' };
}

/** 見込みと今月の請求額を上限と比べる。 */
export function assess({ projected, billing }, capCommands) {
  const capDollars = capCommands * DOLLARS_PER_COMMAND;
  if (projected > capCommands || (Number.isFinite(billing) && billing > capDollars)) return 'over';
  if (projected > capCommands * WARN_RATIO) return 'warn';
  return 'ok';
}

function readCap(raw) {
  if (raw === undefined || raw === '') return DEFAULT_CAP_COMMANDS;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap <= 0) throw new WatchError('invalid_cap');
  return cap;
}

function readEnv(env) {
  const email = env.UPSTASH_MGMT_EMAIL;
  const apiKey = env.UPSTASH_MGMT_API_KEY;
  const dbId = env.UPSTASH_DB_ID;
  if (!email || !apiKey || !dbId) throw new WatchError('missing_env');
  return { email, apiKey, dbId, cap: readCap(env.UPSTASH_CAP_COMMANDS) };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** 毎日の確認。戻り値の level で exit code を決める (over = 1)。 */
export async function watch({ env = process.env, fetchImpl = fetch, now = Date.now(), log = console.log } = {}) {
  const config = readEnv(env);
  const stats = await fetchStats({ ...config, fetchImpl });
  const projection = projectMonth(stats, now);
  const billing = Number(stats?.total_monthly_billing);
  const today = Number(stats?.daily_net_commands);
  const level = assess({ projected: projection.projected, billing }, config.cap);
  log(`Upstash usage (${new Date(now).toISOString()}):`);
  log(`  today: ${Number.isFinite(today) ? fmt(today) : 'n/a'} commands`);
  log(`  month to date: ${fmt(projection.monthTotal)} commands`);
  log(`  daily average: ${fmt(projection.avgDaily)} (${projection.basis})`);
  log(`  projected month: ${fmt(projection.projected)} / cap ${fmt(config.cap)} (${(projection.projected / config.cap * 100).toFixed(0)}%)`);
  log(`  billing this month: ${Number.isFinite(billing) ? `$${billing.toFixed(4)}` : 'n/a'} (cap $${(config.cap * DOLLARS_PER_COMMAND).toFixed(2)})`);
  return { level, projection, billing, cap: config.cap };
}

/**
 * stats の呼び出し自体がコマンド (課金) に数えられないかの実測。前後で今月の実績を読み、間に stats を calls 回呼ぶ。
 * 増分が背景 (直近の日平均から出した経過時間ぶん) + calls の半分を超えたら「数えられている」とみなす。
 * stats の集計が遅れると増分が 0 に見えることがあるので、待ち時間を置く (null 結果の解釈はログに添える)。
 */
export async function probe({ env = process.env, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, calls = 100, waitMs = 300_000 } = {}) {
  const config = readEnv(env);
  const startedAt = now();
  const minute = new Date(startedAt).getUTCMinutes();
  if (minute < 10) log('  note: :00-:09 has hourly cron bursts (license repair・reverify); results may be noisier');
  const before = await fetchStats({ ...config, fetchImpl });
  for (let i = 0; i < calls; i += 1) await fetchStats({ ...config, fetchImpl });
  await sleep(waitMs);
  const after = await fetchStats({ ...config, fetchImpl });
  const elapsedSec = (now() - startedAt) / 1000;
  const avgDaily = projectMonth(before, startedAt).avgDaily;
  const background = (avgDaily / 86_400) * elapsedSec;
  const delta = Number(after?.total_monthly_requests) - Number(before?.total_monthly_requests);
  const billingDelta = Number(after?.total_monthly_billing) - Number(before?.total_monthly_billing);
  const counted = Number.isFinite(delta) && delta > background + calls / 2;
  log(`Upstash stats probe: ${calls} stats calls, ${elapsedSec.toFixed(0)}s window`);
  log(`  month-to-date delta: ${Number.isFinite(delta) ? fmt(delta) : 'n/a'} commands (expected background ≈ ${fmt(background)})`);
  log(`  billing delta: ${Number.isFinite(billingDelta) ? `$${billingDelta.toFixed(6)}` : 'n/a'}`);
  log(counted
    ? `  result: stats calls APPEAR TO BE COUNTED (delta exceeds background + ${calls / 2})`
    : `  result: stats calls not counted (delta within background + ${calls / 2}; a delta of 0 may also mean the stats lag)`);
  return { counted, delta, background, billingDelta };
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error, ...deps } = {}) {
  try {
    if (argv.includes('--probe')) {
      const result = await probe({ log, ...deps });
      if (result.counted) {
        error('::error::Upstash stats calls appear to be counted as commands; disable the usage watch and report');
        return 1;
      }
      return 0;
    }
    const result = await watch({ log, ...deps });
    if (result.level === 'over') {
      error(`::error::Upstash projected monthly commands exceed the cap (${fmt(result.projection.projected)} > ${fmt(result.cap)}). Raise UPSTASH_CAP_COMMANDS only if the growth is mobile-order traffic.`);
      return 1;
    }
    if (result.level === 'warn') log(`::warning::Upstash projected monthly commands above ${WARN_RATIO * 100}% of the cap`);
    return 0;
  } catch (e) {
    // 例外文は URL や応答を含みうるので出さない。固定のコードだけ。
    error(`::error::upstash-usage-watch failed: ${e instanceof WatchError ? e.code : 'unexpected_error'}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
