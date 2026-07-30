'use client';

// 公開プロフィールの商品カードに置く軽量 launcher。wallet/viem/React Query を使う
// 購入フロー本体は、訪問者が購入ボタンを押した後にだけ読み込む。

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';

const CreatorStorePurchaseFlow = dynamic(
  () =>
    import('@/components/CreatorStorePurchaseFlow').then(
      (module) => module.CreatorStorePurchaseFlow,
    ),
  { ssr: false },
);

export type CreatorStorePurchaseLauncherProps = {
  product: {
    id: string;
    title: string;
    description?: string;
    priceJpyc: string;
    merchant: Address;
  };
  sellerDisclosureHref: string;
  inverted: boolean;
  autoOpen?: boolean;
};

export function CreatorStorePurchaseLauncher({
  product,
  sellerDisclosureHref,
  inverted,
  autoOpen = false,
}: CreatorStorePurchaseLauncherProps) {
  const t = useTranslations('CreatorStorefront');
  const [loaded, setLoaded] = useState(autoOpen);
  const [open, setOpen] = useState(autoOpen);

  const showPurchase = () => {
    setLoaded(true);
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={showPurchase}
        className={`rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
          inverted
            ? 'bg-white text-slate-900 hover:bg-slate-100'
            : 'bg-brand text-white hover:bg-brand-dark'
        }`}
      >
        {t('purchase')}
      </button>
      {loaded ? (
        <CreatorStorePurchaseFlow
          open={open}
          product={product}
          sellerDisclosureHref={sellerDisclosureHref}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
