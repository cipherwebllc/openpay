// 「使い方」: 受取側 (merchant) と支払側 (customer) の 3-step フロー。
// Server Component。

import { getTranslations } from 'next-intl/server';

export async function LandingHowItWorks() {
  const t = await getTranslations('Landing');

  const merchant = [
    t('howItWorksMerchantStep1'),
    t('howItWorksMerchantStep2'),
    t('howItWorksMerchantStep3'),
  ];
  const customer = [
    t('howItWorksCustomerStep1'),
    t('howItWorksCustomerStep2'),
    t('howItWorksCustomerStep3'),
  ];

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('howItWorksTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('howItWorksSubtitle')}</p>
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <article className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-emerald-900">
            {t('howItWorksMerchantTitle')}
          </h3>
          <ol className="mt-3 space-y-3">
            {merchant.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-blue-900">
            {t('howItWorksCustomerTitle')}
          </h3>
          <ol className="mt-3 space-y-3">
            {customer.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </article>
      </div>
    </section>
  );
}
