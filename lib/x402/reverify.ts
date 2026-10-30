import 'server-only';
import { resourceUrlClaimKey, URL_CLAIM_GUARD } from './resourceUrlClaim.mjs';

import { readBodyPrefix, readJsonBodyCapped } from '@/lib/httpBodyCap';
import { kvEval, kvGet, kvLrange, kvSet } from '@/lib/kv';
import {
  acceptsLookLikeOpenPay,
  fetchSsrfSafeDetailed,
  GATE_BODY_MAX_BYTES,
  type SsrfSafeFetchOptions,
} from '@/lib/x402/moderation';
import {
  RESOURCES_INDEX,
  resourceKey,
  type X402Resource,
  type X402Verification,
} from '@/lib/x402/registry';
import {
  hiddenUrlLedgerKey,
  HIDDEN_URL_LEDGER_TTL_SEC,
  HIDDEN_URL_LEDGER_VALUE,
} from '@/lib/x402/hiddenUrlLedger';
import {
  gateAcceptMismatch,
  registrationAcceptExpectation,
  type GateAcceptMismatch,
} from '@/lib/x402/registrationGateMatch';
import {
  REVERIFY_AUTH_HIDE_THRESHOLD,
  REVERIFY_HIDE_THRESHOLD,
} from '@/lib/x402/reverifyThresholds';

export type ReverifyVerdict =
  | 'ok_402_openpay'
  | 'violation_200_ungated'
  | 'violation_gone'
  | 'violation_foreign_402'
  // 最初の再検証を待つ新規掲載 (pendingFirstVerification) だけに付く: OpenPay 方式の 402 だが、その JPYC accept が
  // 掲載の受取先・チェーン・JPYC・forwarder と合わない (probeForPendingFirstVerification)。違反には数えない
  // (verdictClass は transient・理由は probeForPendingFirstVerification)。
  | 'pending_gate_mismatch'
  | 'transient';

// 契約判定 (verdict) とは独立した「こちらが締め出されているか」の軸 (B8)。
//   'clear'   = 素の 200/402 に到達した = 締め出されていない → authFailures を 0 に戻す
//   'block'   = 401/403・別ホストへの redirect = この UA/IP を選別して拒否している疑い
//   'neutral' = 429/5xx・DNS/接続失敗・同一ホスト/正規化 redirect・challenge = どちらとも確定できない
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
  // storage エラーの無かった最後の batch の開始時刻 (ISO・cursor の保存が反映されたもの)。起動元 (Vercel Cron /
  // GitHub Actions) を問わず再検証が動いているかを、本番設定の検証が /api/cron/reverify-status で読む。
  lastOkAt?: string;
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
      /** カウンタは更新済みだが、claim の競合・障害で hidden 解除だけを保留。 */
      restoreBlocked?: 'url_taken' | 'storage';
    }
  | {
      applied: false;
      reason:
        | 'not_found'
        | 'malformed'
        | 'inactive'
        | 'url_changed'
        // probe の照合に使った受取先 (payTo) が、probe の間に編集されていた (url_changed と同じく結果を捨てる)。
        | 'pay_to_changed'
        | 'duplicate'
        | 'storage';
      /** storage 失敗の要約 (KV の reason/status/エラー文言)。運用ログ・cron 応答用。 */
      detail?: string;
    };

// KV 失敗を 1 行に要約する (値は含めない・reason / HTTP status / Upstash のエラー文言のみ)。
// 2026-09-03 から reverify が毎時 503 (storage_unavailable) を返し続けたが、apply/read の
// 失敗理由をどこにも残していなかったため、Sentry も cron ログも「storage」以上を語れず
// 3 日間原因を特定できなかった。観測できない障害は直せない (掟 13 の逆側)。
export function kvFailureDetail(failure: {
  reason: string;
  status?: number;
  detail?: string;
}): string {
  return [
    failure.reason,
    failure.status !== undefined ? String(failure.status) : '',
    (failure.detail ?? '').slice(0, 200),
  ]
    .filter(Boolean)
    .join(' ');
}

