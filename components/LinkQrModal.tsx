'use client';

// リンク共有用のシンプルな QR ポップアップ (プロフの所有ハンドル一覧 / チップタブ共用)。
// 一覧やフォームに QR を常時並べると縦長で読みにくいため、ボタン経由のモーダル提示にする。
// a11y: 開いたら閉じるボタンへフォーカス・Tab は背後のページへ抜けないようトラップ・
// 閉じたら元の要素へ復元 (aria-modal を実挙動で担保)。ESC / 背景クリックでも閉じる。

import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export function LinkQrModal({
  open,
  value,
  title,
  closeLabel,
  onClose,
}: {
  open: boolean;
  /** QR にエンコードするフル URL (本文にも表示する)。 */
  value: string;
  /** モーダル見出し (例: "@alice"・"リンクの QR コード")。aria-label も兼ねる。 */
  title: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // onClose を ref 経由で読む。inline arrow は毎レンダ別 identity なので、これを effect の
  // dep にすると表示中の親再レンダで effect が再実行され returnFocusRef を閉じるボタン自身で
  // 上書きしてしまう (閉じた後の復元 focus が detach ノードへの no-op になり a11y 退行)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 捕捉/復元は open の遷移時のみ走らせる (deps は [open] に限定)。
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      // ダイアログ内のフォーカス可能要素は閉じるボタンのみ → Tab で背後のページへ
      // 抜けないよう閉じるボタンに留める。
      if (e.key === 'Tab') {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    // cleanup (= 閉じる/unmount 時) に元の要素へフォーカスを復元する。
    return () => {
      window.removeEventListener('keydown', onKey);
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs rounded-2xl bg-white p-6 text-center shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="break-all font-mono text-sm font-semibold text-slate-800">
          {title}
        </p>
        <div className="mt-4 flex justify-center">
          <QRCodeSVG value={value} size={220} includeMargin level="M" />
        </div>
        <p className="mt-3 break-all text-xs text-slate-400">{value}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          {closeLabel}
        </button>
      </div>
    </div>
  );
}
