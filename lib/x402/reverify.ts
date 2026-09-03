import 'server-only';

import { readBodyCapped, readJsonBodyCapped } from '@/lib/httpBodyCap';
import { kvEval, kvGet, kvLrange, kvSet } from '@/lib/kv';
import {
  acceptsLookLikeOpenPay,
  fetchSsrfSafe,
  GATE_BODY_MAX_BYTES,
  type SsrfSafeFetchOptions,
} from '@/lib/x402/moderation';
import {
  RESOURCES_INDEX,
  resourceKey,
  type X402Resource,
  type X402Verification,
} from '@/lib/x402/registry';

export type ReverifyVerdict =
  | 'ok_402_openpay'
  | 'violation_200_ungated'
  | 'violation_gone'
  | 'violation_foreign_402'
  | 'transient';

// 契約判定 (verdict) とは独立した「こちらが締め出されているか」の軸 (B8)。
//   'clear'   = 素の 200/402 に到達した = 締め出されていない → authFailures を 0 に戻す
//   'block'   = 401/403・別 origin への redirect = この UA/IP を選別して拒否している疑い
//   'neutral' = 429/5xx・DNS/接続失敗・同一 origin redirect・challenge = どちらとも確定できない
export type ReverifyAuthClass = 'clear' | 'block' | 'neutral';

export type ReverifyProbe = {
  verdict: ReverifyVerdict;
  authClass: ReverifyAuthClass;
};

export type VerificationState = {
  verification?: X402Verification;
  hidden?: boolean;
};

export type VerificationTransition = {
  verification: X402Verification;
  hidden: boolean;
  hiddenTransition: 'hidden' | 'restored' | null;
};

export type ReverifyCursor = {
  offset: number;
  directoryDate?: string;
  // 同一 offset で storage エラーが連続した回数 (B12・cursor 凍結の解除判定)。
  storageErrorStreak?: number;
};

export type ReverifyTarget =
  | { kind: 'external'; id: string }
  | { kind: 'first-party'; path: string };

export type ReverifyApplyResult =
  | {
      applied: true;
      failures: number;
      authFailures: number;
      hiddenBefore: boolean;
      hiddenAfter: boolean;
    }
  | {
      applied: false;
      reason:
        | 'not_found'
        | 'malformed'
        | 'inactive'
        | 'url_changed'
        | 'duplicate'
        | 'storage';
    };

export const REVERIFY_CURSOR_KEY = 'reverify:cursor';
export const REVERIFY_LOCK_KEY = 'reverify:lock';
export const REVERIFY_BATCH_LIMIT = 25;
export const REVERIFY_CONCURRENCY = 5;
// 確定違反の連続回数で hidden にする閾値 (従来どおり 3)。
export const REVERIFY_HIDE_THRESHOLD = 3;
// 401/403/別 origin redirect の連続回数で hidden にする閾値 (B8)。cron は毎時なので 6 = 約 6 時間。
// 契約違反 (3) より緩いのは、正当な運用でも一時的に 403 を返す構成 (WAF の誤検知等) があるため。
export const REVERIFY_AUTH_HIDE_THRESHOLD = 6;
// 同一 offset で storage エラーが連続したら quarantine して cursor を進める閾値 (B12)。
export const REVERIFY_STORAGE_ERROR_QUARANTINE = 3;
const REVERIFY_INDEX_CAP = 500;
const REVERIFY_TIMEOUT_MS = 10_000;
const REVERIFY_UA_ROTATION_MS = 3_600_000; // 1 時間 = cron の 1 周期

