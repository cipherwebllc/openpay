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
};

export type ReverifyTarget =
  | { kind: 'external'; id: string }
  | { kind: 'first-party'; path: string };

export type ReverifyApplyResult =
  | {
      applied: true;
      failures: number;
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
const REVERIFY_INDEX_CAP = 500;
const REVERIFY_TIMEOUT_MS = 10_000;

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

// 定期再検証専用 probe。登録時 moderation と同じ SSRF-safe fetch を使う一方、確定的契約違反と
// 一時障害を分ける。body を完全に解釈できない 402/200 は hidden へ進めず transient に留める。
export async function probeForReverify(
  url: string,
  opts: SsrfSafeFetchOptions = {},
): Promise<ReverifyVerdict> {
  const res = await fetchSsrfSafe(url, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? REVERIFY_TIMEOUT_MS,
    userAgent: opts.userAgent ?? 'OpenPay-x402-reverify/1.0',
  });
  if (!res) return 'transient';

  if (res.status === 404 || res.status === 410) return 'violation_gone';
  if (res.status === 402) {
    const v2Accepts = parsedV2Accepts(res);
    if (v2Accepts) {
      return acceptsLookLikeOpenPay(v2Accepts)
        ? 'ok_402_openpay'
        : 'violation_foreign_402';
    }
    const body = await readJsonBodyCapped(res, GATE_BODY_MAX_BYTES);
    if (!body.ok || typeof body.value !== 'object' || body.value === null) {
      return 'transient';
    }
    return acceptsLookLikeOpenPay((body.value as { accepts?: unknown }).accepts)
      ? 'ok_402_openpay'
      : 'violation_foreign_402';
  }
  if (res.status === 200) {
    const body = await readBodyCapped(res, GATE_BODY_MAX_BYTES);
    if (!body) return 'transient';
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return 'transient';
    }
    return isCloudflareChallenge(res, text)
      ? 'transient'
      : 'violation_200_ungated';
  }
  // redirect・認証拒否・rate limit・server error は到達性/契約を確定できない。
  return 'transient';
}

export function isViolationVerdict(verdict: ReverifyVerdict): boolean {
  return verdict.startsWith('violation_');
}

// failures は確定違反だけを加算し、成功だけが連続違反列をリセットする。transient は観測時刻と
// runId だけを進め、直前までの failures/hidden を変えない。
export function transitionVerification(
  previous: VerificationState | null,
  verdict: ReverifyVerdict,
  checkedAt: string,
  runId: string,
  probedUrl: string,
): VerificationTransition {
  const sameUrl = previous?.verification?.probedUrl === probedUrl;
  const beforeHidden = sameUrl && previous?.hidden === true;
  const previousFailures = sameUrl ? previous?.verification?.failures ?? 0 : 0;
  const previousLastOkAt = sameUrl ? previous?.verification?.lastOkAt : undefined;

  let failures = previousFailures;
  let hidden = beforeHidden;
  let lastOkAt = previousLastOkAt;
  if (verdict === 'ok_402_openpay') {
    failures = 0;
    hidden = false;
    lastOkAt = checkedAt;
  } else if (isViolationVerdict(verdict)) {
    failures += 1;
    hidden = failures >= 3;
  }

  return {
    verification: {
      ...(lastOkAt ? { lastOkAt } : {}),
      lastCheckedAt: checkedAt,
      failures,
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
  return parsed;
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

const CAS_EXTERNAL_REVERIFY =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok or type(o)~=\'table\' then return -2 end; ' +
  'if o.active~=true then return 0 end; if o.url~=ARGV[1] then return -3 end; ' +
  'if type(o.verification)==\'table\' and o.verification.lastRunId==ARGV[3] then return -4 end; ' +
  'local same=(type(o.verification)==\'table\' and o.verification.probedUrl==ARGV[1]); ' +
  'local before=(same and o.hidden==true); local failures=0; local lastOk=nil; ' +
  'if same then ' +
  'failures=tonumber(o.verification.failures) or 0; lastOk=o.verification.lastOkAt; end; ' +
  'local hidden=before; if ARGV[4]==\'ok\' then failures=0; hidden=false; lastOk=ARGV[2]; ' +
  'elseif ARGV[4]==\'violation\' then failures=failures+1; hidden=(failures>=3); end; ' +
  'local v={lastCheckedAt=ARGV[2],failures=failures,lastRunId=ARGV[3],probedUrl=ARGV[1]}; ' +
  'if lastOk then v.lastOkAt=lastOk end; o.verification=v; o.hidden=hidden; ' +
  "redis.call('SET',KEYS[1],cjson.encode(o)); return cjson.encode({failures=failures,before=before,after=hidden})";

const CAS_FIRST_PARTY_REVERIFY =
  "local c=redis.call('GET',KEYS[1]); local o={}; if c then " +
  'local ok,decoded=pcall(cjson.decode,c); if not ok or type(decoded)~=\'table\' then return -2 end; o=decoded; end; ' +
  'if type(o.verification)==\'table\' and o.verification.lastRunId==ARGV[3] then return -4 end; ' +
  'local same=(type(o.verification)==\'table\' and o.verification.probedUrl==ARGV[1]); ' +
  'local before=(same and o.hidden==true); local failures=0; local lastOk=nil; ' +
  'if same then failures=tonumber(o.verification.failures) or 0; lastOk=o.verification.lastOkAt; end; ' +
  'local hidden=before; if ARGV[4]==\'ok\' then failures=0; hidden=false; lastOk=ARGV[2]; ' +
  'elseif ARGV[4]==\'violation\' then failures=failures+1; hidden=(failures>=3); end; ' +
  'local v={lastCheckedAt=ARGV[2],failures=failures,lastRunId=ARGV[3],probedUrl=ARGV[1]}; ' +
  'if lastOk then v.lastOkAt=lastOk end; o.verification=v; o.hidden=hidden; ' +
  "redis.call('SET',KEYS[1],cjson.encode(o)); return cjson.encode({failures=failures,before=before,after=hidden})";

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
    before: boolean;
    after: boolean;
  }>(value);
  if (!parsed || !Number.isFinite(parsed.failures)) {
    return { applied: false, reason: 'storage' };
  }
  return {
    applied: true,
    failures: parsed.failures,
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
): Promise<ReverifyApplyResult> {
  const applied = await kvEval<number | string>(
    CAS_EXTERNAL_REVERIFY,
    [resourceKey(id)],
    [probedUrl, checkedAt, runId, verdictClass(verdict)],
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
): Promise<ReverifyApplyResult> {
  const applied = await kvEval<number | string>(
    CAS_FIRST_PARTY_REVERIFY,
    [firstPartyVerificationKey(path)],
    [probedUrl, checkedAt, runId, verdictClass(verdict)],
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
