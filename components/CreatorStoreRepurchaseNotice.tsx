'use client';

// 購入済みの商品をもう一度買う前の確認の段 (第 10 回レビュー H-K)。表示専用。
// 出すのは、server がこの買い手の購入の記録を返したときだけ (hooks/useStoreAlreadyPurchased・/api/store/purchased/{id})。
// 再購入は仕様 (同じ商品を何度でも買える) なので止めない: ライブラリへの導線を先に置き、
// 「もう一度購入する」で今までどおりの購入へ進む。赤は使わない (破壊的な操作ではない)。

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CheckCircle2 } from 'lucide-react';

export type CreatorStoreRepurchaseNoticeProps = {
  /** server の購入記録にある最新の購入の日時 (ms)。 */
  purchasedAt: number;
  libraryHref: string;
  onContinue: () => void;
  onCancel: () => void;
};

export function CreatorStoreRepurchaseNotice({
  purchasedAt,
  libraryHref,
  onContinue,
  onCancel,
}: CreatorStoreRepurchaseNoticeProps) {
  const t = useTranslations('CreatorStorePurchase');
  const locale = useLocale();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // 押したボタンは下の画面ごと隠れるので、見出しへ focus を移す (読み上げと Tab の起点をこの段に置く)。
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby="creator-store-repurchase-heading"
      className="rounded-3xl border border-emerald-200 bg-white p-6 text-center shadow-2xl sm:p-8"
    >
      <CheckCircle2 className="mx-auto h-9 w-9 text-emerald-600" aria-hidden />
      <h2
        ref={headingRef}
        id="creator-store-repurchase-heading"
        tabIndex={-1}
        className="mt-3 text-xl font-black text-slate-900 outline-none"
      >
        {t('repurchaseTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        {t('repurchaseBody')}
      </p>
      <p className="mt-2 text-xs text-slate-500">
        {t('repurchaseLastPurchased', {
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(purchasedAt),
        })}
      </p>
      <div className="mx-auto mt-5 grid max-w-sm grid-cols-1 gap-3">
        <a
          href={libraryHref}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark"
        >
          {t('openLibrary')}
        </a>
        <button
          type="button"
          onClick={onContinue}
          className="min-h-11 rounded-xl border border-slate-300 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          {t('repurchaseContinue')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-xl px-5 py-3 text-sm font-bold text-slate-600 hover:bg-slate-50"
        >
          {t('repurchaseCancel')}
        </button>
      </div>
    </section>
  );
}
