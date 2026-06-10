// @handle プロフィールページの動的 OG 画像 (1200x630)。SNS に open-pay.jp/@alice を
// 貼ったとき、アバター・名前・@handle・bio・受取トークンのカードが表示される。
//
// パラメータは handle 名のみ受け、内容 (名前/色/bio/アバター) は **KV レコードから
// サーバ権威的に解決**する — query で任意文言/任意画像のブランドカードを偽造させない。
// アバターは保存時に https 検証済みの URL を route が取得して data URL 化する
// (satori の外部 fetch 失敗でカード全体が壊れるのを防ぐ + サイズ/種別/ホストを検査)。

import { ImageResponse } from 'next/og';
import { env } from '@/lib/env';
import {
  normalizeHandle,
  isValidHandleFormat,
  type HandleRecord,
} from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import { displaySymbolFor } from '@/lib/tokens';
import {
  buildTipOgModel,
  tipModelToCard,
  buildHandleOgModel,
  type TipOgLocale,
} from '@/lib/ogTipCard';
import { ogCardElement, OG_FONTS, OG_WIDTH, OG_HEIGHT } from '../_card';

export const runtime = 'nodejs';
export const maxDuration = 10;

const AVATAR_FETCH_TIMEOUT_MS = 3000;
const AVATAR_MAX_BYTES = 2_000_000;

// アバター取得のホストガード。保存時に https は強制済みだが、サーバ側 fetch になるため
// IP リテラル / localhost / 内部っぽいドメインは追加で弾く (SSRF 縮小。DNS が私設網を
// 指すケースは https 証明書要件でほぼ実害がない)。
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  return /^[0-9.:[\]]+$/.test(h); // IPv4 / IPv6 リテラル
}

// 外部アバター → data URL。失敗は null (イニシャル円へフォールバック)。
async function fetchAvatarDataUrl(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (isBlockedHost(u.hostname)) return null;
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > AVATAR_MAX_BYTES) return null;
    return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  }
}

function tokenLabelsOf(record: HandleRecord): string[] {
  const seen = new Set<string>();
  for (const m of record.config.methods) seen.add(displaySymbolFor(m.token));
  return [...seen];
}

// 解決できないときの汎用ブランドカード (壊れた画像を SNS に出さない)。
function genericCard(locale: TipOgLocale): ImageResponse {
  const card = tipModelToCard(
    buildTipOgModel(new URLSearchParams({ locale })),
  );
  return new ImageResponse(ogCardElement(card), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: OG_FONTS,
    headers: { 'cache-control': 'public, max-age=300, s-maxage=300' },
  });
}

export async function GET(req: Request): Promise<ImageResponse> {
  const { searchParams } = new URL(req.url);
  const locale: TipOgLocale = searchParams.get('locale') === 'en' ? 'en' : 'ja';
  const handle = normalizeHandle(searchParams.get('h') ?? '');
  if (!env.enableHandles || !isValidHandleFormat(handle)) {
    return genericCard(locale);
  }
  const resolved = await resolveHandle(handle);
  if (!resolved.ok || !resolved.record) return genericCard(locale);
  const record = resolved.record;

  const card = buildHandleOgModel({
    handle,
    name: record.config.name,
    color: record.config.color,
    bio: record.profile?.bio,
    tokenLabels: tokenLabelsOf(record),
    locale,
  });
  const avatar = record.profile?.avatar
    ? await fetchAvatarDataUrl(record.profile.avatar)
    : null;

  return new ImageResponse(ogCardElement(card, avatar), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: OG_FONTS,
    headers: {
      // レコードは更新されうるため不変扱いにしない (短め CDN キャッシュ + SWR)。
      'cache-control':
        'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
