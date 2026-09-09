import { OPENPAY_FIRST_PARTY_HOSTNAMES } from '@/lib/x402/firstParty';

export type DeliveryUrlResult =
  | { ok: true; url: string; origin: string }
  | { ok: false; reason: string };

/** 配布先の保存・公開判定・発行で共有する WHATWG URL 契約。DNS/HTTP IO は行わない。 */
export function parseDeliveryUrl(raw: unknown): DeliveryUrlResult {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    return { ok: false, reason: 'invalid_length' };
  }
  if (raw.trim() !== raw || /\p{Cc}/u.test(raw)) return { ok: false, reason: 'whitespace_or_control' };
  if (raw.includes('#')) return { ok: false, reason: 'fragment' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  if (url.username || url.password) return { ok: false, reason: 'userinfo' };
  if (url.searchParams.has('ticket')) return { ok: false, reason: 'reserved_ticket' };
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.') || /^\d+(\.\d+){0,3}$/.test(host) || host.startsWith('[') ||
    host === 'localhost' || host.endsWith('.localhost') || OPENPAY_FIRST_PARTY_HOSTNAMES.includes(host)) {
    return { ok: false, reason: 'invalid_hostname' };
  }
  const serialized = url.toString();
  if (serialized.length > 512) return { ok: false, reason: 'invalid_length' };
  return { ok: true, url: serialized, origin: url.origin };
}

/** 入力は検証済みの保存 URL。既存の非予約 query の順序・重複を保持する。 */
export function buildDeliveryRedirect(deliveryUrl: string, ticket: string): string {
  const url = new URL(deliveryUrl);
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

export function audienceOf(deliveryUrl: string): string {
  return new URL(deliveryUrl).origin;
}
