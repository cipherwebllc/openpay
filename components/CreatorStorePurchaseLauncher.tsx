'use client';

// 公開プロフィールの商品カードに置く軽量 launcher。wallet/viem/React Query を使う
// 購入フロー本体は、訪問者が購入ボタンを押した後にだけ読み込む。
// variant='focus' は商品ページ (?product=) の主ボタン。ページ内のボタンが画面から外れている間だけ、
// スマホ幅で画面下に同じ購入ボタンの固定バーを出す (lg 以上は右列が sticky なので出さない)。

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import type { Address } from 'viem';
import type { StoreLicenseProduct } from '@/lib/licenseUi';
import type { StoreUsageTerms } from '@/lib/store/usageTerms';

const CreatorStorePurchaseFlow = dynamic(
  () =>
    import('@/components/CreatorStorePurchaseFlow').then(
      (module) => module.CreatorStorePurchaseFlow,
    ),
  { ssr: false },
);

export type CreatorStorePurchaseLauncherProps = {
  product: StoreLicenseProduct & {
    protectedDelivery?: boolean;
    id: string;
    title: string;
    description?: string;
    imageUrl?: string;
    galleryUrls?: readonly string[];
    details?: string;
    specs?: readonly { label: string; value: string }[];
    demoUrl?: string;
    usage?: StoreUsageTerms;
    priceJpyc: string;
    merchant: Address;
    usdcEnabled?: true;
  };
  sellerDisclosureHref: string;
  inverted: boolean;
  variant?: 'card' | 'focus';
  /** variant='focus' の固定バーに出す支払総額 (例「1,010 JPYC」・カードと同じ表記)。 */
  totalLabel?: string;
};

export function CreatorStorePurchaseLauncher({
  product,
  sellerDisclosureHref,
  inverted,
  variant = 'card',
  totalLabel,
}: CreatorStorePurchaseLauncherProps) {
  const t = useTranslations('CreatorStorefront');
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const inlineRef = useRef<HTMLDivElement>(null);
  const [inlineVisible, setInlineVisible] = useState(true);

  useEffect(() => {
    if (variant !== 'focus') return;
    const target = inlineRef.current;
    // IntersectionObserver の無い環境では固定バーを出さない (ページ内のボタンだけで購入できる)。
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      setInlineVisible(entry.isIntersecting);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [variant]);

  const showPurchase = () => {
    setLoaded(true);
    setOpen(true);
  };

  if (product.productKind === 'license' && !env.enableLicenseNftUi) return null;

  const flow = loaded ? (
    <CreatorStorePurchaseFlow
      open={open}
      product={product}
      sellerDisclosureHref={sellerDisclosureHref}
      onClose={() => setOpen(false)}
      showProductDetails={variant !== 'focus'}
    />
  ) : null;

  if (variant === 'focus') {
    return (
      <>
        <div ref={inlineRef}>
          <button
            type="button"
            onClick={showPurchase}
            className="min-h-12 w-full rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-sm transition-colors hover:bg-brand-dark"
          >
            {t('purchase')}
          </button>
        </div>
        {!inlineVisible && !open ? (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.25)] backdrop-blur lg:hidden">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              <p className="min-w-0 flex-1">
                <span className="block truncate text-xs text-slate-500">
                  {product.title}
                </span>
                {totalLabel ? (
                  <span className="block truncate text-base font-black text-slate-900">
                    {totalLabel}
                  </span>
                ) : null}
              </p>
              <button
                type="button"
                onClick={showPurchase}
                className="min-h-11 shrink-0 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-dark"
              >
                {t('purchase')}
              </button>
            </div>
          </div>
        ) : null}
        {flow}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={showPurchase}
        className={`${product.productKind === 'license' ? 'min-h-11 ' : ''}rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
          inverted
            ? 'bg-white text-slate-900 hover:bg-slate-100'
            : 'bg-brand text-white hover:bg-brand-dark'
        }`}
      >
        {t('purchase')}
      </button>
      {flow}
    </>
  );
}
