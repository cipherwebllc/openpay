'use client';

// ガイドの右の列 (xl 以上) に固定する「このページの内容」。読んでいる節を色と左の線で示す (scroll spy)。
// 見出しの集め方と id の振り方は GuideToc (xl 未満の本文の頭の折りたたみ) と同じ規則にする
// (h2:not([data-toc="skip"])・名前は data-toc-label 優先・id が無ければ section-<番号>)。どちらが先に動いても
// 同じ id になるので、両方から同じ見出しへ飛べる。見出しが 2 つ未満のページは何も出さない。
// a11y: nav の名前は可視の見出しを aria-labelledby で指す (aria-label は使わない・掟 8)。

import { useEffect, useRef, useState } from 'react';

type Item = { readonly id: string; readonly text: string };

// 固定ヘッダーの下端 (約 72px) + 余白。これより上に頭が出た見出しを「読んでいる節」とみなす。
const ACTIVE_OFFSET_PX = 120;

export function GuideOnThisPage({ title }: { title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<readonly Item[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const article = ref.current?.closest('[data-guide-frame]')?.querySelector('article');
    if (!article) return;
    const headings = [...article.querySelectorAll<HTMLElement>('h2:not([data-toc="skip"])')];
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = `section-${index + 1}`;
    });
    setItems(
      headings.map((heading) => ({
        id: heading.id,
        text: (heading.dataset.tocLabel ?? heading.textContent ?? '').trim(),
      })),
    );
    if (headings.length < 2) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      // ページの最後まで読んだら、最後の見出しが短くても最後の節を示す。
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= ACTIVE_OFFSET_PX) current = heading;
        else break;
      }
      setActiveId(atBottom ? headings[headings.length - 1].id : current.id);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div ref={ref} className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-1">
      {items.length >= 2 ? (
        <nav aria-labelledby="guide-on-this-page-title">
          <p id="guide-on-this-page-title" className="mb-2 text-xs font-semibold text-slate-500">
            {title}
          </p>
          <ul className="space-y-0.5 border-l border-slate-200 text-[13px] leading-5">
            {items.map((item) => {
              const active = item.id === activeId;
              return (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    aria-current={active ? 'location' : undefined}
                    className={`-ml-px block border-l-2 py-1 pl-3 pr-1 transition-colors ${
                      active
                        ? 'border-emerald-600 font-semibold text-emerald-800'
                        : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
                    }`}
                  >
                    {item.text}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
