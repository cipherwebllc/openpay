import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { AgentConnect } from '@/components/agent/AgentConnect';
import { AgentTryPrompts } from '@/components/agent/AgentTryPrompts';
import { AgentConfigGenerator } from '@/components/agent/AgentConfigGenerator';
import { AgentWalletCard } from '@/components/agent/AgentWalletCard';
import { AgentSafety } from '@/components/agent/AgentSafety';
import { AgentStoreLink } from '@/components/agent/AgentStoreLink';
import { AgentPageSections } from '@/components/agent/AgentPageSections';
import { agentPageContentFor, agentPageMetadata } from '@/lib/agentPage';
import { AGENT_WALLET_RESERVE } from '@/lib/agentLayout';

// 運営 (masia02) による解説記事。外部依存ゆえ参照は 1 箇所に集約する (LandingMobileOrder と同じ流儀)。
const AGENT_NOTE_ARTICLE_URL = 'https://note.com/masia02/n/nccfa34379929';

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
      <article className="min-w-0">
        {/* 先頭 3 節の順番と PC の段組みは Wallet の有無で変わる (初回: 接続が先頭の 1 列 / 再訪: 残高が主列のダッシュボード)。 */}
        <AgentPageSections
          hero={<header className="mb-8">
            <p className="text-sm font-bold text-brand">{c.eyebrow}</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{c.title}</h1>
            <p className="mt-4 text-sm text-slate-600">{c.subtitle}</p>
          </header>}
          connect={<AgentConnect locale={locale} c={c.connect}>
            <h3 className="font-bold text-slate-900">{c.modes.title}</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {c.modes.items.map((item) => <div key={item.mode} className="min-w-0 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
                <p className="text-xs font-medium text-brand">{item.tagline}</p>
                <p className="mt-1 font-bold text-slate-900">{item.name}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{item.body}</p>
                <Link href={`/${locale}${item.guideHref}`} prefetch={false} className="mt-2 inline-block text-sm text-emerald-700 underline">{item.guideLabel}</Link>
              </div>)}
            </div>
          </AgentConnect>}
          /* fallback は実カードの復元前 (外枠 + 見出し) と同じ形にする — 大きな予約 → 縮む → 伸びる、の 2 回シフトを避ける。 */
          wallet={<Suspense fallback={<section className={`min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6 ${AGENT_WALLET_RESERVE}`}><h2 className="text-xl font-bold text-slate-900">{c.wallet.title}</h2></section>}><AgentWalletCard c={c.wallet} activity={c.activity} purchases={c.purchases} /></Suspense>}
          tryPrompts={<AgentTryPrompts locale={locale} c={c.tryPrompts} />}
        >
          <AgentSafety c={c.safety} />
          <AgentConfigGenerator locale={locale} c={c.generator} />
          <section className="pb-4">
            <h2 className="text-sm font-bold text-slate-500">{c.more.title}</h2>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm lg:group-data-[agent-view=wallet]:flex-col">
              <li><AgentStoreLink locale={locale} className="text-emerald-700 underline">{c.more.storeLabel}</AgentStoreLink></li>
              <li><Link href={`/${locale}/guide/ai-pay`} prefetch={false} className="text-emerald-700 underline">{c.more.guideLabel}</Link></li>
              <li><a href={AGENT_NOTE_ARTICLE_URL} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline">{c.more.noteLabel}</a></li>
            </ul>
          </section>
        </AgentPageSections>
      </article>
    </AppShell>
  );
}
