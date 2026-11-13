import type { Event, TransactionEvent } from '@sentry/core';
import type { Breadcrumb } from '@sentry/nextjs';

const SHORT_SHA256_HEX_LENGTH = 16;
const URL_BREADCRUMB_CATEGORIES = new Set([
  'fetch',
  'http',
  'xhr',
  'navigation',
]);
const BREADCRUMB_URL_KEYS = ['url', 'from', 'to', 'location', 'Location'] as const;
const TRACE_URL_KEYS = ['http.url', 'url.full', 'http.response.header.location'] as const;
const REFERER_HEADER_NAMES = new Set(['referer', 'referrer']);
const REFERER_TRACE_KEYS = new Set([
  'http.request.header.referer',
  'http.request.header.referrer',
]);

function currentOrigin(): string | undefined {
  return typeof globalThis.location?.origin === 'string'
    ? globalThis.location.origin
    : undefined;
}

// URL の path/query/userinfo を捨て、送信先 origin だけを telemetry に残す。
export function urlOriginForTelemetry(raw: string): string {
  try {
    const base = currentOrigin();
    const url = base ? new URL(raw, base) : new URL(raw);
    return url.origin;
  } catch {
    return '[invalid-url]';
  }
}

// viem の error (RpcRequestError・HttpRequestError・TimeoutError など) の message は、`URL: <bundler の URL (API key つき)>`
// と `Request body: <送った JSON>` の行を持つ。eth_sendUserOperation の失敗では、その本文が署名済みの UserOperation
// (署名・paymasterData) になる。log の出口 (logger の console と Sentry・Sentry の beforeSend・決済の監査 log) で
// この関数を通し、署名済みの op と key つきの URL が console・Sentry・監査 log へ出るのを断つ。
// 伏せるのは 3 つだけ: Request body の行 (行末まで)・`URL:` の path と query (origin は残す)・129 桁以上つづく 16 進
// (署名 65 byte = 130 桁・callData・paymasterData)。64 桁の tx hash・userOpHash と 40 桁のアドレスは監査で要るので残す。
// 2 回通しても結果は同じ (伏せた後の `Request body: [redacted]` は、その後ろの文を消さないようにもう一度は拾わない)。
// URL の scheme は大文字小文字を問わない (RPC の上書きの URL は書かれたままの大文字で viem の文に入る)。
export function redactLogText(text: string): string {
  return text
    .replace(/Request body:(?! \[redacted\]).*/g, 'Request body: [redacted]')
    .replace(/URL: (https?:\/\/[^\s"'\\]+)/gi, (match, url: string) => match.slice(0, 5) + urlOriginForTelemetry(url))
    .replace(/(?:0x)?[0-9a-fA-F]{129,}/g, '[redacted]');
}

// 中の文字列を伏せた写しを返す (元は書き換えない・伏せる所が無ければ元をそのまま返す)。たどるのは配列と plain な object
// だけで、depth 段まで (Error・DOM などの元の引数はたどらない)。
function redactValues<T>(value: T, depth: number): T {
  if (typeof value === 'string') return redactLogText(value) as T;
  if (depth < 1 || !value || typeof value !== 'object') return value;
  const isArray = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (!isArray && proto !== Object.prototype && proto !== null) return value;
  const entries = Object.entries(value);
  const clean = entries.map(([key, item]) => [key, redactValues(item, depth - 1)] as const);
  if (clean.every(([, item], index) => item === entries[index][1])) return value;
  return (isArray ? clean.map(([, item]) => item) : Object.fromEntries(clean)) as T;
}

// Sentry が normalize した後の JSON の形 (extra・breadcrumb の data) の中の文字列を伏せた写しを返す (元は書き換えない)。
export function redactLogData<T>(value: T): T {
  return redactValues(value, Infinity);
}

// 値が変わるときだけ書く。Sentry は元の object の一部 (contexts.trace・exception・request) を event に持ち続けるので、
// それが凍結されていても、伏せる所が無ければ event をそのまま通す。
function assign(target: object, key: string, value: unknown): void {
  const record = target as Record<string, unknown>;
  if (record[key] !== value) record[key] = value;
}

async function shortSha256(raw: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('webcrypto_unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .slice(0, SHORT_SHA256_HEX_LENGTH);
}

export async function redactUrlForTelemetry(
  raw: string,
): Promise<{ origin: string; hash: string }> {
  const origin = urlOriginForTelemetry(raw);
  try {
    return { origin, hash: await shortSha256(raw) };
  } catch {
    // telemetry redaction の障害を、完了済み決済や resource 応答へ波及させない。
    return { origin, hash: 'sha256-unavailable' };
  }
}

function scrubUrlFields(
  data: Record<string, unknown> | undefined,
  keys: readonly string[],
): void {
  if (!data) return;
  // 配布 ticket/owner 限定 URL が network data に付いた場合も telemetry へ波及させない。
  delete data.ticket;
  delete data.deliveryUrl;
  // Sentry の外向き fetch breadcrumb は `url` から query を剥がす一方で、query 文字列を `http.query` に
  // **別のキーで丸ごと**入れる (@sentry/node-core outgoingFetchRequest の getBreadcrumbData)。
  // 上流 API のキーを query で渡す fetch (例: Etherscan の apikey) が、エラー event に載って Sentry へ波及するのを断つ。
  delete data['http.query'];
  delete data['http.fragment'];
  for (const key of keys) {
    if (typeof data[key] === 'string') assign(data, key, urlOriginForTelemetry(data[key]));
  }
}

function withoutQueryOrFragment(raw: string): string {
  const queryIndex = raw.indexOf('?');
  const fragmentIndex = raw.indexOf('#');
  const endIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  return endIndexes.length > 0 ? raw.slice(0, Math.min(...endIndexes)) : raw;
}

type TraceSpan = { op?: string; description?: string; data?: Record<string, unknown> };

// 別の origin への request の span は、description と URL の欄を origin だけにする。RPC の URL は path に API key を
// 持つ (https://…/v2/<key>) が、SDK が付ける description (`POST <URL>`)・url・url.path・http.target は path を残す
// (http.url と url.full は上で origin)。自分の app の span (相対 path・同じ origin・受けた request の http.server) は
// 今までの scrub のまま。own は event の request (browser は開いているページ・server は受けた request) の origin で、
// request が無ければ location の origin (server で両方無ければ、絶対 URL は全部別の origin として扱う)。
function scrubForeignSpanUrls(span: TraceSpan | undefined, own: string | undefined): void {
  if (!span || span.op === 'http.server') return;
  const foreign = (raw: unknown): raw is string =>
    typeof raw === 'string' && /^https?:\/\//i.test(raw) && urlOriginForTelemetry(raw) !== own;
  if (typeof span.description === 'string') {
    assign(span, 'description', span.description.replace(/https?:\/\/\S+/gi, (url) => (foreign(url) ? urlOriginForTelemetry(url) : url)));
  }
  const data = span.data;
  if (data && [data.url, data['url.full'], data['http.url']].some(foreign)) {
    if (typeof data.url === 'string') assign(data, 'url', urlOriginForTelemetry(data.url));
    delete data['url.path'];
    delete data['http.target'];
  }
}

function scrubTraceUrlFields(event: Event): void {
  let own = currentOrigin();
  if (typeof event.request?.url === 'string') {
    own = urlOriginForTelemetry(event.request.url);
    assign(event.request, 'url', own);
  }
  scrubUrlFields(event.contexts?.trace?.data, TRACE_URL_KEYS);
  scrubForeignSpanUrls(event.contexts?.trace, own);
  for (const span of event.spans ?? []) {
    scrubUrlFields(span.data, TRACE_URL_KEYS);
    scrubForeignSpanUrls(span, own);
  }
}

// 認可に使うヘッダ (お店の端末の受け渡しトークン・受注フィードのトークン)。RequestData integration が
// error event の request.headers に生値を残すので、大文字小文字を問わず落とす。
const SECRET_HEADER_NAMES = new Set(['x-store-handoff-token', 'x-order-token']);

function scrubRefererHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (SECRET_HEADER_NAMES.has(key.toLowerCase())) delete headers[key];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (REFERER_HEADER_NAMES.has(key.toLowerCase()) || key.toLowerCase() === 'location') {
      assign(headers, key, urlOriginForTelemetry(value));
    }
  }
}

function scrubServerTraceData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  delete data['url.query'];
  // span 側にも同じ別表現が付き得る (上の scrubUrlFields と同じ理由)。
  delete data['http.query'];
  delete data['http.fragment'];
  if (typeof data['http.target'] === 'string') {
    assign(data, 'http.target', withoutQueryOrFragment(data['http.target']));
  }
  for (const [key, value] of Object.entries(data)) {
    if (REFERER_TRACE_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
      assign(data, key, urlOriginForTelemetry(value));
    }
  }
}

// breadcrumb の伏せた写しを返す (元の breadcrumb と data は書き換えない・伏せる所が無ければ元をそのまま返す)。
// console の breadcrumb には、console に出た error の文がそのまま入る (logger を通らない console.error も)。message と
// data (console は data.arguments に引数を持つ) を伏せる。depth は data をたどる段数 (redactValues)。
function scrubBreadcrumb(breadcrumb: Breadcrumb, depth: number): Breadcrumb {
  const { category, data } = breadcrumb;
  let message = breadcrumb.message;
  if (typeof message === 'string') message = redactLogText(message);
  let clean = data && redactValues(data, depth);
  if (category && URL_BREADCRUMB_CATEGORIES.has(category)) {
    if (clean) {
      clean = { ...clean };
      scrubUrlFields(clean, BREADCRUMB_URL_KEYS);
    }
    if (typeof message === 'string' && (/^https?:\/\//i.test(message) || message.startsWith('/'))) {
      message = urlOriginForTelemetry(message);
    }
  }
  return message === breadcrumb.message && clean === data ? breadcrumb : { ...breadcrumb, message, data: clean };
}

// Sentry に渡す hook (beforeBreadcrumb・beforeSend・beforeSendTransaction) は投げない。scrubber の失敗 (凍結された
// object・throw する getter・Proxy) が、(a) app の呼び出し元 (console.* や addBreadcrumb。Sentry は beforeBreadcrumb の
// throw を受け止めない) に届くこと、(b) Sentry がその例外を内部の event として beforeSend を通さずに送ること
// (@sentry/core の client.js の _processEvent) を断つ。伏せられなかった breadcrumb / event は捨てる (null = 積まない・送らない)。

// beforeBreadcrumb。積む時点の data は normalize される前の元の引数 (Error・循環する object・DOM もある) なので、伏せるのは
// data の欄と、その配列・plain な object の 1 段目の文字列だけ (depth 2)。Error などの中の文は、normalize された写しを
// beforeSend と beforeSendTransaction が伏せる (scrubEventBreadcrumbs)。
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    return scrubBreadcrumb(breadcrumb, 2);
  } catch {
    return null;
  }
}

