'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

// (?) アイコン → hover (desktop) / tap (mobile) で popover。外部依存なし。
// ESC で閉じる、外側クリックで閉じる、aria-describedby でリンク。

export function InfoTooltip({ text, label }: { text: string; label?: string }) {
  const t = useTranslations('InfoTooltip');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const popoverId = useRef(
    `tip-${Math.random().toString(36).slice(2, 9)}`,
  ).current;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClickOutside);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClickOutside);
    };
  }, [open]);

  return (
    <span ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? t('closeLabel') : t('openLabel')}
        aria-describedby={open ? popoverId : undefined}
        aria-expanded={open}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-500 hover:border-slate-400 hover:text-slate-700"
      >
        ?
        {label !== undefined && <span className="sr-only">{label}</span>}
      </button>
      {open && (
        <span
          id={popoverId}
          role="tooltip"
          className="absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-md border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-700 shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
