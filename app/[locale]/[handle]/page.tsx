// @handle 恒久リンクの解決ページ (catch-all)。`open-pay.jp/@alice` → /{locale}/@alice。
// segment が `@` 始まりのみ handle として解決し、保存設定から link-in-bio プロフィール
// (HandleProfileView) + 受取方法メニュー (ReceiveMethodPicker → TipForm) を描画 + 動的 OGP。
// それ以外の未知 segment と flag OFF と未存在は notFound。
//
// 注: catch-all なので未知の単一 segment を全て受けるが、static route (pay/tip/create…) が
// 優先され、`@` 以外は即 notFound するため KV は `/@...` のときだけ読む。

import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import NextImage from 'next/image';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { env } from '@/lib/env';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { HandleProfileView } from '@/components/HandleProfile';
import { ReceiveMethodPicker } from '@/components/ReceiveMethodPicker';
import { MobileOrderView } from '@/components/MobileOrderView';
import { isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { normalizeHandle, decodeHandleSegment, handleStorefrontConfig } from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import { readShopLive } from '@/lib/shopLiveStore';
import { decodeAgentCart } from '@/lib/agentOrder';
import { searchParamsFromNext, type RouteSearch } from '@/lib/url';
import {
  buildTipMeta,
  buildStorefrontMeta,
  buildHandleOgImageUrl,
  tokenLabelFor,
  type TipCardFacts,
  type TipOgLocale,
} from '@/lib/ogTipCard';

// catch-all かつ KV を実行時に読むため、静的最適化させず必ず Node ランタイムでリクエスト時に
// 解決する (API route と揃える)。これがないと環境によって KV env が解決時に見えない/
// 静的 404 にされる可能性がある。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// generateMetadata と本体が同一リクエストで同じ handle を解決するため、React の cache() で
// リクエスト単位にメモ化し KV への重複 REST I/O を1回に潰す (結果の不整合も防ぐ)。
const resolveHandleCached = cache(resolveHandle);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; handle: string }>;
}): Promise<Metadata> {
  const { locale, handle: rawSegment } = await params;
  const segment = decodeHandleSegment(rawSegment);
  const ogLocale: TipOgLocale = locale === 'en' ? 'en' : 'ja';
  if (!env.enableHandles || !segment.startsWith('@')) {
    return { title: 'OpenPay' };
  }
  const resolved = await resolveHandleCached(normalizeHandle(segment));
  if (!resolved.ok || !resolved.record) {
    // 未存在 or KV エラー → 汎用ブランドカードの meta (ページ本体が notFound/5xx を出す)。
    const generic = buildTipMeta(null, ogLocale);
    return { title: generic.title, description: generic.description };
  }
  const record = resolved.record;
  const c = record.config;
  const normalized = normalizeHandle(segment);
  // OGP 画像 (/api/og/handle) は同じ KV レコードから storefront を検出し、店舗カード or
  // プロフカードを描き分ける (URL は共通なのでここでは渡し分け不要)。
  const ogImage = buildHandleOgImageUrl(normalized, ogLocale);
  const toMeta = (title: string, description: string): Metadata => ({
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [ogImage] },
  });

  // storefront 公開時はモバイルオーダー訴求の meta にする (プロフ link-in-bio ではなく)。
  const storefront = env.enableMobileOrder
    ? handleStorefrontConfig(record, normalized)
    : null;
  if (storefront) {
    const meta = buildStorefrontMeta(
      { handle: normalized, shopName: storefront.shopName, tagline: storefront.tagline },
      ogLocale,
    );
    return toMeta(meta.title, meta.description);
  }

  // プロフ (link-in-bio) の meta。タイトルは「名前 (@handle)」・説明は bio があれば優先。
  const title = c.name
    ? `${c.name} (@${normalized}) — OpenPay`
    : `@${normalized} — OpenPay`;
  const primary = c.methods[0];
  const facts: TipCardFacts = {
    name: c.name,
    tokenLabel: tokenLabelFor(primary.token),
    gasless: true,
  };
  const bio = record.profile?.bio?.trim();
  const description =
    bio && bio.length > 0
      ? bio.length > 90
        ? `${bio.slice(0, 90)}…`
        : bio
      : buildTipMeta(facts, ogLocale).description;
  return toMeta(title, description);
}

