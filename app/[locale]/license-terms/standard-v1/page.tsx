import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';
import { licenseTermsTemplateContentFor, licenseTermsTemplateMetadata } from '@/lib/licenseTermsTemplate';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return licenseTermsTemplateMetadata(locale);
}

// Public even when license listing flags are OFF: purchase terms must remain reachable.
export default async function StandardLicenseTermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = licenseTermsTemplateContentFor(locale);
  return (
    <AppShell>
      <article className="mx-auto max-w-3xl text-slate-800">
        <h1 className="text-2xl font-bold leading-tight text-slate-900 sm:text-3xl">{c.title}</h1>
        <p className="mt-4 text-sm leading-relaxed text-slate-600">{c.languageNote}</p>
        {locale === 'en' ? <a href={LICENSE_STANDARD_TERMS.url} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-emerald-700 underline underline-offset-2">{c.canonicalLink}</a> : null}
        <ol className="mt-8 list-decimal space-y-6 pl-6 marker:font-semibold">
          {c.items.map((item) => (
            <li key={item.title} className="pl-1">
              <h2 className="text-base font-semibold text-slate-900">{item.title}</h2>
              <p className="mt-2 text-sm leading-7 sm:text-base">{item.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 border-t border-slate-200 pt-4">
          <Link href={`/${locale}/terms`} prefetch={false} className="inline-flex min-h-11 items-center text-sm font-semibold text-emerald-700 underline underline-offset-2">{c.termsLink}</Link>
        </p>
      </article>
    </AppShell>
  );
}
