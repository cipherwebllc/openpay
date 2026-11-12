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
export function redactLogText(text: string): string {
  return text
    .replace(/Request body:(?! \[redacted\]).*/g, 'Request body: [redacted]')
    .replace(/URL: (https?:\/\/[^\s"'\\]+)/g, (_match, url: string) => `URL: ${urlOriginForTelemetry(url)}`)
    .replace(/(?:0x)?[0-9a-fA-F]{129,}/g, '[redacted]');
}

// Sentry が normalize した後の JSON の形 (extra・breadcrumb の data) の中の文字列を伏せた写しを返す (元は書き換えない)。
export function redactLogData<T>(value: T): T {
  if (typeof value === 'string') return redactLogText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactLogData(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLogData(item)]),
    ) as T;
  }
  return value;
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
    if (typeof data[key] === 'string') {
      data[key] = urlOriginForTelemetry(data[key]);
    }
  }
}

function withoutQueryOrFragment(raw: string): string {
  const queryIndex = raw.indexOf('?');
  const fragmentIndex = raw.indexOf('#');
  const endIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  return endIndexes.length > 0 ? raw.slice(0, Math.min(...endIndexes)) : raw;
}

function scrubTraceUrlFields(event: Event): void {
  if (typeof event.request?.url === 'string') {
    event.request.url = urlOriginForTelemetry(event.request.url);
  }
  scrubUrlFields(event.contexts?.trace?.data, TRACE_URL_KEYS);
  for (const span of event.spans ?? []) {
    scrubUrlFields(span.data, TRACE_URL_KEYS);
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
      headers[key] = urlOriginForTelemetry(value);
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
    data['http.target'] = withoutQueryOrFragment(data['http.target']);
  }
  for (const [key, value] of Object.entries(data)) {
    if (REFERER_TRACE_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
      data[key] = urlOriginForTelemetry(value);
    }
  }
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  // console の breadcrumb には、console に出た error の文がそのまま入る (logger を通らない console.error も)。
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactLogText(breadcrumb.message);
  }
  if (!breadcrumb.category || !URL_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) {
    return breadcrumb;
  }
  scrubUrlFields(breadcrumb.data, BREADCRUMB_URL_KEYS);
  if (
    typeof breadcrumb.message === 'string' &&
    (/^https?:\/\//i.test(breadcrumb.message) || breadcrumb.message.startsWith('/'))
  ) {
    breadcrumb.message = urlOriginForTelemetry(breadcrumb.message);
  }
  return breadcrumb;
}

export function scrubSentryTransaction(
  event: TransactionEvent,
): TransactionEvent {
  scrubTraceUrlFields(event);
  return event;
}

/**
 * Server/edge event に Next.js / RequestData integration が付ける URL の別表現を
 * まとめて落とす。1 つでも残ると order-status token が Sentry へ波及するため、
 * transaction と error の両方で同じ scrubber を使う。
 */
export function scrubSentryServerEvent<T extends Event>(event: T): T {
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
    nextjs.request_path = withoutQueryOrFragment(nextjs.request_path);
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubSentryBreadcrumb(breadcrumb);
    // console の breadcrumb は、引数 (Error の message・stack) を data.arguments にも持つ。
    if (breadcrumb.data) breadcrumb.data = redactLogData(breadcrumb.data);
  }
  // logger を通らずに届く error (未捕捉の例外・error boundary・onRequestError) の文も、送る前に伏せる。
  if (typeof event.message === 'string') event.message = redactLogText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === 'string') exception.value = redactLogText(exception.value);
    // Sentry の browser の stack parser は、stack の先頭に入った message の `URL: <url>` の行を frame として読む
    // (function が 'URL: '・filename が key つきの URL)。logger が渡す写しの stack (伏せた後) と同じ形にそろえる。
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.function === 'URL: ' && frame.filename) {
        frame.filename = urlOriginForTelemetry(frame.filename);
      }
    }
  }
  if (event.extra) event.extra = redactLogData(event.extra);
  return event;
}

export function scrubSentryServerTransaction(
  event: TransactionEvent,
): TransactionEvent {
  return scrubSentryServerEvent(event);
}
