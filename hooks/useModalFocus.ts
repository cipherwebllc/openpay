'use client';

// aria-modal を名乗るダイアログの focus 管理を 1 つにまとめる (第 7 回レビュー D11)。
// 開いたら初期 focus・Tab / Shift+Tab は中だけを回る (lib/trapModalFocus)・Escape で閉じる・
// 閉じたら開く前の要素へ focus を戻す。以前は自前の trap (ボタンだけ・2 ボタン固定) や
// 何もしないダイアログが混在し、中身を足すと Tab が背後へ抜けていた。

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { trapModalFocus } from '@/lib/trapModalFocus';

// 上に重なった別のモーダルが focus を持つ間のキーは、そのモーダルに任せる。ウォレット接続の QR
// (Reown AppKit の w3m-modal・body 直下の shadow DOM に aria-modal の card) は自前で focus と Escape を
// 扱うので、ここで Tab を引き戻したり Escape で下の購入ダイアログまで閉じたりすると操作できなくなる。
function ownedByAnotherModal(event: KeyboardEvent, dialog: HTMLElement): boolean {
  for (const node of event.composedPath()) {
    if (node === dialog) return false;
    if (node instanceof Element && node.getAttribute('aria-modal') === 'true') return true;
  }
  return false;
}

export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  {
    open,
    onEscape,
    initialFocusRef,
  }: {
    open: boolean;
    /** Escape で呼ぶ。省略すると Escape では閉じない (例: 署名中)。毎回最新の関数を読む。 */
    onEscape?: () => void;
    /** 開いた直後の focus 先。省略時は dialog 自身 (tabIndex={-1} を付けておく)。 */
    initialFocusRef?: RefObject<HTMLElement | null>;
  },
): void {
  // inline の関数が毎回変わっても effect を再実行しない (再実行すると復元先が dialog 内の要素に化ける)。
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;

  // useLayoutEffect: 閉じたときの後始末を描画の前に同期で行う。useEffect だと WebKit (CI の mobile-safari) で
  // focus の行き先がまだ決まらず、開いたボタンへ戻らないことがあった (ShopSettingsSheet で実測)。
  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    // cleanup 時は ref が外れている (StrictMode の擬似 unmount も含む) ので node を捕まえておく。
    const dialog = dialogRef.current;
    function onKey(e: KeyboardEvent) {
      // IME の変換操作 (候補の取り消し等) でダイアログを閉じない・Tab を奪わない。
      if (e.isComposing || e.keyCode === 229) return;
      if (!dialog || ownedByAnotherModal(e, dialog)) return;
      if (e.key === 'Escape') onEscapeRef.current?.();
      trapModalFocus(e, dialog);
    }
    window.addEventListener('keydown', onKey);
    (initialFocusRefRef.current?.current ?? dialog)?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      // 明示的に別の要素へ移された focus は奪わない。dialog の除去で body に落ちた場合と、
      // dialog 内に残っている場合 (StrictMode の擬似 cleanup を含む) だけ戻す。
      const active = document.activeElement;
      if (
        previousFocus instanceof HTMLElement &&
        (!active || active === document.body || dialog?.contains(active))
      ) {
        previousFocus.focus();
      }
    };
    // 開閉の切替だけで走らせる (ref は安定・関数は上の ref から読む)。
  }, [open, dialogRef]);
}
