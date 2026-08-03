import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatUnits } from 'viem';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';
import type { Address } from 'viem';
import {
  handleViewTheme,
  type HandleTheme,
} from '@/lib/handleTheme';
import { CreatorStorePurchaseLauncher } from '@/components/CreatorStorePurchaseLauncher';
import { CreatorStorefrontProductArtwork } from '@/components/CreatorStorefrontProductArtwork';

export type CreatorStorefrontProduct = {
  id: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  galleryUrls?: readonly string[];
  priceJpyc: string;
  payTo: Address;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
  /** Store カテゴリー (表示専用・storeMeta)。 */
  category?: string;
  tags?: readonly string[];
};


// 価格 (整数 JPYC) → 買い手手数料/合計の表示文字列。式は hostedPurchaseFeeValue の単一ソース
// (購入 hook が server quote を同式で検証するため、ここの表示と実請求は乖離しない)。
function feeWeiOf(priceJpyc: string): bigint {
  return hostedPurchaseFeeValue(BigInt(priceJpyc) * 10n ** 18n);
}
function feeJpycOf(priceJpyc: string): string {
  return formatUnits(feeWeiOf(priceJpyc), 18);
}
function totalJpycOf(priceJpyc: string): string {
  return formatUnits(BigInt(priceJpyc) * 10n ** 18n + feeWeiOf(priceJpyc), 18);
}

export function CreatorStorefrontSection({
  products,
  accent,
  theme,
  sellerDisclosureHref,
  autoOpenProductId,
}: {
  products: readonly CreatorStorefrontProduct[];
  accent: string;
  theme: HandleTheme;
  sellerDisclosureHref: string;
  autoOpenProductId?: string;
}) {
  const t = useTranslations('CreatorStorefront');
  const tCatalog = useTranslations('StoreCatalog');
  const locale = useLocale();
  if (products.length === 0) return null;

  const tokens = handleViewTheme(accent, theme);
  const inverted = tokens.dark || theme === 'bold';

  return (
    <section
      aria-labelledby="creator-storefront-heading"
      className="mb-7 w-full"
    >
      <div className="mb-3 text-center">
        <h2
          id="creator-storefront-heading"
          className={`text-base font-bold ${
            tokens.dark ? 'text-slate-100' : 'text-slate-800'
          }`}
        >
          {t('heading')}
        </h2>
        <p
          className={`mt-1 text-xs ${
            tokens.dark ? 'text-slate-300' : 'text-slate-500'
          }`}
        >
          {t('subheading')}
        </p>
      </div>
      <ul className="space-y-2.5">
        {products.map((product) => (
          <li
            key={product.id}
            className={`rounded-2xl px-4 py-4 text-left ${
              tokens.linkStyle
                ? ''
                : 'border border-slate-200/80 bg-white shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]'
            }`}
            style={tokens.linkStyle}
          >
            <div className="flex items-start gap-3">
              <CreatorStorefrontProductArtwork
                imageUrl={product.imageUrl}
                emoji={product.emoji}
                inverted={inverted}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3
                    className={`min-w-0 flex-1 font-bold ${
                      inverted ? 'text-white' : 'text-slate-800'
                    }`}
                  >
                    {product.title}
                  </h3>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <span
                      className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-bold ${
                        inverted
                          ? 'bg-white/15 text-white'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {/* 支払いチェーンの明示 (2026-07-30 user 要望): a11y 名は可視テキスト
                          「Polygon」から導出し、ロゴは装飾 (掟 8)。 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src="/chains/polygon.svg"
                        alt=""
                        aria-hidden
                        className="h-3.5 w-3.5"
                      />
                      {/* 買い手の意思決定基準は実際に払う合計 (2026-07-31 user 裁定)。fee 式は
                          購入 hook が server quote を照合するのと同一関数 = 表示と実請求の乖離なし。 */}
                      {t('cardTotal', {
                        total: new Intl.NumberFormat(locale).format(
                          Number(totalJpycOf(product.priceJpyc)),
                        ),
                      })}
                      {' · Polygon'}
                    </span>
                    <span
                      className={`text-[10px] ${
                        inverted ? 'text-white/70' : 'text-slate-500'
                      }`}
                    >
                      {t('cardBreakdown', {
                        price: new Intl.NumberFormat(locale).format(
                          Number(product.priceJpyc),
                        ),
                        fee: feeJpycOf(product.priceJpyc),
                      })}
                    </span>
                  </span>
                </div>
                {product.desc ? (
                  <p
                    className={`mt-1 text-sm leading-relaxed ${
                      inverted ? 'text-white/80' : 'text-slate-600'
                    }`}
                  >
                    {product.desc}
                  </p>
                ) : null}
                {product.category || (product.tags?.length ?? 0) > 0 ? (
                  /* カテゴリ/タグ (P1・表示専用)。受け取り方 (label) は下段の既存表示が担う。 */
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {product.category ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          inverted
                            ? 'bg-white/15 text-white/90'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {tCatalog(`categories.${product.category}`)}
                      </span>
                    ) : null}
                    {(product.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className={`text-[11px] ${
                          inverted ? 'text-white/60' : 'text-slate-400'
                        }`}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-wide ${
                      inverted ? 'text-white/70' : 'text-slate-500'
                    }`}
                  >
                    {t(`labels.${product.label}`)}
                  </span>
                  <CreatorStorePurchaseLauncher
                    product={{
                      id: product.id,
                      title: product.title,
                      ...(product.desc
                        ? { description: product.desc }
                        : {}),
                      ...(product.imageUrl
                        ? { imageUrl: product.imageUrl }
                        : {}),
                      ...(product.galleryUrls
                        ? { galleryUrls: product.galleryUrls }
                        : {}),
                      priceJpyc: product.priceJpyc,
                      merchant: product.payTo,
                    }}
                    sellerDisclosureHref={sellerDisclosureHref}
                    inverted={inverted}
                    autoOpen={product.id === autoOpenProductId}
                  />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {/* 購入済みの訪問者向けの常設導線 (購入完了画面以外からライブラリへ戻る唯一の入口の一つ)。 */}
      <p className="mt-3 text-center">
        <Link
          href={`/${locale}/store/library`}
          prefetch={false}
          className={`text-xs font-medium underline underline-offset-2 ${
            tokens.dark
              ? 'text-slate-300 hover:text-white'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {t('libraryLink')}
        </Link>
      </p>
    </section>
  );
}
