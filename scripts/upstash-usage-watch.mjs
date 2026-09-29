#!/usr/bin/env node
// Upstash の使用量の監視 (plans/upstash-usage-watch.md・.github/workflows/upstash-usage-watch.yml から毎日 1 回)。
//
// 本番 DB は従量課金 ($0.2 / 10 万コマンド・料金ページ)。user の上限は月 $0.5 = 25 万コマンド (2026-09-29)。
// 超えてよいのはモバイルオーダーの利用増の分だけなので、今月の見込みが上限を超えそうなら workflow を失敗させ
// (GitHub Actions の失敗通知)、user が判断する。上限は GitHub の変数 UPSTASH_CAP_COMMANDS で PR なしに変えられる。
//
// 呼ぶのは Upstash Developer API の stats (GET /v2/redis/stats/{id}) だけ。公式の Get Database の説明に
// 「credentials=hide で接続情報を応答から外す」とある = 既定では database の詳細に接続情報が含まれるので、それは呼ばない。
// 転送 (redirect) は追わない (stats 以外の URL へ認証ヘッダを送らない)。
// ログに出すのは数値と固定のエラーコードだけ (キー・メール・DB ID・応答本文・fetch の例外文は出さない)。
//
// 未確認 (初回の実行で確かめる・plans/upstash-usage-watch.md): total_monthly_requests が請求の単位 (コマンド数) と
// 一致するか・total_monthly_billing の単位 (ドル)・dailyrequests の形・月の区切り (UTC の暦月とみなしている)。
//
// 使い方:
//   node scripts/upstash-usage-watch.mjs          # 毎日の確認
//   node scripts/upstash-usage-watch.mjs --probe  # stats の呼び出しがコマンドに数えられるかの実測 (初回に 1 回)
import { pathToFileURL } from 'node:url';

export const STATS_BASE_URL = 'https://api.upstash.com/v2/redis/stats/';
/** 従量課金の単価 (料金ページ: $0.20 per 100K commands)。 */
export const DOLLARS_PER_COMMAND = 0.2 / 100_000;
/** 月の上限 (コマンド数)。月 $0.5 = 25 万。GitHub の変数 UPSTASH_CAP_COMMANDS で上書きできる。 */
export const DEFAULT_CAP_COMMANDS = 250_000;
/** この割合以上で警告 (失敗にはしない)。 */
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
      redirect: 'error',
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

