import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { TipForm } from '@/components/TipForm';
import { NativeTipForm } from '@/components/NativeTipForm';
import {
  parseNativeTipParams,
  parseTipParams,
  searchParamsFromNext,
  type RouteSearch,
} from '@/lib/url';
import {
  buildTipMeta,
  buildTipOgImageUrl,
  tokenLabelFor,
  nativeLabelFor,
  type TipCardFacts,
  type TipOgLocale,
} from '@/lib/ogTipCard';

// SNS シェア時の OGP を creator ごとに動的生成する。受取人名・トークンを反映した
// title/description と、/api/og/tip の動的 OG 画像 (1200x630) を返す。URL 不正は
// generic に倒す (parseTipParams の入力検証は本体描画が担う)。og:image は相対パス
// で返し、root layout の metadataBase で絶対化する。
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; address: string }>;
  searchParams: Promise<RouteSearch>;
}): Promise<Metadata> {
  const { locale, address } = await params;
  const ogLocale: TipOgLocale = locale === 'en' ? 'en' : 'ja';
  const sp = searchParamsFromNext(await searchParams);

  // native (POL/KAIA) tip は ?native= の別系統で、送り手が自分のガスを払う = gasless
  // ではない。token tip (gasless) と分けて facts を組み、「ガス不要」の誤表示を防ぐ。
  let facts: TipCardFacts | null = null;
  let ogImage = `/api/og/tip?locale=${ogLocale}`;
  if (sp.get('native') != null) {
    const native = parseNativeTipParams(address, sp);
    if (native.ok) {
      facts = {
        name: native.params.name,
        tokenLabel: nativeLabelFor(native.params.chain),
        gasless: false,
      };
      ogImage = buildTipOgImageUrl(
        address,
        {
          native: native.params.chain,
          name: native.params.name,
          color: native.params.color,
        },
        ogLocale,
      );
    }
  } else {
    const parsed = parseTipParams(address, sp);
    if (parsed.ok) {
      facts = {
        name: parsed.params.name,
        tokenLabel: tokenLabelFor(parsed.params.token),
        gasless: true,
      };
      ogImage = buildTipOgImageUrl(
        address,
        {
          token: parsed.params.token,
          name: parsed.params.name,
          color: parsed.params.color,
        },
        ogLocale,
      );
    }
  }

  const { title, description } = buildTipMeta(facts, ogLocale);

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

export default async function TipPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; address: string }>;
  searchParams: Promise<RouteSearch>;
}) {
  const { locale, address } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);

  const raw = await searchParams;
  const sp = searchParamsFromNext(raw);

  // native=polygon|kaia があればネイティブ (POL/KAIA) チップ。ERC20 (jpyc/usdc) とは
  // 別系統のため token パラメタは無視し NativeTipForm を描画する。
  let inner: React.ReactNode;
  if (sp.get('native') != null) {
    const parsedNative = parseNativeTipParams(address, sp);
    if (parsedNative.ok) {
      inner = <NativeTipForm params={parsedNative.params} />;
    } else {
      const tn = await getTranslations('NativeTipForm');
      inner = (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <p className="font-semibold">{tn('urlInvalidTitle')}</p>
          <p className="mt-2">{parsedNative.error}</p>
        </div>
      );
    }
  } else {
    const parsed = parseTipParams(address, sp);
    const t = await getTranslations('TipForm');
    inner = parsed.ok ? (
      <TipForm params={parsed.params} />
    ) : (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        <p className="font-semibold">{t('urlInvalidTitle')}</p>
        <p className="mt-2">{parsed.error}</p>
        <p
          className="mt-3 text-xs text-red-600/80"
          dangerouslySetInnerHTML={{ __html: t.raw('urlExample') as string }}
        />
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-3 py-4">
      {/* fan は Accept-Language で言語が決まるため、明示切替を上部に出す */}
      <div className="mb-3 flex justify-end">
        <LocaleSwitcher />
      </div>
      {inner}
    </main>
  );
}
