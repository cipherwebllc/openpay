import type { Event, TransactionEvent } from '@sentry/core';
import type { Breadcrumb } from '@sentry/nextjs';

const SHORT_SHA256_HEX_LENGTH = 16;
const URL_BREADCRUMB_CATEGORIES = new Set([
  'fetch',
  'http',
  'xhr',
  'navigation',
]);
const BREADCRUMB_URL_KEYS = ['url', 'from', 'to'] as const;
const TRACE_URL_KEYS = ['http.url', 'url.full'] as const;
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

function scrubRefererHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (REFERER_HEADER_NAMES.has(key.toLowerCase())) {
      headers[key] = urlOriginForTelemetry(value);
    }
  }
}

function scrubServerTraceData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  delete data['url.query'];
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
  }
  return event;
}

export function scrubSentryServerTransaction(
  event: TransactionEvent,
): TransactionEvent {
  return scrubSentryServerEvent(event);
}
