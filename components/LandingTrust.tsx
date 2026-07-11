// ブランドメッセージで締めつつ、技術スタックと GitHub link で信頼性を開示する。
// Server Component。SiteFooter は legal nav 中心のため、別の切り口を維持する。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

export async function LandingTrust() {
  const [locale, t] = await Promise.all([
    getLocale(),
    getTranslations('Landing'),
  ]);

  return (
    <section className="relative mt-24 overflow-hidden rounded-[2rem] bg-slate-900 p-8 sm:mt-28 sm:p-12">
      {/* 装飾: 上部の淡いブランドグロー (ダーク面の奥行き)。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-64 max-w-2xl bg-[radial-gradient(60%_60%_at_50%_0%,rgba(59,130,246,0.25),transparent_70%)]"
      />
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
          {t('closingTitle')}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
          {t('closingBody')}
        </p>
        <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href={`/${locale}/create`}
            prefetch={false}
            className="inline-flex w-full items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-blue-700 hover:shadow-card-hover active:translate-y-0 active:scale-[0.98] sm:w-auto"
          >
            {t('closingCtaStart')}
          </Link>
          <a
            href="https://github.com/cipherwebllc/openpay"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-slate-900 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-card-hover active:translate-y-0 active:scale-[0.98] sm:w-auto"
          >
            <GithubIcon />
            {t('trustGithubLabel')} ↗
          </a>
        </div>

        <div className="mt-10 border-t border-slate-700/80 pt-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            {t('trustTitle')}
          </p>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
            {t('trustBody')}
          </p>
        </div>
        {/* 技術スタックは開発者向け補足として小さく出す (一般読者には trustBody
            だけで充足、開発者は具体技術名で OpenPay の構成を検証できる)。 */}
        <p className="mx-auto mt-6 max-w-2xl text-[11px] leading-relaxed text-slate-500">
          {t('trustTechStack')}
        </p>
      </div>
    </section>
  );
}

// GitHub mark を inline SVG で。lucide-react には Github icon が無いため
// (SiteFooter の XIcon と同パターン)。fill=currentColor で親 <a> の color を継承。
function GithubIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.93.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.07 11.07 0 0 1 5.78 0c2.21-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.15 0 1.55-.02 2.8-.02 3.18 0 .31.21.68.79.56C20.21 21.4 23.5 17.09 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}
