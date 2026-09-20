'use client';

import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { buildSetupPrompt } from '@/lib/agentSetup';
import { trackAgentEvent } from '@/lib/agentTrack';

// 文言は server page から props で受ける (lib/agentPage → lib/legal を client bundle に入れない)。
export function AgentConnect({ locale, c }: { locale: string; c: AgentPageContent['connect'] }) {
  const prompt = buildSetupPrompt(locale);
  const { copy, copied, available } = useCopyToClipboard();
  return (
    <section className="min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-brand/30 sm:p-8">
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <p className="mt-3 text-sm text-slate-700">{c.lead}</p>
      {/* prompt は人が読んで確かめる文章なので折り返す (CodeBlock は横スクロールで後半が隠れる)。 */}
      <pre className="mt-4 whitespace-pre-wrap break-words rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100 ring-1 ring-slate-700">
        <code>{prompt}</code>
      </pre>
      {available ? (
        <button type="button" className="mt-4 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white" onClick={async () => {
          if (await copy(prompt)) trackAgentEvent('agent_prompt_copy', { locale });
        }}>{copied ? c.copied : c.copy}</button>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{c.pasteInto}</span>
        {c.hosts.map((host) => <span key={host} className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">{host}</span>)}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.shellNote}</p>
      <a href="/agent/setup.md" className="mt-3 inline-block text-sm text-emerald-700 underline">{c.setupLinkLabel}</a>
    </section>
  );
}
