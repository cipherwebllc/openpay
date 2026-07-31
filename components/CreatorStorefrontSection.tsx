import { useLocale, useTranslations } from 'next-intl';
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
  priceJpyc: string;
  payTo: Address;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
};

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
                  <span
                    className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-bold ${
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
                    {new Intl.NumberFormat(locale).format(
                      Number(product.priceJpyc),
                    )}{' '}
                    JPYC · Polygon
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
    </section>
  );
}
