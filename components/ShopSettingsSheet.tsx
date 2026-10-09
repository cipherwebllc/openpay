'use client';

// 「お店の設定」シート (決済QR・レジ共通・2026-10 磨き上げ P2)。一度決めたら変えない設定 (受取先・通貨とチェーン・
// 支払い方法・控えとポスター) を 1 か所に畳み、会計の画面には金額と商品だけを残す。
// ここは外枠 (開閉・focus・Escape・背景のスクロール止め) だけを持ち、中身は呼び出し側が組み立てる
// (設定の状態と更新の仕方は各タブの既存の handler をそのまま使う = 決済の値の作り方は変えない)。
// スマホ (640px 未満) は全画面、それ以上は右から出るパネル。

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { trapModalFocus } from '@/lib/trapModalFocus';

export function ShopSettingsSheet({
  open,
  onClose,
  title,
  doneLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 閉じるボタンの文言 (例「完了」)。 */
  doneLabel: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // useLayoutEffect: 閉じたときの後始末を、シートが DOM から外れる「前」に同期で行う。useEffect だと外れた後に
  // 非同期で走り、WebKit (CI の mobile-safari) では focus の行き先がまだ決まらず、設定ボタンへ戻らないことがあった。
  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') onCloseRef.current();
      if (panel) trapModalFocus(e, panel);
    }
    window.addEventListener('keydown', onKey);
    panel?.focus();
    // 開いている間は後ろのページをスクロールさせない (シートの中だけが動く)。
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      const active = document.activeElement;
      if (
        previousFocus instanceof HTMLElement &&
        (!active || active === document.body || panel?.contains(active))
      ) {
        previousFocus.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    // 背景を押したら閉じる (キーボードは Escape・「完了」)。パネル内の操作は閉じない (既存のモーダルと同じ形)。
    // !mt-0: 親の space-y-* が付ける上の余白で fixed の全面がずれないように (レジの親は space-y)。
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 !mt-0 print:hidden" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="relative flex h-full w-full max-w-md flex-col bg-slate-50 shadow-2xl outline-none sm:rounded-l-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4 sm:rounded-tl-2xl">
          <h2 id="shop-settings-title" className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            {doneLabel}
          </button>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 pb-10">{children}</div>
      </div>
    </div>
  );
}

/** シートの中の 1 区切り (小見出し + 白いカード)。 */
export function ShopSettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-semibold text-slate-500">{title}</h3>
      <div className="space-y-4 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">{children}</div>
    </section>
  );
}
