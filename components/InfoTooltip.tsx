'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

// (?) アイコン → hover (desktop) / tap (mobile) で popover。外部依存なし。
// ESC で閉じる、外側クリックで閉じる、aria-describedby でリンク。
//
// a11y 名は「{label} の詳細」で固定し、開閉は aria-expanded だけで伝える (全レビュー第 8 回 D-2)。
// label は行の可視ラベル (内訳の dt の文字) をそのまま渡す = 名前は可視テキストから導く (掟 8)。
// 全行が同じ名前だと、どの額の説明かがスクリーンリーダーで分からなかった。
export function InfoTooltip({ text, label }: { text: string; label: string }) {
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
        aria-label={t('detailsLabel', { label })}
        aria-describedby={open ? popoverId : undefined}
        aria-expanded={open}
        // 見た目は 16px の丸のまま、押せる範囲だけ ::after で広げて 24px にする (WCAG 2.2 の最小ターゲット)。
        // absolute の基準は border 1px の内側 (14px) なので四方 5px で 24px (4px だと 22px になるのを実測で確認)。
        // ボタンの箱は変えないので内訳の行の高さと位置は動かない。
        className="relative inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-500 after:absolute after:-inset-[5px] hover:border-slate-400 hover:text-slate-700"
      >
        ?
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
