'use client';

// CSV 24時間パス購入をモーダルで提示する (W1)。常設パネルは「未保持が正常状態」の per-use 商品に
// 押し付けがましいため、CSV ボタン押下時 (購入意図の発生時) にだけ開く。作法は QrPreviewModal を踏襲:
// open/onClose props・`if(!open) return null`・fixed inset-0 z-50 オーバーレイ・ESC で close・dialogRef
// focus・portal なし・close ボタン・overlay クリック close は付けない (QrPreviewModal に合わせる)。
// 中身は <CsvPassPaywall /> をそのまま内包する (購入成功で passLocked が flip しても自動で閉じない =
// 中の success 表示を見せる。閉じるのは利用者の close 操作のみ)。

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { CsvPassPaywall } from './CsvPassPaywall';

export function CsvPassModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('CsvPass');
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC で閉じる + dialog に focus (a11y・QrPreviewModal と同様)。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('modalTitle')}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-slate-900/70 px-4 py-8"
    >
      <div className="relative w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        {/* header: タイトル + × 閉じる */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-800">
            {t('modalTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-slate-400"
          >
            <X className="h-4 w-4" aria-hidden />
            {t('close')}
          </button>
        </div>

        <CsvPassPaywall />
      </div>
    </div>
  );
}