export const REVERIFY_CURSOR_KEY = 'reverify:cursor';
export const REVERIFY_LOCK_KEY = 'reverify:lock';
export const REVERIFY_BATCH_LIMIT = 25;
export const REVERIFY_CONCURRENCY = 5;
// hidden の閾値は client component (出品者向けの「要対応」表示) とも共有するため
// server 依存を持たない ./reverifyThresholds に置き、ここから再 export する。
export { REVERIFY_AUTH_HIDE_THRESHOLD, REVERIFY_HIDE_THRESHOLD };
// 同一 offset で storage エラーが連続したら quarantine して cursor を進める閾値 (B12)。
export const REVERIFY_STORAGE_ERROR_QUARANTINE = 3;
const REVERIFY_INDEX_CAP = 500;
const REVERIFY_TIMEOUT_MS = 10_000;
const REVERIFY_UA_ROTATION_MS = 3_600_000; // 1 時間 = cron の 1 周期

// 再検証 probe が名乗る User-Agent の集合 (B8)。固定 UA だけだと、200 を誰にでも返しつつ
// この UA にだけ 403/302 を返す cloaking 出品が「transient のまま永久掲載」になる。1 時間ごとに
// 素の identifying UA と一般的なブラウザ UA を交代させる。
// ⚠️ 交代が無効化できるのは **素朴な UA ブロックだけ**。IP レンジ・TLS 指紋・行動での選別は
// これでは崩せない (そこまでやる出品は authFailures の閾値で最終的に hidden になる)。
export const REVERIFY_USER_AGENTS: readonly string[] = [
  'OpenPay-x402-reverify/1.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

// 名乗る側の UA。この UA の回だけ身元ヘッダを付ける。
export const REVERIFY_IDENTIFYING_USER_AGENT = REVERIFY_USER_AGENTS[0];

// N-2: 身元ヘッダを **毎回** 付けると、cloaker は UA ではなくヘッダで選別すれば足りるので
// UA 交代が無意味になる。ヘッダは identifying UA の回にだけ付け、ブラウザ UA の回は素の
// ブラウザと見分けがつかない probe にする。正直な運用者は identifying の回をヘッダで
// allow-list でき、選別する出品は「ブラウザ UA の回」で必ず露見する。
export const REVERIFY_IDENTITY_HEADER = 'x-openpay-reverify';

export function reverifyIdentityHeaders(
  userAgent: string,
): Record<string, string> {
  return userAgent === REVERIFY_IDENTIFYING_USER_AGENT
    ? { [REVERIFY_IDENTITY_HEADER]: '1' }
    : {};
}

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

function isCloudflareChallenge(cfMitigated: string | null, body: string): boolean {
  if (cfMitigated?.toLowerCase() === 'challenge') return true;
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

function withoutWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

// 3xx の Location を「別ドメインへ飛ばして締め出している」か「正当な正規化」かに分ける。
// fetchSsrfSafe は redirect:'manual' なので undici は 3xx を **そのまま** 返す (追跡しない)。
// ここでしか cloaking の転送を観測できない代わりに、正当な 301 まで block にすると実害が出る:
//   apex→www / 旧ドメイン→新ドメイン / http→https の 301 を返す普通の出品が 6 時間で hidden に
//   なり、hidden は monotone (成功 probe まで解除されない) なので dual-rail の USDC 購入が
//   resolveTarget (lib/x402/dualRailRelay.ts) で 404 になる。
// よって block は **別ホストへ飛ばす場合だけ**。次は neutral (どちらとも確定しない):
//   (a) 相対 Location (= 同一ホスト)
//   (b) 同一ホストの http→https 昇格 (origin は変わるがホストは同じ)
//   (c) www. の付与/除去 (apex ⇄ www)
function redirectAuthClass(res: Response, url: string): ReverifyAuthClass {
  const location = res.headers.get('location');
  if (!location) return 'neutral';
  let source: URL;
  let target: URL;
  try {
    source = new URL(url);
    target = new URL(location, url);
  } catch {
    // Location が URL として解釈できない = 到達先を確定できない。block と決めつけない。
    return 'neutral';
  }
  const from = source.hostname.toLowerCase();
  const to = target.hostname.toLowerCase();
  if (to === from) return 'neutral'; // (a) (b)
  if (withoutWww(to) === withoutWww(from)) return 'neutral'; // (c)
  return 'block';
}

type ReverifyProbeOptions = SsrfSafeFetchOptions & { probeAtMs?: number };

// 定期再検証専用 probe。登録時 moderation と同じ SSRF-safe fetch を使う一方、確定的契約違反と
// 一時障害を分ける。body を完全に解釈できない 402 は hidden へ進めず transient に留める (200 は verdictFor200)。
// verdict (契約) とは別に authClass (締め出され判定・B8) を返す。
export async function probeForReverifyDetailed(
  url: string,
  opts: ReverifyProbeOptions = {},
): Promise<ReverifyProbe> {
  const { verdict, authClass } = await probeWithAccepts(url, opts);
  return { verdict, authClass };
}

// 最初の再検証を待つ新規掲載 (pendingFirstVerification) の probe (E-3)。OpenPay 方式の 402 (ok_402_openpay) を、登録と
// 同じ照合 (lib/x402/registrationGateMatch.ts・掲載の payTo を期待値にする) を通ったときだけ ok にする。合わなければ
// pending_gate_mismatch (verdictClass は transient) = 印つきの hidden のまま、カウンタも動かさない。
// 確定違反に数えない理由: 違反 3 連続で印が外れると (REVERIFY_PENDING_FIRST_VERIFICATION)、掲載は通常のモデレーションの
// hidden になる。その復帰 (ok で hidden を解く) は照合しない (公開中・モデレーションの掲載の verdict はこの PR で変えない)
// ので、同じ合わない 402 が 4 回目の再検証で ok になり、確かめていない受取先のまま公開される = 3 時間遅らせるだけになる。
// 照合の前の verdict (transient・ほかの違反) はそのまま。公開中の掲載はこの関数を使わない (probeForReverifyDetailed のまま)。
export async function probeForPendingFirstVerification(
  url: string,
  payTo: string,
  opts: ReverifyProbeOptions = {},
): Promise<ReverifyProbe & { mismatch?: GateAcceptMismatch }> {
  const { verdict, authClass, accepts } = await probeWithAccepts(url, opts);
  if (verdict !== 'ok_402_openpay') return { verdict, authClass };
  const mismatch = gateAcceptMismatch(accepts, registrationAcceptExpectation(payTo));
  return mismatch
    ? { verdict: 'pending_gate_mismatch', authClass, mismatch }
    : { verdict, authClass };
}

// probe の本体。ok_402_openpay のときだけ、OpenPay と判定した面 (v2 ヘッダか v1 body) の accepts を添える (それ以外は空)。
async function probeWithAccepts(
  url: string,
  opts: ReverifyProbeOptions,
): Promise<ReverifyProbe & { accepts: unknown[] }> {
  const userAgent = opts.userAgent ?? reverifyUserAgent(opts.probeAtMs);
  const { res, refused } = await fetchSsrfSafeDetailed(url, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? REVERIFY_TIMEOUT_MS,
    userAgent,
    extraHeaders: {
      ...reverifyIdentityHeaders(userAgent),
      ...(opts.extraHeaders ?? {}),
    },
  });
  if (!res) {
    // br 等の圧縮で止めた応答も、status が 200 なら支払いなしで 200 が返ったことは確か (本文は読んでいない)。
    return {
      ...(refused?.statusCode === 200
        ? verdictFor200(refused.cfMitigated, null)
        : { verdict: 'transient', authClass: 'neutral' }),
      accepts: [],
    };
  }

  if (res.status === 404 || res.status === 410) {
    return { verdict: 'violation_gone', authClass: 'neutral', accepts: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { verdict: 'transient', authClass: 'block', accepts: [] };
  }
  if (res.status >= 300 && res.status < 400) {
    return { verdict: 'transient', authClass: redirectAuthClass(res, url), accepts: [] };
  }
  if (res.status === 402) {
    return { ...(await verdictFor402(res)), authClass: 'clear' };
  }
  if (res.status === 200) {
    return {
      ...verdictFor200(
        res.headers.get('cf-mitigated'),
        await readBodyPrefix(res, GATE_BODY_MAX_BYTES),
      ),
      accepts: [],
    };
  }
  // rate limit・server error は到達性/契約を確定できない。
  return { verdict: 'transient', authClass: 'neutral', accepts: [] };
}

async function verdictFor402(res: Response): Promise<{ verdict: ReverifyVerdict; accepts: unknown[] }> {
  // v2 (PAYMENT-REQUIRED ヘッダ) → v1 (JSON body) の順に見て、**どちらかが** OpenPay 方式なら
  // 成功とする — 登録時 probeGate と同じフォールバック。dual-rail 出品の 402 は v2 面が
  // USDC のみ (extra.openpay を持たない) で正常なため、v2 だけで foreign 判定すると
  // dual-rail 化した瞬間に 3 巡で hidden → カタログ喪失 → 出品者ゲート 500 のデッドロックに
  // 陥る (2026-08-24 Aegis / gateway.open-pay.jp で実害)。
  // accepts は OpenPay と判定した面のもの (登録時 probeGateDetailed と同じ順・v2 が OpenPay なら body は読まない)。
  const v2Accepts = parsedV2Accepts(res);
  if (v2Accepts && acceptsLookLikeOpenPay(v2Accepts)) {
    return { verdict: 'ok_402_openpay', accepts: v2Accepts };
  }
  const body = await readJsonBodyCapped(res, GATE_BODY_MAX_BYTES);
  if (!body.ok || typeof body.value !== 'object' || body.value === null) {
    // v1 body を解釈できない 402 は hidden へ進めず transient に留める (v2 ヘッダが
    // foreign に見えても、確定違反の根拠としては不十分)。
    return { verdict: 'transient', accepts: [] };
  }
  const accepts = (body.value as { accepts?: unknown }).accepts;
  return acceptsLookLikeOpenPay(accepts)
    ? { verdict: 'ok_402_openpay', accepts: accepts as unknown[] }
    : { verdict: 'violation_foreign_402', accepts: [] };
}

// 支払いなしで 200 が返った時点で gate は無い。本文は bot の challenge を見分けるためだけに、先頭 64KiB を読む。
// 64KiB 超・stream の途中の失敗・非 UTF-8 (zip/PDF 等)・br 等で止めた (prefix は null) 200 も、200 は 200 なので違反に
// 数える — transient にすると、本文を大きくするだけで無料の URL が有料の掲載のまま残り続ける (E-1)。
// ただし challenge の印が先頭にあれば、64KiB 超でも transient (本文全体を捨てると大きい challenge で正当な gate を隠す)。
// challenge の印は header と ASCII の文字列なので、非 UTF-8 も置換文字つきで decode して同じく探す。
function verdictFor200(cfMitigated: string | null, prefix: Uint8Array | null): ReverifyProbe {
  const text = prefix ? new TextDecoder('utf-8').decode(prefix) : '';
  // challenge の 200 は「素の 200 に到達した」証拠にならないので clear にしない (bot 選別の一種)。
  return isCloudflareChallenge(cfMitigated, text)
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
): Promise<
  { ok: true; resource: X402Resource | null } | { ok: false; detail: string }
> {
  const got = await kvGet(resourceKey(id));
  if (!got.ok) return { ok: false, detail: kvFailureDetail(got) };
  const resource = safeParse<X402Resource>(got.value);
  return { ok: true, resource: resource?.active === true ? resource : null };
}

export async function readFirstPartyVerification(
  path: string,
): Promise<
  { ok: true; state: VerificationState | null } | { ok: false; detail: string }
> {
  const got = await kvGet(firstPartyVerificationKey(path));
  if (!got.ok) return { ok: false, detail: kvFailureDetail(got) };
  if (got.value === null) return { ok: true, state: null };
  const state = safeParse<VerificationState>(got.value);
  return state ? { ok: true, state } : { ok: false, detail: 'unparseable state' };
}

// transitionVerification と同一のカウンタ遷移を Lua 側にも持たせる (両者は必ず一緒に直す)。
// ARGV = [probedUrl, checkedAt, runId, verdictClass, authClass]。
// export しているのは tests/lib/x402/reverify-cas.test.ts が **本物の Lua** を wasmoon で
// 実行するため (tests/_helpers/redisLua.ts)。runtime の挙動には影響しない。
// Lua に埋め込む閾値 (文字列)。テンプレートリテラルを避けるため事前に文字列化する (下記の注意)。
const HIDE_THRESHOLD_LUA = String(REVERIFY_HIDE_THRESHOLD);
const AUTH_HIDE_THRESHOLD_LUA = String(REVERIFY_AUTH_HIDE_THRESHOLD);

export const REVERIFY_COUNTER_TRANSITION =
  'local same=(type(o.verification)==\'table\' and o.verification.probedUrl==ARGV[1]); ' +
  // ⚠️ before は same で絞らない — URL を変えても hidden (モデレーション状態) は引き継ぐ (B6)。
  'local before=(o.hidden==true); local failures=0; local authFailures=0; local lastOk=nil; ' +
  'if same then failures=tonumber(o.verification.failures) or 0; ' +
  'authFailures=tonumber(o.verification.authFailures) or 0; lastOk=o.verification.lastOkAt; end; ' +
  // ⚠️ この連結の中で **テンプレートリテラル (`...${x}...`) を使わない** (2026-09-03〜06 実害)。
  // Next.js の minifier が `+` 連結中のテンプレートの `${}` 以降の末尾と後続の文字列片を落とし、本番
  // バンドルだけ Lua が `failures>=3if ARGV[5]==...` に化けて EVAL が構文エラー (400) → 再検証 cron が
  // 3 日間 503 になった。vitest / dev / 本番 DB への直接 EVAL は全部「ソースの文字列」を使うので通り、
  // ビルド成果物でしか再現しない。閾値は String() で普通の連結にし、scripts/check-lua-bundle.mjs
  // (CI の build ステップ) がバンドル内の断片を検査、tests/lib/x402/reverify-cas.test.ts がソースに
  // テンプレートリテラルが無いことをフェンスする。
  // monotone な hidden は分岐の外の単文 if で立てる (意味は JS 側 transitionVerification と同一)。
  'local hidden=before; if ARGV[4]==\'ok\' then failures=0; hidden=false; lastOk=ARGV[2]; ' +
  'elseif ARGV[4]==\'violation\' then failures=failures+1; end; ' +
  'if ARGV[4]==\'violation\' and failures>=' +
  HIDE_THRESHOLD_LUA +
  ' then hidden=true end; ' +
  'if ARGV[5]==\'clear\' then authFailures=0; ' +
  'elseif ARGV[5]==\'block\' then authFailures=authFailures+1; end; ' +
  'if ARGV[5]==\'block\' and authFailures>=' +
  AUTH_HIDE_THRESHOLD_LUA +
  ' then hidden=true end; ' +
  'local v={lastCheckedAt=ARGV[2],failures=failures,lastRunId=ARGV[3],probedUrl=ARGV[1]}; ' +
  'if authFailures>0 then v.authFailures=authFailures end; ' +
  'if lastOk then v.lastOkAt=lastOk end; o.verification=v; o.hidden=hidden; ';

const REVERIFY_SAVE = "redis.call('SET',KEYS[1],cjson.encode(o)); ";

export const REVERIFY_TRANSITION_RESULT =
  'return cjson.encode({failures=failures,authFailures=authFailures,before=before,after=hidden})';

// N-5: hidden の間は URL 台帳 (KEYS[2]) を TTL つきで立て直す。DELETE → 同一 URL で再登録して
// hidden を洗い流す経路を塞ぐ (createResource が台帳を見て hidden を継承する)。hidden の観測ごとに
// TTL を延ばすので、隠されたままの掲載は台帳も生き続ける。first-party (path) は再登録できないので
// この節は external 側にだけ足す。
// 台帳の規則: hidden かつ印 (pendingFirstVerification) なしのときだけ書く。印は「一度も検証されていないから
// 隠しているだけ」の状態にしか残らない (下の REVERIFY_PENDING_FIRST_VERIFICATION が、公開に戻ったときと
// モデレーションの閾値に達したときに外す・台帳の継承と台帳済 URL への PATCH は registry が印を付けない/外す)。
// 印つきの hidden に台帳を書くと、洗い流す状態の無い新しい掲載を違反扱いにしてしまう。
export const REVERIFY_HIDDEN_URL_LEDGER =
  "if hidden and o.pendingFirstVerification~=true then redis.call('SET',KEYS[2],ARGV[6],'EX',ARGV[7]) end; ";

// 最初の再検証を待つ新規掲載の印 (pendingFirstVerification) を外す 2 つの場合:
//   (1) hidden が解けたとき (ok かつ URL claim を確かめた後)。claim の競合・障害で解除が保留された回は残す
//       (ID の照会で出品者のゲートが動き続け、次の ok で戻れる)。
//   (2) 公開中の掲載なら hidden になる閾値 (確定違反 3 連続・締め出し 6 連続) に達したとき = 通常の
//       モデレーションで隠された状態に移す。以後は印のない hidden (ID の照会も 404・台帳あり) として扱う。
//       閾値の前に外さないのは、デプロイ前の 404 が数回続いただけで出品者のゲートが自分の掲載を引けなくなり、
//       再検証の ok に永久に届かなくなるのを避けるため (公開中の掲載も閾値まではカタログに残る)。
// ⚠️ テンプレートリテラルを使わない (REVERIFY_COUNTER_TRANSITION の注意を参照)。閾値は HIDE_THRESHOLD_LUA /
// AUTH_HIDE_THRESHOLD_LUA を使い回さず String() をここで書く: 2 か所から参照すると minifier がそれを変数のまま
// 残し (`failures>="+F+" then`)、scripts/check-lua-bundle.mjs が閾値の形をバンドルで確かめられなくなる。
export const REVERIFY_PENDING_FIRST_VERIFICATION =
  "if (not hidden) or (ARGV[4]=='violation' and failures>=" +
  String(REVERIFY_HIDE_THRESHOLD) +
  ") or (ARGV[5]=='block' and authFailures>=" +
  String(REVERIFY_AUTH_HIDE_THRESHOLD) +
  ') then o.pendingFirstVerification=nil end; ';

// probe の照合に使った受取先 (ARGV[9]・掲載の payTo の読取時の値) が、CAS の時点の掲載と違えば結果を捨てる (-5)。
// probe の間の payTo だけの編集 (PATCH) で、古い受取先に対して照合した ok が、確かめていない新しい受取先のまま
// 掲載を公開する経路を断つ (URL の変更を -3 で捨てるのと同じ扱い)。照合しなかった probe (公開中の掲載・
// first-party) は ARGV[9]='' で、この検査を素通りする = 従来どおり。比べるのは record にある文字列そのもの
// (数値の時刻を使わない: Upstash の Lua 5.1 と検査用の Lua 5.4 で数値の文字列化が違う)。network は編集できず
// (CAS_UPDATE が保持)、asset / forwarder は record に無い (設定から作る) ので、照合で record から読むのは payTo だけ。
// ⚠️ テンプレートリテラルを使わない (REVERIFY_COUNTER_TRANSITION の注意を参照)。
export const REVERIFY_MATCHED_PAY_TO_GUARD =
  "if ARGV[9]~='' and o.payTo~=ARGV[9] then return -5 end; ";

export const CAS_EXTERNAL_REVERIFY =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok or type(o)~=\'table\' then return -2 end; ' +
  'if o.active~=true then return 0 end; if o.url~=ARGV[1] then return -3 end; ' +
  REVERIFY_MATCHED_PAY_TO_GUARD +
  'if type(o.verification)==\'table\' and o.verification.lastRunId==ARGV[3] then return -4 end; ' +
  REVERIFY_COUNTER_TRANSITION +
  // claim は実際の hidden 解除だけに適用する。競合・壊れた claim・WRONGTYPE が
  // ok の失敗カウンタリセットに波及し、孤立した失敗を連続失敗扱いすることを防ぐ。
  // visible な旧重複データは成功 probe の順番で勝者を決めず、移行に委ねる。
  URL_CLAIM_GUARD +
  'local restoreBlocked=nil; if before and not hidden then ' +
  'local checked,claim=pcall(claimAvailable,KEYS[3],ARGV[8]); ' +
  "if not checked or claim~=1 then hidden=true; o.hidden=true; restoreBlocked='storage'; " +
  "if checked and claim==-5 then restoreBlocked='url_taken' end; end; end; " +
  REVERIFY_PENDING_FIRST_VERIFICATION +
  REVERIFY_SAVE +
  "if before and not hidden then redis.call('SET',KEYS[3],ARGV[8]) end; " +
  REVERIFY_HIDDEN_URL_LEDGER +
  'if restoreBlocked then return cjson.encode({failures=failures,authFailures=authFailures,before=before,after=hidden,restoreBlocked=restoreBlocked}) end; ' +
  REVERIFY_TRANSITION_RESULT;

export const CAS_FIRST_PARTY_REVERIFY =
  "local c=redis.call('GET',KEYS[1]); local o={}; if c then " +
  'local ok,decoded=pcall(cjson.decode,c); if not ok or type(decoded)~=\'table\' then return -2 end; o=decoded; end; ' +
  'if type(o.verification)==\'table\' and o.verification.lastRunId==ARGV[3] then return -4 end; ' +
  REVERIFY_COUNTER_TRANSITION +
  REVERIFY_SAVE +
  REVERIFY_TRANSITION_RESULT;

function verdictClass(verdict: ReverifyVerdict): 'ok' | 'violation' | 'transient' {
  if (verdict === 'ok_402_openpay') return 'ok';
  return isViolationVerdict(verdict) ? 'violation' : 'transient';
}

function parseApplyResult(value: unknown): ReverifyApplyResult {
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
                : value === -5
                  ? 'pay_to_changed'
                  : 'storage';
    return reason === 'storage'
      ? { applied: false, reason, detail: `unexpected code ${value}` }
      : { applied: false, reason };
  }
  // 成功の応答は Lua が cjson.encode した JSON 文字列だけ。kvEval は Redis の値の形 (配列を含む) までしか確かめず、
  // [JSON 文字列] の配列も JSON.parse の暗黙の文字列化で通ってしまうので、文字列でなければ storage にする
  // (掲載が hidden のままなのに applied:true・hiddenAfter:false と読み、自動復帰の判定を誤る波及を断つ)。
  if (typeof value !== 'string') {
    return { applied: false, reason: 'storage', detail: 'unexpected result type' };
  }
  const parsed = safeParse<{
    failures: number;
    authFailures?: number;
    before: boolean;
    after: boolean;
    restoreBlocked?: 'url_taken' | 'storage';
  }>(value);
  if (!parsed || !Number.isFinite(parsed.failures)) {
    return {
      applied: false,
      reason: 'storage',
      detail: `unparseable result ${String(value).slice(0, 120)}`,
    };
  }
  // Lua の結果は件数 (0 以上の整数) と hidden の前後 (真偽値) を必ず持つ。形が違う JSON を hidden の遷移として読まない。
  if (
    typeof parsed !== 'object' || Array.isArray(parsed) ||
    !Number.isSafeInteger(parsed.failures) || parsed.failures < 0 ||
    (parsed.authFailures !== undefined && (!Number.isSafeInteger(parsed.authFailures) || parsed.authFailures < 0)) ||
    typeof parsed.before !== 'boolean' || typeof parsed.after !== 'boolean' ||
    (parsed.restoreBlocked !== undefined && parsed.restoreBlocked !== 'url_taken' && parsed.restoreBlocked !== 'storage')
  ) {
    return { applied: false, reason: 'storage', detail: `unparseable result ${value.slice(0, 120)}` };
  }
  return {
    applied: true,
    failures: parsed.failures,
    authFailures: Number.isFinite(parsed.authFailures)
      ? (parsed.authFailures as number)
      : 0,
    hiddenBefore: parsed.before === true,
    hiddenAfter: parsed.after === true,
    ...(parsed.restoreBlocked ? { restoreBlocked: parsed.restoreBlocked } : {}),
  };
}

// matchedPayTo = probe の照合に使った受取先 (probeForPendingFirstVerification に渡した掲載の payTo)。照合しなかった
// probe は省略する (CAS は payTo を確かめない = 従来どおり)。
export async function applyExternalReverify(
  id: string,
  probedUrl: string,
  verdict: ReverifyVerdict,
  checkedAt: string,
  runId: string,
  authClass: ReverifyAuthClass = 'neutral',
  matchedPayTo?: string,
): Promise<ReverifyApplyResult> {
  let claimKey: string;
  try {
    claimKey = resourceUrlClaimKey(probedUrl);
  } catch {
    // 旧 parser が受理した URL 1 件の導出失敗でバッチ全体・cursor 更新を止めない。
    // 既存の per-target storage error/streak/quarantine 経路で隔離する。
    return { applied: false, reason: 'storage', detail: 'unclaimable url' };
  }
  const applied = await kvEval<number | string>(
    CAS_EXTERNAL_REVERIFY,
    [resourceKey(id), hiddenUrlLedgerKey(probedUrl), claimKey],
    [
      probedUrl,
      checkedAt,
      runId,
      verdictClass(verdict),
      authClass,
      HIDDEN_URL_LEDGER_VALUE,
      String(HIDDEN_URL_LEDGER_TTL_SEC),
      id,
      matchedPayTo ?? '',
    ],
  );
  return applied.ok
    ? parseApplyResult(applied.value)
    : { applied: false, reason: 'storage', detail: kvFailureDetail(applied) };
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
    : { applied: false, reason: 'storage', detail: kvFailureDetail(applied) };
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
