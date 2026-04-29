'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

// クリック 1 タップで navigator.clipboard にコピー、1.5 秒間「コピー済み」フィードバック。
// navigator.clipboard は HTTPS 必須 (localhost 例外) のため、unavailable な環境では
// disabled な div として graceful degrade させる (button にはしない、誤クリック防止)。

const COPIED_FEEDBACK_MS = 1500;

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
  const [state, setState] = useState<'idle' | 'copied'>('idle');

  const clipboardAvailable =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined';

  async function copy() {
    if (!clipboardAvailable) return;
    await navigator.clipboard.writeText(value);
    setState('copied');
    setTimeout(() => setState('idle'), COPIED_FEEDBACK_MS);
  }

  const shown = displayValue ?? value;

  if (!clipboardAvailable) {
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
      onClick={copy}
      aria-label={t('copyAria', { label })}
      className={`group inline-flex items-center gap-1 break-all font-mono text-left transition hover:bg-slate-100/60 rounded px-1 -mx-1 ${className}`}
    >
      <span className="break-all">{shown}</span>
      <span
        aria-hidden="true"
        className={`shrink-0 text-xs font-sans transition ${
          state === 'copied'
            ? 'text-emerald-600'
            : 'text-slate-400 opacity-0 group-hover:opacity-100 group-focus:opacity-100'
        }`}
      >
        {state === 'copied' ? `✓ ${t('copied')}` : t('copy')}
      </span>
    </button>
  );
}
