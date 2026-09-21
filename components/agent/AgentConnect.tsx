'use client';

import { useState } from 'react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { AGENT_OPEN_IN_APPS, buildOpenInLink, buildSetupPrompt } from '@/lib/agentSetup';
import { trackAgentEvent } from '@/lib/agentTrack';

// 文言は server page から props で受ける (lib/agentPage → lib/legal を client bundle に入れない)。
export function AgentConnect({ locale, c }: { locale: string; c: AgentPageContent['connect'] }) {
  const prompt = buildSetupPrompt(locale);
  const { copy, copied, available } = useCopyToClipboard();
  const [expanded, setExpanded] = useState(false);
  const promptExpanded = expanded || !available;
  return (
    <section id="agent-connect" className="scroll-mt-24 min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-brand/30 sm:p-8">
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <p className="mt-3 text-sm text-slate-700">{c.lead}</p>
      {/* prompt は人が読んで確かめる文章なので折り返す (CodeBlock は横スクロールで後半が隠れる)。 */}
      <div className="relative mt-4 overflow-hidden rounded-xl bg-slate-900 ring-1 ring-slate-700">
        <pre id="agent-setup-prompt" className={`whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-slate-100 ${promptExpanded ? '' : 'max-h-40 overflow-hidden'}`}>
          <code>{prompt}</code>
        </pre>
        {!promptExpanded ? <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-900 to-transparent" /> : null}
      </div>
      {available ? <button type="button" aria-expanded={promptExpanded} aria-controls="agent-setup-prompt" className="mt-2 rounded-sm text-sm font-medium text-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600" onClick={() => setExpanded((current) => !current)}>{promptExpanded ? c.promptCollapse : c.promptExpand}</button> : null}
      {available ? (
        <button type="button" className="mt-3 block rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600" onClick={async () => {
          if (await copy(prompt)) trackAgentEvent('agent_prompt_copy', { locale });
        }}>{copied ? c.copied : c.copy}</button>
      ) : null}
      <div className="mt-5 flex items-center gap-3 text-xs text-slate-500">
        <span className="h-px flex-1 bg-slate-200" aria-hidden />
        {c.openIn}
        <span className="h-px flex-1 bg-slate-200" aria-hidden />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {AGENT_OPEN_IN_APPS.map((app) => (
          <a key={app} href={buildOpenInLink(app, prompt)} className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-center text-sm font-bold text-slate-900 transition hover:border-brand/50 hover:bg-slate-50" onClick={() => trackAgentEvent('agent_open_in', { locale, app })}>
            {c.openInApps[app]}
          </a>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{c.openInNote}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{c.pasteInto}</span>
        {c.hosts.map((host) => <span key={host} className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">{host}</span>)}
        <p className="w-full leading-relaxed text-slate-500">{c.shellNote}</p>
      </div>
      <a href="/agent/setup.md" className="mt-2 inline-block text-sm text-emerald-700 underline">{c.setupLinkLabel}</a>
    </section>
  );
}