// 再検証 probe が名乗る User-Agent の集合 (B8)。固定 UA だけだと、200 を誰にでも返しつつ
// この UA にだけ 403/302 を返す cloaking 出品が「transient のまま永久掲載」になる。1 時間ごとに
// 素の identifying UA と一般的なブラウザ UA を交代させ、UA 選別を成立させない。
// **身元は UA ではなく専用ヘッダ (REVERIFY_IDENTITY_HEADER) で常に名乗る**ので、正直な運用者は
// ブラウザ UA の周回もヘッダで allow-list できる。
export const REVERIFY_USER_AGENTS: readonly string[] = [
  'OpenPay-x402-reverify/1.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

export const REVERIFY_IDENTITY_HEADER = 'x-openpay-reverify';

// 1 時間バケットで UA を選ぶ。同一 run 内は全対象が同じ UA (原因切り分けが容易)、run をまたぐと
// 交代する (cloaking が 1 つの UA を弾き続けても 6 連続 auth block には別 UA の回も混ざる)。
export function reverifyUserAgent(atMs: number = Date.now()): string {
  const bucket = Math.floor(atMs / REVERIFY_UA_ROTATION_MS);
  const length = REVERIFY_USER_AGENTS.length;
  return REVERIFY_USER_AGENTS[((bucket % length) + length) % length];
}

const CLOUDFLARE_CHALLENGE_MARKERS = [
  'cf-chl-',
  'challenge-platform',
  'just a moment...',
  'attention required! | cloudflare',
];

function isCloudflareChallenge(res: Response, body: string): boolean {
  if (res.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return true;
  const normalized = body.toLowerCase();
  return CLOUDFLARE_CHALLENGE_MARKERS.some((marker) =>
    normalized.includes(marker),
  );
}

function parsedV2Accepts(res: Response): unknown[] | null {
  const header = res.headers.get('payment-required');
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      accepts?: unknown;
    };
    return Array.isArray(decoded.accepts) ? decoded.accepts : null;
  } catch {
    return null;
  }
}

// 3xx の Location が別 origin を指すか。redirect:'manual' で追跡しないため、ここでしか
// 「別ドメインへ飛ばして締め出す」cloaking を観測できない。相対 Location は同一 origin。
function redirectsToForeignOrigin(res: Response, url: string): boolean {
  const location = res.headers.get('location');
  if (!location) return false;
  try {
    return new URL(location, url).origin !== new URL(url).origin;
  } catch {
    // Location が URL として解釈できない = 到達先を確定できない。block と決めつけない。
    return false;
  }
}

// 定期再検証専用 probe。登録時 moderation と同じ SSRF-safe fetch を使う一方、確定的契約違反と
// 一時障害を分ける。body を完全に解釈できない 402/200 は hidden へ進めず transient に留める。
// verdict (契約) とは別に authClass (締め出され判定・B8) を返す。
export async function probeForReverifyDetailed(
  url: string,
  opts: SsrfSafeFetchOptions & { probeAtMs?: number } = {},
): Promise<ReverifyProbe> {
  const res = await fetchSsrfSafe(url, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? REVERIFY_TIMEOUT_MS,
    userAgent: opts.userAgent ?? reverifyUserAgent(opts.probeAtMs),
    extraHeaders: { [REVERIFY_IDENTITY_HEADER]: '1', ...(opts.extraHeaders ?? {}) },
  });
  if (!res) return { verdict: 'transient', authClass: 'neutral' };

  if (res.status === 404 || res.status === 410) {
    return { verdict: 'violation_gone', authClass: 'neutral' };
  }
  if (res.status === 401 || res.status === 403) {
    return { verdict: 'transient', authClass: 'block' };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      verdict: 'transient',
      authClass: redirectsToForeignOrigin(res, url) ? 'block' : 'neutral',
    };
  }
  if (res.status === 402) {
    return { verdict: await verdictFor402(res), authClass: 'clear' };
  }
  if (res.status === 200) {
    return verdictFor200(res, await readBodyCapped(res, GATE_BODY_MAX_BYTES));
  }
  // rate limit・server error は到達性/契約を確定できない。
  return { verdict: 'transient', authClass: 'neutral' };
}

// 後方互換の薄いラッパ (verdict だけ要る呼び元向け)。
export async function probeForReverify(
  url: string,
  opts: SsrfSafeFetchOptions & { probeAtMs?: number } = {},
): Promise<ReverifyVerdict> {
  return (await probeForReverifyDetailed(url, opts)).verdict;
}

