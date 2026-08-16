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
  /** 保存値 true の商品だけ、購入 modal 内で USDC rail を選べる。 */
  usdcEnabled?: true;
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
function totalJpycOf(priceJpyc: string): string {
  return formatUnits(BigInt(priceJpyc) * 10n ** 18n + feeWeiOf(priceJpyc), 18);
}

export function CreatorStorefrontSection({
  products,
  accent,
  theme,
  sellerDisclosureHref,
  autoOpenProductId,
  viewAllHref,
  hiddenCount = 0,
}: {
  products: readonly CreatorStorefrontProduct[];
  accent: string;
  theme: HandleTheme;
  sellerDisclosureHref: string;
  autoOpenProductId?: string;
  /** 厳選ショーケースで省いた商品がある場合の「すべての商品を見る」導線 (/store?q=@handle)。 */
  viewAllHref?: string;
  hiddenCount?: number;
}) {
  const t = useTranslations('CreatorStorefront');
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
      {/* ショーケース調 (plans/store-showcase-polish.md P2): 画像がある商品は image-top の
          大サムネイルで主役化し、無い商品はコンパクト行のまま (空タイルのノイズを作らない)。
          引き算 = カテゴリ/#タグ・手数料内訳をカードから除去 (内訳は購入モーダルの開示に
          一本化・合計額表示は維持 = 2026-07-31 user 裁定)。説明は 2 行でクランプ
          (生 URL などの長文ノイズを抑える。全文は購入モーダルが表示する)。 */}
      <ul className="space-y-3">
        {products.map((product) => (
          <li
            key={product.id}
            className={`group overflow-hidden rounded-2xl text-left ${
              tokens.linkStyle
                ? ''
                : 'border border-slate-200/80 bg-white shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]'
            }`}
            style={tokens.linkStyle}
          >
            {product.imageUrl ? (
              <CreatorStorefrontProductArtwork
                imageUrl={product.imageUrl}
                emoji={product.emoji}
                inverted={inverted}
                variant="cover"
              />
            ) : null}
            <div className={`px-4 pb-4 ${product.imageUrl ? 'pt-3' : 'pt-4'}`}>
              <div className="flex items-start gap-3">
                {!product.imageUrl ? (
                  <CreatorStorefrontProductArtwork
                    imageUrl={product.imageUrl}
                    emoji={product.emoji}
                    inverted={inverted}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <h3
                    className={`font-bold ${
                      inverted ? 'text-white' : 'text-slate-800'
                    }`}
                  >
                    {product.title}
                  </h3>
                  <span
                    className={`mt-0.5 block text-[11px] font-semibold uppercase tracking-wide ${
                      inverted ? 'text-white/70' : 'text-slate-500'
                    }`}
                  >
                    {t(`labels.${product.label}`)}
                  </span>
                  {product.desc ? (
                    <p
                      className={`mt-1.5 line-clamp-2 text-sm leading-relaxed ${
                        inverted ? 'text-white/80' : 'text-slate-600'
                      }`}
                    >
                      {product.desc}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
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
                        ...(product.usdcEnabled === true
                          ? { usdcEnabled: true as const }
                          : {}),
                      }}
                      sellerDisclosureHref={sellerDisclosureHref}
                      inverted={inverted}
                      autoOpen={product.id === autoOpenProductId}
                    />
                  </div>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {viewAllHref && hiddenCount > 0 ? (
        <p className="mt-3 text-center">
          <Link
            href={viewAllHref}
            prefetch={false}
            className={`text-xs font-semibold underline-offset-2 hover:underline ${
              inverted ? 'text-white/80' : 'text-brand'
            }`}
          >
            {t('viewAllProducts', { count: hiddenCount + products.length })}
          </Link>
        </p>
      ) : null}
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
