'use client';

import { useTranslations } from 'next-intl';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';

// クリック 1 タップで navigator.clipboard にコピー、1.5 秒間「コピー済み」フィードバック。
// navigator.clipboard は HTTPS 必須 (localhost 例外) のため、unavailable な環境では
// disabled な div として graceful degrade させる (button にはしない、誤クリック防止)。

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
  const { copied, available, copy } = useCopyToClipboard();

  const shown = displayValue ?? value;

  if (!available) {
    return (
      <span
        className={`break-all font-mono ${className}`}
        aria-label={label}
      >
        {shown}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={t('copyAria', { label })}
      className={`group inline-flex items-center gap-1 break-all font-mono text-left transition hover:bg-slate-100/60 rounded px-1 -mx-1 ${className}`}
    >
      <span className="break-all">{shown}</span>
      <span
        aria-hidden="true"
        className={`shrink-0 text-xs font-sans transition ${
          copied
            ? 'text-emerald-600'
            : 'text-slate-400 opacity-0 group-hover:opacity-100 group-focus:opacity-100'
        }`}
      >
        {copied ? `✓ ${t('copied')}` : t('copy')}
      </span>
    </button>
  );
}
