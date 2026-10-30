'use client';

// 「公開する」のカード: リンク共有 / サイト埋め込み の 2 択と、利用料の注記。状態は持たない — 2 択・埋め込みの形式・
// QR の開閉・コピーの状態と、URL / 埋め込みコードは親の TipEmbedGenerator が持つ。

import { Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SectionCard } from '@/components/SectionCard';
import { EmbedPanel } from './EmbedPanel';
import { SharePanel } from './SharePanel';
import type { CopyState, EmbedFormat, PublishMode } from './shared';

export function PublishSection({
  publishMode,
  onPublishModeChange,
  tipUrl,
  xShareUrl,
  urlCopy,
  qrOpen,
  onOpenQr,
  onCloseQr,
  embedFormat,
  onEmbedFormatChange,
  activeSnippet,
  iframeCopy,
}: {
  publishMode: PublishMode;
  onPublishModeChange: (mode: PublishMode) => void;
  tipUrl: string;
  xShareUrl: string;
  urlCopy: CopyState;
  qrOpen: boolean;
  onOpenQr: () => void;
  onCloseQr: () => void;
  embedFormat: EmbedFormat;
  onEmbedFormatChange: (format: EmbedFormat) => void;
  activeSnippet: string;
  iframeCopy: CopyState;
}) {
  const t = useTranslations('TipEmbedGenerator');
  return (
    <SectionCard title={t('step3Title')} headingId="tip-publish-heading" icon={Share2}>

      {/* 2 択の切替は aria-pressed のボタン (値引きの金額/率と同じ)。tab を名乗ると tabpanel・矢印キー操作が
          要るのに無かった (D7)。まとまりの名前は節の見出し「公開する」。 */}
      <div
        className="mb-3 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1"
        role="group"
        aria-labelledby="tip-publish-heading"
      >
        {(
          [
            ['share', t('publishShareTab')],
            ['embed', t('publishEmbedTab')],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={publishMode === mode}
            onClick={() => onPublishModeChange(mode)}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
              publishMode === mode
                ? 'bg-white text-brand-dark shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {publishMode === 'share' ? (
        <SharePanel
          tipUrl={tipUrl}
          xShareUrl={xShareUrl}
          urlCopy={urlCopy}
          qrOpen={qrOpen}
          onOpenQr={onOpenQr}
          onCloseQr={onCloseQr}
        />
      ) : (
        <EmbedPanel
          embedFormat={embedFormat}
          onEmbedFormatChange={onEmbedFormatChange}
          activeSnippet={activeSnippet}
          iframeCopy={iframeCopy}
        />
      )}

      <p className="mt-3 text-xs text-slate-500">{t('feeNote')}</p>
    </SectionCard>
  );
}