// event に載った breadcrumb (SDK が normalize した写し)。console の breadcrumb は、引数 (Error の message・stack) を
// data.arguments にも持つ。transaction は beforeSend を通らないので、beforeSendTransaction でも同じ関数を通す。
function scrubEventBreadcrumbs(event: Event): void {
  const breadcrumbs = event.breadcrumbs ?? [];
  breadcrumbs.forEach((breadcrumb, index) => {
    const clean = scrubBreadcrumb(breadcrumb, Infinity);
    if (clean !== breadcrumb) breadcrumbs[index] = clean;
  });
}

export function scrubSentryTransaction(
  event: TransactionEvent,
): TransactionEvent | null {
  try {
    scrubTraceUrlFields(event);
    scrubEventBreadcrumbs(event);
    return event;
  } catch {
    return null;
  }
}

/**
 * Server/edge event に Next.js / RequestData integration が付ける URL の別表現を
 * まとめて落とす。1 つでも残ると order-status token が Sentry へ波及するため、
 * transaction と error の両方で同じ scrubber を使う。
 */
export function scrubSentryServerEvent<T extends Event>(event: T): T | null {
  try {
    scrubTraceUrlFields(event);
    if (event.request) {
      delete event.request.query_string;
      scrubRefererHeaders(event.request.headers);
    }
    scrubServerTraceData(event.contexts?.trace?.data);
    for (const span of event.spans ?? []) {
      scrubServerTraceData(span.data);
    }
    const nextjs = event.contexts?.nextjs;
    if (nextjs && typeof nextjs.request_path === 'string') {
      assign(nextjs, 'request_path', withoutQueryOrFragment(nextjs.request_path));
    }
    scrubEventBreadcrumbs(event);
    // error の文 (logger の captureException・未捕捉の例外・error boundary・onRequestError) は、ここで伏せる。
    // exception.values は cause の連なりと AggregateError の子を 1 つずつ持つので、全部を通す。
    if (typeof event.message === 'string') assign(event, 'message', redactLogText(event.message));
    for (const exception of event.exception?.values ?? []) {
      if (typeof exception.value === 'string') assign(exception, 'value', redactLogText(exception.value));
      // Sentry の browser の stack parser は、stack の先頭に入った message の `URL: <url>` の行を frame として読む
      // (function が 'URL: '・filename が key つきの URL)。その filename を origin だけにする。
      for (const frame of exception.stacktrace?.frames ?? []) {
        if (frame.function === 'URL: ' && frame.filename) {
          assign(frame, 'filename', urlOriginForTelemetry(frame.filename));
        }
      }
    }
    assign(event, 'extra', redactLogData(event.extra));
    return event;
  } catch {
    return null;
  }
}

export function scrubSentryServerTransaction(
  event: TransactionEvent,
): TransactionEvent | null {
  return scrubSentryServerEvent(event);
}
