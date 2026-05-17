'use client';

// `/pay` を query 無しで直接開いたとき (= 顧客が誤って手動 navigation した、
// または検索エンジン経由で着地した、など) に表示する friendly landing。
// 「ここは決済 URL を受け取って動く画面」であることを明示し、
// 行き先 (店舗側 home / 履歴) への導線を出す。
//
// 「to はあるが他が不正」のケースは引き続き赤いエラーボックスを残す
// (QR 生成側の URL バグなので merchant が直すべきという意図)。

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function PayEmptyLanding() {
  const t = useTranslations('PaymentForm');
  return (
    <section
      aria-labelledby="pay-empty-landing-title"
      className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-700 shadow-sm"
    >
      <h2
        id="pay-empty-landing-title"
        className="text-lg font-semibold text-slate-900"
      >
        {t('emptyLandingTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed">{t('emptyLandingBody')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href="/"
          prefetch={false}
          className="inline-flex items-center rounded-full bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-dark"
        >
          {t('emptyLandingToHome')}
        </Link>
        <Link
          href="/history"
          prefetch={false}
          className="inline-flex items-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:border-slate-400"
        >
          {t('emptyLandingToHistory')}
        </Link>
      </div>
    </section>
  );
}
