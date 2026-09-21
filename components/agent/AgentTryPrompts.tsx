'use client';

import { useState } from 'react';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { trackAgentEvent } from '@/lib/agentTrack';

const tagColors = {
  free: 'bg-slate-100 text-slate-700',
  paid: 'bg-amber-100 text-amber-900',
  human: 'bg-emerald-100 text-emerald-900',
};

// 文言は server page から受け取り、lib/agentPage → lib/legal を client bundle に入れない。
export function AgentTryPrompts({ locale, c }: { locale: string; c: AgentPageContent['tryPrompts'] }) {
  const { copy, copied, available: clipboardAvailable } = useCopyToClipboard();
  const available = useHydrationSafeAvailable(clipboardAvailable);
  const [copiedId, setCopiedId] = useState<AgentPageContent['tryPrompts']['items'][number]['id'] | null>(null);

  return (
    // 1 枚のカードに行を並べる (依頼文ごとにカードを分けると mobile で 1,100px を超え、磨き上げで削った全長を戻してしまう)。
    <section className="min-w-0 break-words rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <p className="mt-3 text-sm text-slate-600">{c.lead}</p>
      <ul className="mt-2 divide-y divide-slate-200/80">
        {c.items.map((item) => (
          <li key={item.id} className="min-w-0 py-3 last:pb-0">
            {/* タグとコピーを 1 行に並べ、依頼文はその下 (ボタンを依頼文の下に積むと mobile で 1 行ぶんずつ伸びる)。 */}
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className={`inline-block min-w-0 max-w-full rounded-full px-2.5 py-0.5 text-xs font-medium ${tagColors[item.kind]}`}>{item.tag}</span>
              {available ? (
                <button type="button" aria-describedby={`agent-try-prompt-${item.id}`} className="min-h-[44px] shrink-0 rounded-lg px-2 text-sm font-semibold text-emerald-700 underline underline-offset-2 transition hover:text-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600" onClick={async () => {
                  if (!await copy(item.prompt)) return;
                  setCopiedId(item.id);
                  // 依頼文の本文は送らず id だけ。計測の失敗は trackAgentEvent が隔離する (掟 13)。
                  trackAgentEvent('agent_try_prompt_copy', { locale, id: item.id });
                }}>{copied && copiedId === item.id ? c.copied : c.copy}</button>
              ) : null}
            </div>
            <p id={`agent-try-prompt-${item.id}`} className="break-words text-sm leading-relaxed text-slate-800">{item.prompt}</p>
            {item.kind === 'paid' ? <p className="mt-1 text-xs leading-relaxed text-slate-600">{c.paidNote}</p> : null}
          </li>
        ))}
      </ul>
      {/* 結果の読み上げは 1 か所だけ。ボタンの名前そのものを live region にすると、名前の変更と二重に読まれる。 */}
      <p role="status" className="sr-only">{copied && copiedId !== null ? c.copied : ''}</p>
    </section>
  );
}
