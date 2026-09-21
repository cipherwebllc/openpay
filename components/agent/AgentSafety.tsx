import type { AgentPageContent } from '@/lib/agentPage';

export function AgentSafety({ c }: { c: AgentPageContent['safety'] }) {
  return (
    <section className="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200/70 sm:p-6">
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <span className="mt-3 inline-block rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-900">{c.enforcedBadge}</span>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">{c.summary.map((point) => <li key={point}>{point}</li>)}</ul>
      <details className="mt-3">
        <summary className="cursor-pointer rounded-sm text-sm font-medium text-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600">{c.detailsLabel}</summary>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.body}</p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-600">{c.points.map((point) => <li key={point}>{point}</li>)}</ul>
      </details>
    </section>
  );
}
