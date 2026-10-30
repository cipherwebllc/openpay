'use client';

// 公開する → 「サイトに埋め込む」: iframe / ボタンの形式切替・コピー・埋め込みコード。状態は持たない —
// 形式・埋め込みコード・コピーの状態は親の TipEmbedGenerator が持つ。

import { useTranslations } from 'next-intl';
import type { CopyState, EmbedFormat } from './shared';

export function EmbedPanel({
  embedFormat,
  onEmbedFormatChange,
  activeSnippet,
  iframeCopy,
}: {
  embedFormat: EmbedFormat;
  onEmbedFormatChange: (format: EmbedFormat) => void;
  /** 表示/コピーするスニペット (iframe / button の切替済み)。tipUrl 未確定なら空。 */
  activeSnippet: string;
  iframeCopy: CopyState;
}) {
  const t = useTranslations('TipEmbedGenerator');
  return (
    <div>
      {/* 形式切替: iframe (全画面ウィジェット) / button (リンク貼付)。default iframe。 */}
      <div className="mb-2 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1">
        {(
          [
            ['iframe', t('embedIframeTab')],
            ['button', t('embedButtonTab')],
          ] as const
        ).map(([fmt, label]) => (
          <button
            key={fmt}
            type="button"
            aria-pressed={embedFormat === fmt}
            onClick={() => onEmbedFormatChange(fmt)}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
              embedFormat === fmt
                ? 'bg-white text-brand-dark shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {embedFormat === 'iframe'
            ? t('iframeTitle')
            : t('buttonSnippetTitle')}
        </h4>
        <button
          type="button"
          onClick={() => iframeCopy.copy(activeSnippet)}
          disabled={!activeSnippet}
          className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {iframeCopy.copied ? t('copied') : t('copy')}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100">
        <code>
          {activeSnippet || (
            <span className="text-slate-500">
              {t('snippetPlaceholder')}
            </span>
          )}
        </code>
      </pre>
      <p className="mt-2 text-xs text-slate-500">
        {embedFormat === 'iframe'
          ? t('embedHint')
          : t('buttonSnippetHint')}
      </p>
    </div>
  );
}
