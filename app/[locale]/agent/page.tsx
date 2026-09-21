import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { AgentConnect } from '@/components/agent/AgentConnect';
import { AgentConfigGenerator } from '@/components/agent/AgentConfigGenerator';
import { AgentWalletCard } from '@/components/agent/AgentWalletCard';
import { AgentSafety } from '@/components/agent/AgentSafety';
import { AgentStoreLink } from '@/components/agent/AgentStoreLink';
import { agentPageContentFor, agentPageMetadata } from '@/lib/agentPage';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return agentPageMetadata(locale);
}

export default async function AgentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = agentPageContentFor(locale);
  return (
    <AppShell>
      <article className="mx-auto min-w-0 max-w-3xl space-y-8">
        <header>
          <p className="text-sm font-bold text-brand">{c.eyebrow}</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{c.title}</h1>
          <p className="mt-4 text-sm text-slate-600">{c.subtitle}</p>
        </header>
        {/* fallback は実カードの復元前 (外枠 + 見出し) と同じ形にする — 大きな予約 → 縮む → 伸びる、の 2 回シフトを避ける。 */}
        <Suspense fallback={<section className="min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6"><h2 className="text-xl font-bold text-slate-900">{c.wallet.title}</h2></section>}><AgentWalletCard c={c.wallet} /></Suspense>
        <AgentConnect locale={locale} c={c.connect} />
        <section>
          <h2 className="text-xl font-bold text-slate-900">{c.modes.title}</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {c.modes.items.map((item) => <div key={item.mode} className="min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
              <p className="text-xs font-medium text-brand">{item.tagline}</p>
              <h3 className="mt-2 text-lg font-bold text-slate-900">{item.name}</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{item.body}</p>
              <Link href={`/${locale}${item.guideHref}`} prefetch={false} className="mt-4 inline-block text-sm text-emerald-700 underline">{item.guideLabel}</Link>
            </div>)}
          </div>
        </section>
        <AgentSafety c={c.safety} />
        <AgentConfigGenerator locale={locale} c={c.generator} />
        <section className="pb-4">
          <h2 className="text-xl font-bold text-slate-900">{c.next.title}</h2>
          <p className="mt-3 text-sm text-slate-600">{c.next.body}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <AgentStoreLink locale={locale}>{c.next.storeLabel}</AgentStoreLink>
            <Link href={`/${locale}/guide/ai-pay`} prefetch={false} className="text-sm text-emerald-700 underline">{c.next.guideLabel}</Link>
          </div>
        </section>
      </article>
    </AppShell>
  );
}