async function verdictFor402(res: Response): Promise<ReverifyVerdict> {
  // v2 (PAYMENT-REQUIRED ヘッダ) → v1 (JSON body) の順に見て、**どちらかが** OpenPay 方式なら
  // 成功とする — 登録時 probeGate と同じフォールバック。dual-rail 出品の 402 は v2 面が
  // USDC のみ (extra.openpay を持たない) で正常なため、v2 だけで foreign 判定すると
  // dual-rail 化した瞬間に 3 巡で hidden → カタログ喪失 → 出品者ゲート 500 のデッドロックに
  // 陥る (2026-08-24 Aegis / gateway.open-pay.jp で実害)。
  const v2Accepts = parsedV2Accepts(res);
  if (v2Accepts && acceptsLookLikeOpenPay(v2Accepts)) return 'ok_402_openpay';
  const body = await readJsonBodyCapped(res, GATE_BODY_MAX_BYTES);
  if (!body.ok || typeof body.value !== 'object' || body.value === null) {
    // v1 body を解釈できない 402 は hidden へ進めず transient に留める (v2 ヘッダが
    // foreign に見えても、確定違反の根拠としては不十分)。
    return 'transient';
  }
  return acceptsLookLikeOpenPay((body.value as { accepts?: unknown }).accepts)
    ? 'ok_402_openpay'
    : 'violation_foreign_402';
}

function verdictFor200(res: Response, body: Uint8Array | null): ReverifyProbe {
  if (!body) return { verdict: 'transient', authClass: 'neutral' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { verdict: 'transient', authClass: 'neutral' };
  }
  // challenge の 200 は「素の 200 に到達した」証拠にならないので clear にしない (bot 選別の一種)。
  return isCloudflareChallenge(res, text)
    ? { verdict: 'transient', authClass: 'neutral' }
    : { verdict: 'violation_200_ungated', authClass: 'clear' };
}

export function isViolationVerdict(verdict: ReverifyVerdict): boolean {
  return verdict.startsWith('violation_');
}

// failures は確定違反だけを加算し、成功だけが連続違反列をリセットする。transient は観測時刻と
// runId だけを進め、直前までの failures を変えない。
//
// hidden の扱い (B6/B8):
//   - 現在値 (o.hidden) を出発点にする。**URL が変わっても引き継ぐ** — owner の PATCH で
//     verification (カウンタ) はリセットされるが、モデレーション状態を PATCH 往復で洗い流せると
//     自動 hidden が無意味になる。
//   - 解除できるのは ok_402_openpay を観測したときだけ (「正規経路で復帰させる」)。
//   - 確定違反 3 連続 / auth block 6 連続で hidden を立てる。立てた後は失効させない (monotone)。
export function transitionVerification(
  previous: VerificationState | null,
  verdict: ReverifyVerdict,
  checkedAt: string,
  runId: string,
  probedUrl: string,
  authClass: ReverifyAuthClass = 'neutral',
): VerificationTransition {
  const sameUrl = previous?.verification?.probedUrl === probedUrl;
  const beforeHidden = previous?.hidden === true;
  const previousFailures = sameUrl ? previous?.verification?.failures ?? 0 : 0;
  const previousAuthFailures = sameUrl
    ? previous?.verification?.authFailures ?? 0
    : 0;
  const previousLastOkAt = sameUrl ? previous?.verification?.lastOkAt : undefined;

  let failures = previousFailures;
  let authFailures = previousAuthFailures;
  let hidden = beforeHidden;
  let lastOkAt = previousLastOkAt;
  if (verdict === 'ok_402_openpay') {
    failures = 0;
    hidden = false;
    lastOkAt = checkedAt;
  } else if (isViolationVerdict(verdict)) {
    failures += 1;
    if (failures >= REVERIFY_HIDE_THRESHOLD) hidden = true;
  }
  if (authClass === 'clear') {
    authFailures = 0;
  } else if (authClass === 'block') {
    authFailures += 1;
    if (authFailures >= REVERIFY_AUTH_HIDE_THRESHOLD) hidden = true;
  }

  return {
    verification: {
      ...(lastOkAt ? { lastOkAt } : {}),
      lastCheckedAt: checkedAt,
      failures,
      ...(authFailures > 0 ? { authFailures } : {}),
      lastRunId: runId,
      probedUrl,
    },
    hidden,
    hiddenTransition:
      beforeHidden === hidden ? null : hidden ? 'hidden' : 'restored',
  };
}

