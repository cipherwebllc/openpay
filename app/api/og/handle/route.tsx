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
  handleStorefrontConfig,
  type HandleRecord,
} from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import { displaySymbolFor } from '@/lib/tokens';
import {
  buildTipOgModel,
  tipModelToCard,
  buildHandleOgModel,
  buildStorefrontOgModel,
  type TipOgLocale,
} from '@/lib/ogTipCard';
import { ogCardElement, OG_FONTS, OG_WIDTH, OG_HEIGHT } from '../_card';

export const runtime = 'nodejs';
export const maxDuration = 10;

const AVATAR_FETCH_TIMEOUT_MS = 3000;
const AVATAR_MAX_BYTES = 2_000_000;
// satori (next/og) が data URL から decode できる画像種別のみ許可する。webp/avif 等は
// satori が描画時に throw し、それは ImageResponse のストリーム生成中 = この route の
// try/catch の外なので OG カード全体が壊れる (イニシャル円 fallback も効かない)。
// ブラウザでは webp も表示できるためプレビューでは気付けない → ここで弾く。
const SATORI_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/apng',
]);

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

// body を逐次読みし、累積が cap を超えたら即中断して null。Content-Length 詐称/欠落でも
// メモリ確保を cap で頭打ちにする (全量 arrayBuffer() を避ける)。
async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
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
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    // satori が decode できる種別のみ (webp/avif/x-icon 等は描画 throw → カード全滅)。
    if (!SATORI_IMAGE_TYPES.has(ct)) return null;
    // Content-Length が上限超過なら body を読まずに弾く (巨大ファイルの全量 DL + メモリ確保
    // を未然に防ぐ。ヘッダは詐称/欠落しうるので body も累積上限つきで逐次読みする)。
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) return null;
    const buf = await readBodyCapped(res, AVATAR_MAX_BYTES);
    if (!buf || buf.byteLength === 0) return null;
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

// 汎用ブランドカード (壊れた画像を SNS に出さない)。transient=true は KV 障害など
// 一時的失敗で、SNS クローラが「実在 handle の汎用カード」を数日キャッシュ固定しないよう
// no-store + 503 で返す (page.tsx が outage を 5xx に倒すのと方針を揃える)。flag OFF /
// 不正 handle / 真の未存在は transient=false で短期キャッシュ可。
function genericCard(locale: TipOgLocale, transient = false): ImageResponse {
  const card = tipModelToCard(
    buildTipOgModel(new URLSearchParams({ locale })),
  );
  return new ImageResponse(ogCardElement(card), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: OG_FONTS,
    status: transient ? 503 : 200,
    headers: {
      'cache-control': transient
        ? 'no-store'
        : 'public, max-age=300, s-maxage=300',
    },
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
  // KV 障害は一時的 → 503 + no-store (クローラに再試行させる)。真の未存在のみ短期キャッシュ。
  if (!resolved.ok) return genericCard(locale, true);
  if (!resolved.record) return genericCard(locale);
  const record = resolved.record;

  // storefront 公開時はモバイルオーダー店舗カードを描く (プロフ link-in-bio カードではなく)。
  // 店名/ひとこと/アバターは KV レコードからサーバ権威で解決 (page.tsx と同じ単一情報源)。
  const storefront = env.enableMobileOrder
    ? handleStorefrontConfig(record, handle)
    : null;
  if (storefront) {
    const storeCard = buildStorefrontOgModel({
      handle,
      shopName: storefront.shopName,
      tagline: storefront.tagline,
      locale,
    });
    const storeAvatar = storefront.avatar
      ? await fetchAvatarDataUrl(storefront.avatar)
      : null;
    return new ImageResponse(ogCardElement(storeCard, storeAvatar), {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts: OG_FONTS,
      headers: {
        'cache-control':
          'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  }

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