/** 0 以上の有限な数だけを受ける (null・空文字・文字列を 0 と取り違えない)。 */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** stats の日ごとの系列 (`dailyrequests`: [{ x: '2026-09-28 00:00:00 +0000 UTC', y: 7000 }, ...]) を UTC の日ごとに 1 つへ。 */
export function dailySeries(stats) {
  const raw = stats?.dailyrequests;
  if (!Array.isArray(raw)) return [];
  const byDay = new Map();
  for (const point of raw) {
    const date = typeof point?.x === 'string' ? Date.parse(point.x.replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T')) : NaN;
    const count = countOf(point?.y);
    if (!Number.isFinite(date) || count === null) continue;
    const day = Math.floor(date / DAY_MS) * DAY_MS;
    byDay.set(day, count); // 同じ日が重なったら後のもの (系列は時刻順) を使う
  }
  return [...byDay.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date - b.date);
}

/**
 * 今月の見込み = 今月の実績 + 直近 7 日 (昨日までの UTC の 7 暦日のうち系列にある日) の平均 × 月末までの残り。
 * 系列が 1 日も無ければ今月の実績を経過時間 (小数の日) で割って伸ばす。経過が 1 日未満ならデータ不足として見込まない
 * (月初の 30 分を 1 日とみなすと最大 48 倍の過小評価になる)。月は UTC の暦月とみなす (未確認)。
 */
export function projectMonth(stats, nowMs) {
  const monthTotal = countOf(stats?.total_monthly_requests);
  if (monthTotal === null) throw new WatchError('stats_missing_monthly_total');
  const now = new Date(nowMs);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const remainingDays = (monthEnd - nowMs) / DAY_MS;
  const window = dailySeries(stats).filter((p) => p.date >= todayStart - 7 * DAY_MS && p.date < todayStart);
  if (window.length > 0) {
    const avgDaily = window.reduce((sum, p) => sum + p.count, 0) / window.length;
    return { monthTotal, avgDaily, projected: monthTotal + avgDaily * remainingDays, basis: `trailing_${window.length}d` };
  }
  const elapsedDays = (nowMs - monthStart) / DAY_MS;
  if (elapsedDays < 1) return { monthTotal, avgDaily: null, projected: null, basis: 'insufficient_data' };
  const avgDaily = monthTotal / elapsedDays;
  return { monthTotal, avgDaily, projected: avgDaily * ((monthEnd - monthStart) / DAY_MS), basis: 'month_to_date' };
}

/** 見込み (丸める前) と今月の請求額を上限と比べる。どちらで超えたかも返す。 */
export function assess({ projected, billing }, capCommands) {
  const capDollars = capCommands * DOLLARS_PER_COMMAND;
  const billingOver = billing !== null && billing > capDollars;
  if (projected === null) return { level: billingOver ? 'over' : 'unknown', trigger: billingOver ? 'billing' : null };
  if (projected > capCommands) return { level: 'over', trigger: 'commands' };
  if (billingOver) return { level: 'over', trigger: 'billing' };
  if (projected >= capCommands * WARN_RATIO) return { level: 'warn', trigger: 'commands' };
  return { level: 'ok', trigger: null };
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

const fmt = (n) => (n === null ? 'n/a' : Math.round(n).toLocaleString('en-US'));

/** 毎日の確認。戻り値の level で exit code を決める (over = 1)。 */
export async function watch({ env = process.env, fetchImpl = fetch, now = Date.now(), log = console.log } = {}) {
  const config = readEnv(env);
  const stats = await fetchStats({ ...config, fetchImpl });
  const projection = projectMonth(stats, now);
  const billing = countOf(stats?.total_monthly_billing);
  const result = assess({ projected: projection.projected, billing }, config.cap);
  log(`Upstash usage (${new Date(now).toISOString()}):`);
  log(`  today: ${fmt(countOf(stats?.daily_net_commands))} commands`);
  log(`  month to date: ${fmt(projection.monthTotal)} (total_monthly_requests)`);
  log(`  daily average: ${fmt(projection.avgDaily)} (${projection.basis})`);
  log(`  projected month: ${fmt(projection.projected)} / cap ${fmt(config.cap)}${projection.projected === null ? '' : ` (${(projection.projected / config.cap * 100).toFixed(0)}%)`}`);
  log(`  billing this month: ${billing === null ? 'n/a' : `${billing.toFixed(4)} (total_monthly_billing・単位はドルとみなす・未確認)`} / cap $${(config.cap * DOLLARS_PER_COMMAND).toFixed(2)}`);
  return { ...result, projection, billing, cap: config.cap };
}

/**
 * stats の呼び出し自体がコマンドに数えられるかの実測。
 *   1. 対照区間: stats を読む → waitMs 待つ → 読む (呼ぶのは前後の 2 回だけ)
 *   2. 試験区間: stats を読む → calls 回を間隔を空けて呼ぶ → waitMs 待つ → 読む
 * 試験区間の増分 − 対照区間の増分 が calls の半分を超えたら「数えられている」、±calls/2 以内なら「数えられていない」。
 * 対照区間の増分が 0 以下 (stats が待ち時間内に更新されない・月が変わった) や数値の欠けは「判定できない」
 * (背景の利用は時間帯でばらつくので、日平均から推定した背景とは比べない)。
 * 呼び出しは合計 calls + 4 回 (既定 54 回)。数えられる場合はその回数のコマンド (54 × $0.000002 = $0.000108) がかかる。
 */
export async function probe({ env = process.env, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, calls = 50, gapMs = 1_000, waitMs = 240_000 } = {}) {
  const config = readEnv(env);
  const read = async () => countOf((await fetchStats({ ...config, fetchImpl }))?.total_monthly_requests);
  const minute = new Date(now()).getUTCMinutes();
  if (minute < 10) log('  note: :00-:09 has hourly cron bursts (license repair・reverify); the control window may differ more');

  const controlStart = await read();
  await sleep(waitMs);
  const controlEnd = await read();

  const probeStart = await read();
  for (let i = 0; i < calls; i += 1) {
    await fetchStats({ ...config, fetchImpl });
    await sleep(gapMs);
  }
  await sleep(waitMs);
  const probeEnd = await read();

  const values = [controlStart, controlEnd, probeStart, probeEnd];
  const controlDelta = values.every((v) => v !== null) ? controlEnd - controlStart : null;
  const probeDelta = values.every((v) => v !== null) ? probeEnd - probeStart : null;
  let verdict;
  if (controlDelta === null || probeDelta === null || controlDelta <= 0 || probeDelta < 0) verdict = 'inconclusive';
  else if (probeDelta - controlDelta > calls / 2) verdict = 'counted';
  else verdict = 'not_counted';

  log(`Upstash stats probe: ${calls} extra stats calls (+4 reads)`);
  log(`  control window delta: ${fmt(controlDelta)} (no extra calls)`);
  log(`  probe window delta:   ${fmt(probeDelta)} (with ${calls} extra calls)`);
  log(`  result: ${{
    counted: `stats calls APPEAR TO BE COUNTED (probe − control > ${calls / 2})`,
    not_counted: `stats calls not counted (probe − control within ${calls / 2})`,
    inconclusive: 'inconclusive (stats did not update within the window, a counter was missing, or the month changed); rerun later',
  }[verdict]}`);
  return { verdict, controlDelta, probeDelta };
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error, ...deps } = {}) {
  try {
    if (argv.includes('--probe')) {
      const result = await probe({ log, ...deps });
      if (result.verdict === 'counted') {
        error('::error::Upstash stats calls appear to be counted as commands; disable the usage watch and report');
        return 1;
      }
      if (result.verdict === 'inconclusive') {
        error('::error::Upstash stats probe was inconclusive; rerun it later');
        return 1;
      }
      return 0;
    }
    const result = await watch({ log, ...deps });
    if (result.level === 'over') {
      error(result.trigger === 'billing'
        ? `::error::Upstash billing this month exceeds the cap ($${(result.cap * DOLLARS_PER_COMMAND).toFixed(2)}).`
        : `::error::Upstash projected monthly commands exceed the cap (${fmt(result.projection.projected)} > ${fmt(result.cap)}). Raise UPSTASH_CAP_COMMANDS only if the growth is mobile-order traffic.`);
      return 1;
    }
    if (result.level === 'warn') log(`::warning::Upstash projected monthly commands are at or above ${WARN_RATIO * 100}% of the cap`);
    if (result.level === 'unknown') log('::warning::Upstash usage projection needs at least one day of data this month');
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