export function selectReverifyBatch(
  externalIds: readonly string[],
  firstPartyPaths: readonly string[],
  cursor: ReverifyCursor,
  limit = REVERIFY_BATCH_LIMIT,
): { targets: ReverifyTarget[]; nextOffset: number } {
  const uniqueIds = [...new Set(externalIds)];
  const uniquePaths = [...new Set(firstPartyPaths)];
  const all: ReverifyTarget[] = [
    ...uniqueIds.map((id) => ({ kind: 'external' as const, id })),
    ...uniquePaths.map((path) => ({ kind: 'first-party' as const, path })),
  ];
  if (all.length === 0 || limit <= 0) return { targets: [], nextOffset: 0 };

  const start = Number.isSafeInteger(cursor.offset)
    ? ((cursor.offset % all.length) + all.length) % all.length
    : 0;
  const count = Math.min(limit, all.length);
  const targets = Array.from(
    { length: count },
    (_, i) => all[(start + i) % all.length],
  );
  return { targets, nextOffset: (start + count) % all.length };
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker),
  );
  return results;
}

export function firstPartyVerificationKey(path: string): string {
  return `x402:fpverify:${path}`;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readReverifyCursor(): Promise<ReverifyCursor | null> {
  const got = await kvGet(REVERIFY_CURSOR_KEY);
  if (!got.ok) return null;
  if (got.value === null) return { offset: 0 };
  const parsed = safeParse<ReverifyCursor>(got.value);
  if (!parsed || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return null;
  // 壊れた streak (欠落/非整数/負) は 0 とみなす — quarantine を数え損なうだけで、cursor 自体の
  // 有効性 (offset) は損なわれていない。
  const streak = parsed.storageErrorStreak;
  return Number.isSafeInteger(streak) && (streak as number) > 0
    ? parsed
    : { ...parsed, storageErrorStreak: 0 };
}

export async function writeReverifyCursor(cursor: ReverifyCursor): Promise<boolean> {
  const saved = await kvSet(REVERIFY_CURSOR_KEY, JSON.stringify(cursor));
  return saved.ok && saved.value === 'OK';
}

export async function listExternalReverifyIds(): Promise<string[] | null> {
  const listed = await kvLrange(RESOURCES_INDEX, 0, REVERIFY_INDEX_CAP - 1);
  return listed.ok ? listed.value : null;
}

export async function readExternalReverifyTarget(
  id: string,
): Promise<{ ok: true; resource: X402Resource | null } | { ok: false }> {
  const got = await kvGet(resourceKey(id));
  if (!got.ok) return { ok: false };
  const resource = safeParse<X402Resource>(got.value);
  return { ok: true, resource: resource?.active === true ? resource : null };
}

export async function readFirstPartyVerification(
  path: string,
): Promise<{ ok: true; state: VerificationState | null } | { ok: false }> {
  const got = await kvGet(firstPartyVerificationKey(path));
  if (!got.ok) return { ok: false };
  if (got.value === null) return { ok: true, state: null };
  const state = safeParse<VerificationState>(got.value);
  return state ? { ok: true, state } : { ok: false };
}

// transitionVerification と同一のカウンタ遷移を Lua 側にも持たせる (両者は必ず一緒に直す)。
// ARGV = [probedUrl, checkedAt, runId, verdictClass, authClass]。
const REVERIFY_COUNTER_TRANSITION =
  'local same=(type(o.verification)==\'table\' and o.verification.probedUrl==ARGV[1]); ' +
  // ⚠️ before は same で絞らない — URL を変えても hidden (モデレーション状態) は引き継ぐ (B6)。
  'local before=(o.hidden==true); local failures=0; local authFailures=0; local lastOk=nil; ' +
  'if same then failures=tonumber(o.verification.failures) or 0; ' +
  'authFailures=tonumber(o.verification.authFailures) or 0; lastOk=o.verification.lastOkAt; end; ' +
  'local hidden=before; if ARGV[4]==\'ok\' then failures=0; hidden=false; lastOk=ARGV[2]; ' +
  'elseif ARGV[4]==\'violation\' then failures=failures+1; ' +
  `if failures>=${REVERIFY_HIDE_THRESHOLD} then hidden=true end; end; ` +
  'if ARGV[5]==\'clear\' then authFailures=0; ' +
  'elseif ARGV[5]==\'block\' then authFailures=authFailures+1; ' +
  `if authFailures>=${REVERIFY_AUTH_HIDE_THRESHOLD} then hidden=true end; end; ` +
  'local v={lastCheckedAt=ARGV[2],failures=failures,lastRunId=ARGV[3],probedUrl=ARGV[1]}; ' +
  'if authFailures>0 then v.authFailures=authFailures end; ' +
  'if lastOk then v.lastOkAt=lastOk end; o.verification=v; o.hidden=hidden; ' +
  "redis.call('SET',KEYS[1],cjson.encode(o)); " +
  'return cjson.encode({failures=failures,authFailures=authFailures,before=before,after=hidden})';

const CAS_EXTERNAL_REVERIFY =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok or type(o)~=\'table\' then return -2 end; ' +
  'if o.active~=true then return 0 end; if o.url~=ARGV[1] then return -3 end; ' +
  'if type(o.verification)==\'table\' and o.verification.lastRunId==ARGV[3] then return -4 end; ' +
  REVERIFY_COUNTER_TRANSITION;

const CAS_FIRST_PARTY_REVERIFY =
  "local c=redis.call('GET',KEYS[1]); local o={}; if c then " +
  'local ok,decoded=pcall(cjson.decode,c); if not ok or type(decoded)~=\'table\' then return -2 end; o=decoded; end; ' +
  'if type(o.verification)==\'table\' and o.verification.lastRunId==ARGV[3] then return -4 end; ' +
  REVERIFY_COUNTER_TRANSITION;

function verdictClass(verdict: ReverifyVerdict): 'ok' | 'violation' | 'transient' {
  if (verdict === 'ok_402_openpay') return 'ok';
  return isViolationVerdict(verdict) ? 'violation' : 'transient';
}

function parseApplyResult(value: number | string): ReverifyApplyResult {
  if (typeof value === 'number') {
    const reason =
      value === -1
        ? 'not_found'
        : value === -2
          ? 'malformed'
          : value === 0
            ? 'inactive'
            : value === -3
              ? 'url_changed'
              : value === -4
                ? 'duplicate'
                : 'storage';
    return { applied: false, reason };
  }
  const parsed = safeParse<{
    failures: number;
    authFailures?: number;
    before: boolean;
    after: boolean;
  }>(value);
  if (!parsed || !Number.isFinite(parsed.failures)) {
    return { applied: false, reason: 'storage' };
  }
  return {
    applied: true,
    failures: parsed.failures,
    authFailures: Number.isFinite(parsed.authFailures)
      ? (parsed.authFailures as number)
      : 0,
    hiddenBefore: parsed.before === true,
    hiddenAfter: parsed.after === true,
  };
}

export async function applyExternalReverify(
  id: string,
  probedUrl: string,
  verdict: ReverifyVerdict,
  checkedAt: string,
  runId: string,
  authClass: ReverifyAuthClass = 'neutral',
): Promise<ReverifyApplyResult> {
  const applied = await kvEval<number | string>(
    CAS_EXTERNAL_REVERIFY,
    [resourceKey(id)],
    [probedUrl, checkedAt, runId, verdictClass(verdict), authClass],
  );
  return applied.ok
    ? parseApplyResult(applied.value)
    : { applied: false, reason: 'storage' };
}

export async function applyFirstPartyReverify(
  path: string,
  probedUrl: string,
  verdict: ReverifyVerdict,
  checkedAt: string,
  runId: string,
  authClass: ReverifyAuthClass = 'neutral',
): Promise<ReverifyApplyResult> {
  const applied = await kvEval<number | string>(
    CAS_FIRST_PARTY_REVERIFY,
    [firstPartyVerificationKey(path)],
    [probedUrl, checkedAt, runId, verdictClass(verdict), authClass],
  );
  return applied.ok
    ? parseApplyResult(applied.value)
    : { applied: false, reason: 'storage' };
}

export async function acquireReverifyLock(
  runId: string,
): Promise<'acquired' | 'locked' | 'storage'> {
  const lock = await kvSet(REVERIFY_LOCK_KEY, runId, { nx: true, ttlSec: 300 });
  if (!lock.ok) return 'storage';
  return lock.value === 'OK' ? 'acquired' : 'locked';
}

const CAS_RELEASE_LOCK =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0";

export async function releaseReverifyLock(runId: string): Promise<void> {
  await kvEval<number>(CAS_RELEASE_LOCK, [REVERIFY_LOCK_KEY], [runId]);
}

export function utcHourRunId(date: Date): string {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, '');
}

export function utcDateId(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function sendReverifyAlert(
  webhookUrl: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    // 掟13: alert 配送障害が、検証 state の更新・自動 hidden/復帰へ波及するのを断つ。
    return false;
  }
}
