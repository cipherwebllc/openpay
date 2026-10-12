'use client';

// 長いガイドの「このページの内容」(plans/guide-ux-polish.md フェーズ 1)。ページの頭の下に、たたんで置く。
// 見出しの一覧は、描画後に同じ article の h2 を集めて作る (ページごとに一覧を書かない = 見出しを足しても
// ずれない)。id の無い h2 には section-<番号> を振る。飛び先が固定ヘッダーに隠れないよう、h2 の
// scroll-margin は GuideFrame が付ける。aria-label は使わない (名前は summary の可視の文字・掟 8)。

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ListTree } from 'lucide-react';

type TocItem = { readonly id: string; readonly text: string };

export function GuideToc({ title }: { title: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [items, setItems] = useState<readonly TocItem[]>([]);

  useEffect(() => {
    const article = ref.current?.closest('article');
    if (!article) return;
    const headings = [...article.querySelectorAll('h2')];
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = `section-${index + 1}`;
    });
    setItems(headings.map((heading) => ({ id: heading.id, text: heading.textContent?.trim() ?? '' })));
  }, []);

  return (
    <details
      ref={ref}
      className="group/toc mt-6 rounded-xl border border-slate-200 bg-white print:hidden"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-4 text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
        <ListTree className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
        <span className="flex-1">{title}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/toc:rotate-180"
          aria-hidden
        />
      </summary>
      <ol className="border-t border-slate-100 px-2 py-2 text-sm">
        {items.map((item, index) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="flex min-h-10 items-start gap-3 rounded-lg px-2 py-2 leading-snug text-slate-700 [@media(hover:hover)]:hover:bg-slate-50 [@media(hover:hover)]:hover:text-slate-900"
            >
              <span className="w-5 shrink-0 text-right tabular-nums text-slate-500">{index + 1}</span>
              <span>{item.text}</span>
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
