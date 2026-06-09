// @handle 恒久リンクの解決ページ (catch-all)。`open-pay.jp/@alice` → /{locale}/@alice。
// segment が `@` 始まりのみ handle として解決し、保存設定から /tip と同じ TipForm を描画 +
// 動的 OGP (P1 再利用)。それ以外の未知 segment と flag OFF と未存在は notFound。
//
// 注: catch-all なので未知の単一 segment を全て受けるが、static route (pay/tip/create…) が
// 優先され、`@` 以外は即 notFound するため KV は `/@...` のときだけ読む。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { env } from '@/lib/env';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { TipForm } from '@/components/TipForm';
import { parseTipParams } from '@/lib/url';
import { isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  normalizeHandle,
  decodeHandleSegment,
  configToSearchParams,
} from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import {
  buildTipMeta,
  buildTipOgImageUrl,
  tokenLabelFor,
  type TipCardFacts,
  type TipOgLocale,
} from '@/lib/ogTipCard';

// catch-all かつ KV を実行時に読むため、静的最適化させず必ず Node ランタイムでリクエスト時に
// 解決する (API route と揃える)。これがないと環境によって KV env が解決時に見えない/
// 静的 404 にされる可能性がある。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const resolved = await resolveHandle(normalizeHandle(segment));
  if (!resolved.ok || !resolved.record) {
    // 未存在 or KV エラー → 汎用ブランドカードの meta (ページ本体が notFound/5xx を出す)。
    const generic = buildTipMeta(null, ogLocale);
    return { title: generic.title, description: generic.description };
  }
  const c = resolved.record.config;
  // @handle config は token tip (ERC20 gasless) 固定。
  const facts: TipCardFacts = {
    name: c.name,
    tokenLabel: tokenLabelFor(c.token),
    gasless: true,
  };
  const { title, description } = buildTipMeta(facts, ogLocale);
  const ogImage = buildTipOgImageUrl(
    c.to,
    { token: c.token, name: c.name, color: c.color },
    ogLocale,
  );
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

export default async function HandlePage({
  params,
}: {
  params: Promise<{ locale: string; handle: string }>;
}) {
  if (!env.enableHandles) notFound();
  const { locale, handle: rawSegment } = await params;
  // Next.js は dynamic param を自動デコードしないため `@` が `%40` で届く。先にデコードする。
  const segment = decodeHandleSegment(rawSegment);
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  if (!segment.startsWith('@')) notFound();

  const normalized = normalizeHandle(segment);
  const resolved = await resolveHandle(normalized);
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

  const t = await getTranslations('TipForm');
  // 保存設定を tip クエリに戻して parseTipParams で再検証 (token/chain 非対応化等の
  // staleness を /tip と同じ UI で吸収する)。
  const parsed = parseTipParams(
    record.config.to,
    configToSearchParams(record.config),
  );
  const inner = parsed.ok ? (
    <TipForm params={parsed.params} />
  ) : (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
      <p className="font-semibold">{t('urlInvalidTitle')}</p>
      <p className="mt-2">{parsed.error}</p>
    </div>
  );

  return (
    <main className="mx-auto w-full max-w-md px-3 py-4">
      <div className="mb-3 flex justify-end">
        <LocaleSwitcher />
      </div>
      {inner}
    </main>
  );
}
