// ガイドの「たためるカード」(plans/guide-ux-polish.md フェーズ 2)。選んだものだけを開いて読む長い手順
// (store の配布方法・共通の注意点など) に使う。見出しと要点 (summary) は常に見せ、本文はたたむ。
// JS を使わない <details>。aria-label は使わない (名前は summary の可視の文字・掟 8)。

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function GuideDisclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-2xl px-4 py-4 sm:px-5 [@media(hover:hover)]:hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">{summary}</div>
        <ChevronDown
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-t border-slate-100 px-4 pb-5 pt-4 sm:px-5">{children}</div>
    </details>
  );
}
