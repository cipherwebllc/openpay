import { getTranslations } from 'next-intl/server';

export async function LandingPayoutStatement() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          {t('payoutStatementTitle')}
        </h2>
        <p className="mx-auto mt-4 max-w-3xl text-base leading-relaxed text-slate-600 sm:text-lg">
          {t('payoutStatementBody')}
        </p>
      </div>
    </section>
  );
}
