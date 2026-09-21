'use client';

import { useTranslations } from 'next-intl';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';

// クリック 1 タップで navigator.clipboard にコピー、1.5 秒間「コピー済み」フィードバック。
// navigator.clipboard は HTTPS 必須 (localhost 例外) のため、unavailable な環境では mount 後に
// 押せない span へ落とす (graceful degrade・誤クリック防止)。mount 前は server と同形の button を
// 描く (hydration を揃えるため。まだ操作できないので偽の操作面にはならない)。

export function CopyableField({
  value,
  label,
  displayValue,
  className = '',
}: {
  value: string;
  label: string;
  displayValue?: string;
  className?: string;
}) {
  const t = useTranslations('CopyableField');
  const { copied, available: clipboardAvailable, copy } = useCopyToClipboard();
  // server と初回の client 描画を揃える (SSR されるページで hydration エラーになるため)。
  const available = useHydrationSafeAvailable(clipboardAvailable);

  const shown = displayValue ?? value;

  // a11y 名は可視テキスト (= 表示中のハッシュ) から導出する (掟 8)。何のフィールドか /
  // 押すと何が起きるかは sr-only テキストで補い、aria-label で上書きしない
  // (label-content-name-mismatch / WCAG 2.5.3)。
  if (!available) {
    return (
      <span className={`break-all font-mono ${className}`}>
        <span className="sr-only">{label}: </span>
        {shown}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className={`group inline-flex items-center gap-1 break-all font-mono text-left transition hover:bg-slate-100/60 rounded px-1 -mx-1 ${className}`}
    >
      <span className="break-all">{shown}</span>
      <span className="sr-only">{t('copyAria', { label })}</span>
      <span
        aria-hidden="true"
        className={`shrink-0 text-xs font-sans transition ${
          copied
            ? 'text-emerald-600'
            : 'text-slate-500 opacity-0 group-hover:opacity-100 group-focus:opacity-100'
        }`}
      >
        {copied ? `✓ ${t('copied')}` : t('copy')}
      </span>
    </button>
  );
}
