'use client';

// リンク共有用のシンプルな QR ポップアップ (プロフの所有ハンドル一覧 / チップタブ共用)。
// 一覧やフォームに QR を常時並べると縦長で読みにくいため、ボタン経由のモーダル提示にする。
// a11y: 開いたら閉じるボタンへフォーカス・Tab は背後のページへ抜けないようトラップ・
// 閉じたら元の要素へ復元 (aria-modal を実挙動で担保・共通の useModalFocus)。ESC / 背景クリックでも閉じる。

import { useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useModalFocus } from '@/hooks/useModalFocus';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 開いたら閉じるボタンへ focus (中の操作はこれだけ)・Tab は中だけ・閉じたら元の要素へ戻す。
  useModalFocus(dialogRef, { open, onEscape: onClose, initialFocusRef: closeRef });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
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
        <p className="mt-3 break-all text-xs text-slate-500">{value}</p>
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
