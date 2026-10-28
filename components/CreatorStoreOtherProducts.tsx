import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { groupDecimalString } from '@/lib/format';
import { hostedPurchaseTotalJpyc } from '@/lib/store/purchaseTotal';
import { storeProductPath } from '@/lib/storeProductLink';
import { CreatorStorefrontProductArtwork } from '@/components/CreatorStorefrontProductArtwork';
import type { CreatorStorefrontProduct } from '@/components/CreatorStorefrontSection';

// 商品ページ (?product=) の下に置く「このクリエイターの他の商品」。各カードはその商品の商品ページへ
// 移るリンクで、購入ボタンは持たない (購入は商品ページの主ボタンに一本化)。並びと件数はプロフの厳選
// (featured) と同じで、省いた商品がある場合は「すべての商品を見る」(/store?q=@handle) が受ける。
// カードの画像は商品名がすぐ下にあるので装飾 (alt="") のまま (読み上げで名前を 2 回読ませない)。
export function CreatorStoreOtherProducts({
  products,
  handle,
  fromStore,
  dark,
  viewAllHref,
  totalCount,
}: {
  products: readonly CreatorStorefrontProduct[];
  handle: string;
  /** Store 一覧から来た訪問なら、移った先の商品ページでも「← Store に戻る」を保つ。 */
  fromStore: boolean;
  /** night テーマの地色の上に置くときの見出しの可読色。カードは白い面。 */
  dark: boolean;
  viewAllHref?: string;
  /** その出品者の商品の総数 (「すべての商品を見る (N 件)」)。 */
  totalCount: number;
}) {
  const t = useTranslations('CreatorStorefront');
  const locale = useLocale();
  if (products.length === 0) return null;

  return (
    <section aria-labelledby="store-other-products-heading" className="mt-10">
      <h2
        id="store-other-products-heading"
        className={`text-base font-bold ${dark ? 'text-slate-100' : 'text-slate-800'}`}
      >
        {t('focus.otherProductsHeading')}
      </h2>
      <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4">
        {products.map((product) => (
          <li key={product.id}>
            <Link
              href={`${storeProductPath(handle, product.id, locale)}${fromStore ? '&from=store' : ''}`}
              prefetch={false}
              className="group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-[0_8px_20px_-10px_rgba(15,23,42,0.25)]"
            >
              <CreatorStorefrontProductArtwork
                imageUrl={product.imageUrl}
                emoji={product.emoji}
                inverted={false}
                variant="cover"
              />
              <span className="flex min-w-0 flex-1 flex-col px-3 pb-3 pt-2.5">
                <span className="line-clamp-2 break-words text-sm font-bold text-slate-800">
                  {product.title}
                </span>
                <span className="mt-auto pt-1.5 text-sm font-black text-slate-900">
                  {t('cardTotal', {
                    total: groupDecimalString(hostedPurchaseTotalJpyc(product.priceJpyc)),
                  })}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {viewAllHref && totalCount > products.length + 1 ? (
        <p className="mt-4 text-center">
          <Link
            href={viewAllHref}
            prefetch={false}
            className={`inline-flex min-h-11 items-center text-xs font-semibold underline-offset-2 hover:underline ${
              dark ? 'text-white/80' : 'text-brand'
            }`}
          >
            {t('viewAllProducts', { count: totalCount })}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
