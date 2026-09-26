'use client';

import { useState, type ReactNode } from 'react';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { AGENT_OPEN_IN_APPS, buildOpenInLink, buildSetupPrompt } from '@/lib/agentSetup';
import { trackAgentEvent } from '@/lib/agentTrack';

// 文言は server page から props で受ける (lib/agentPage → lib/legal を client bundle に入れない)。
// children = カード末尾の補足 (使い方の 2 択)。server で描いたものを受け取る。
export function AgentConnect({ locale, c, children }: { locale: string; c: AgentPageContent['connect']; children?: ReactNode }) {
  const prompt = buildSetupPrompt(locale);
  const { copy, copied, available: clipboardAvailable } = useCopyToClipboard();
  // server (clipboard なし) と client (あり) で折りたたみ・ボタンの有無が食い違う hydration エラーを避ける。
  const available = useHydrationSafeAvailable(clipboardAvailable);
  const [expanded, setExpanded] = useState(false);
  // Wallet を表示中 (再訪) は接続を済ませた人なので、カードをたたんで見出しと 1 行だけにする。
  // 開閉は CSS (並びと同じ data-agent-view) で決める: 描画前の script の判定にも追従し、ちらつかない。
  const [open, setOpen] = useState(false);
  const promptExpanded = expanded || !available;
  const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600';
  return (
    <section id="agent-connect" className="scroll-mt-24 min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-brand/30 group-data-[agent-view=wallet]:ring-slate-200/70 sm:p-8">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
          <p className="mt-2 text-sm text-slate-700 group-data-[agent-view=wallet]:hidden">{c.lead}</p>
          <p className="mt-2 hidden text-sm text-slate-600 group-data-[agent-view=wallet]:block">{c.againLead}</p>
        </div>
        <button type="button" aria-expanded={open} aria-controls="agent-connect-body" className={`hidden shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-emerald-700 group-data-[agent-view=wallet]:block ${focus}`} onClick={() => setOpen((current) => !current)}>{open ? c.promptCollapse : c.showSetup}</button>
      </div>
      <div id="agent-connect-body" className={open ? '' : 'group-data-[agent-view=wallet]:hidden'}>
        {/* prompt は人が読んで確かめる文章なので折り返す (CodeBlock は横スクロールで後半が隠れる)。 */}
        <div className="relative mt-4 overflow-hidden rounded-xl bg-slate-900 ring-1 ring-slate-700">
          <pre id="agent-setup-prompt" className={`whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-slate-100 ${promptExpanded ? '' : 'max-h-40 overflow-hidden'}`}>
            <code>{prompt}</code>
          </pre>
          {!promptExpanded ? <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-900 to-transparent" /> : null}
        </div>
        {available ? <button type="button" aria-expanded={promptExpanded} aria-controls="agent-setup-prompt" className={`mt-2 rounded-sm text-sm font-medium text-emerald-700 ${focus}`} onClick={() => setExpanded((current) => !current)}>{promptExpanded ? c.promptCollapse : c.promptExpand}</button> : null}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-3">
          {available ? (
            <button type="button" className={`w-full rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white sm:w-auto ${focus}`} onClick={async () => {
              if (await copy(prompt)) trackAgentEvent('agent_prompt_copy', { locale });
            }}>{copied ? c.copied : c.copy}</button>
          ) : null}
          <span className="text-xs text-slate-500">{c.openIn}</span>
          {AGENT_OPEN_IN_APPS.map((app) => (
            <a key={app} href={buildOpenInLink(app, prompt)} className={`rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-900 transition hover:border-brand/50 hover:bg-slate-50 ${focus}`} onClick={() => trackAgentEvent('agent_open_in', { locale, app })}>
              {c.openInApps[app]}
            </a>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          {c.openInNote} {c.shellNote}{' '}
          <a href="/agent/setup.md" className="text-emerald-700 underline">{c.setupLinkLabel}</a>
        </p>
        {children ? <div className="mt-6 border-t border-slate-200 pt-5">{children}</div> : null}
      </div>
    </section>
  );
}