export default async function HandlePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; handle: string }>;
  searchParams: Promise<RouteSearch>;
}) {
  if (!env.enableHandles) notFound();
  const { locale, handle: rawSegment } = await params;
  // Next.js は dynamic param を自動デコードしないため `@` が `%40` で届く。先にデコードする。
  const segment = decodeHandleSegment(rawSegment);
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!segment.startsWith('@')) notFound();

  const normalized = normalizeHandle(segment);
  const resolved = await resolveHandleCached(normalized);
  // KV 未設定/outage は誤って「存在しない (404)」と返さず 5xx に倒す (transient と gone を区別)。
  if (!resolved.ok) throw new Error('handle_store_unavailable');
  if (!resolved.record) {
    // 診断: KV は応答しているのに未存在 = 真の not-found。kvConfigured も記録し「env が
    // 解決時に見えない」系の取りこぼしと区別する (Sentry / Vercel logs)。
    logger.warn('handle.resolve.miss', {
      handle: normalized,
      kvConfigured: isKvConfigured(),
    });
    notFound();
  }
  const record = resolved.record;
  const profile = record.profile;
  const hasProfile =
    !!profile &&
    (!!profile.bio ||
      !!profile.avatar ||
      (profile.socials?.length ?? 0) > 0 ||
      (profile.links?.length ?? 0) > 0);
  // 店舗 (storefront) が公開されていれば @handle ページ自体を店舗ページにする (固定店舗 URL)。
  // MobileOrderView がアバター/店名/SNS ヘッダー + メニュー + カート + /checkout 引き継ぎを内包。
  // flag OFF (本番既定) では storefront を無視し従来の link-in-bio + tip のまま (inert)。
  const storefront = env.enableMobileOrder
    ? handleStorefrontConfig(record, normalized)
    : null;
  // ライブ運用状態 (売り切れ / 受付一時停止) を同リクエストでサーバ読取し MobileOrderView へ渡す。
  // flag OFF / storefront 非公開では読まず undefined (= 制限なし・従来どおり)。fail-open。
  const live = storefront && env.enableShopLive ? await readShopLive(normalized) : undefined;
  // インバウンド・エージェント注文 (plans/inbound-agent-order.md §2): 旅行者の AI が組んだ注文を
  // `?cart=<base64url>` で受け、MobileOrderView に事前充填する。**self-contained ?s= トークンは使わず
  // @handle 経路に限定** (受取先・価格は KV 権威の handle レコードから再解決 = receiver スプーフィング
  // 不成立・C1)。cart は untrusted ゆえ decodeAgentCart が全項目検証し不正は null (= 事前充填なし)。
  // menu との突合・グレース劣化・改ざん無害化は MobileOrderView (resolvePrefillCart) が担う。
  const cartParam = storefront ? searchParamsFromNext(await searchParams).get('cart') : null;
  const initialCart = cartParam ? decodeAgentCart(cartParam) : null;
  const t = await getTranslations({ locale, namespace: 'HandleProfile' });
  // クリエイターのアクセント色 (config.color)。link-in-bio の背景ウォッシュに薄く効かせ、
  // 各ページに固有の質感を与える (足し算)。不正値は既定ブルー。
  const accent =
    record.config.color && /^#[0-9a-fA-F]{6}$/.test(record.config.color)
      ? record.config.color
      : '#2563eb';

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-12 pt-5">
      {/* link-in-bio のみアクセントの背景ウォッシュ (storefront は独自の意匠なので付けない) */}
      {!storefront && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-96"
          style={{
            background: `radial-gradient(125% 70% at 50% 0%, ${accent}29 0%, ${accent}0d 32%, transparent 68%)`,
          }}
        />
      )}
      <div className="mb-3 flex items-center justify-between gap-2">
        {/* 店舗ページは入口として開かれるので OpenPay への戻り導線を上部に出す
            (link-in-bio はフッターのアイコンが主導線なので左は空) */}
        {storefront ? (
          <Link
            href={`/${locale}`}
            prefetch={false}
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            ← OpenPay
          </Link>
        ) : (
          <span />
        )}
        <LocaleSwitcher />
      </div>
      {storefront ? (
        // 店舗公開時: /@shop = 店そのもの (メニュー + カート + 支払い)。
        // /checkout の「←」がこの店舗ページへ戻れるよう自ページのパス + 店名を渡す。
        <MobileOrderView
          config={storefront}
          backHref={`/${locale}/@${normalized}`}
          backLabel={storefront.shopName}
          handle={normalized}
          live={live}
          initialCart={initialCart}
        />
      ) : (
        <>
          {hasProfile && (
            <div className="mb-7">
              <HandleProfileView
                config={record.config}
                profile={profile}
                handle={normalized}
              />
            </div>
          )}
          {/* 受取方法メニュー (複数なら選択ボタン、1つなら TipForm 直描画)。決済本体は TipForm に委譲。 */}
          <ReceiveMethodPicker config={record.config} />
        </>
      )}
      {/* link-in-bio フッター: (1) 取消不可の開示を簡潔に再掲 (共通 AlphaNotice はこのページでは
          出さないため・本体は /disclaimer)、(2) "Powered by OpenPay" で OpenPay 本体への導線 +
          発見性 (link-in-bio の成長ループ)。主役はクリエイターなので控えめに。
          storefront では出さない (MobileOrderView が独自に戻り導線を持つ)。 */}
      {!storefront && (
        <footer className="mt-12 flex flex-col items-center gap-3 pb-2 text-center">
          <p className="max-w-xs text-[11px] leading-relaxed text-slate-400">
            {t('footerSafety')}{' '}
            <Link
              href={`/${locale}/disclaimer`}
              prefetch={false}
              className="underline underline-offset-2 hover:text-slate-600"
            >
              {t('footerSafetyMore')}
            </Link>
          </p>
          <Link
            href={`/${locale}`}
            aria-label={t('backToTop')}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 transition hover:text-slate-700"
          >
            <NextImage
              src="/icon-512.png"
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 rounded-md"
            />
            {t('poweredBy')}
          </Link>
        </footer>
      )}
    </main>
  );
}
