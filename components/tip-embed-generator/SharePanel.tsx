'use client';

// 公開する → 「リンクで共有」: Tip URL・コピー (主 CTA)・QR / X シェア / 新しいタブ (同格のセカンダリ行)。
// 状態は持たない — URL・X シェアの URL・コピーの状態・QR の開閉は親の TipEmbedGenerator が持つ。

import { ExternalLink, QrCode, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LinkQrModal } from '@/components/LinkQrModal';
import { QR_MAX_URL_LEN } from '@/lib/url';
import type { CopyState } from './shared';

export function SharePanel({
  tipUrl,
  xShareUrl,
  urlCopy,
  qrOpen,
  onOpenQr,
  onCloseQr,
}: {
  tipUrl: string;
  xShareUrl: string;
  urlCopy: CopyState;
  qrOpen: boolean;
  onOpenQr: () => void;
  onCloseQr: () => void;
}) {
  const t = useTranslations('TipEmbedGenerator');
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t('tipUrlTitle')}
      </h4>
      <div className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
        {tipUrl || (
          <span className="text-slate-400">{t('urlPlaceholder')}</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => urlCopy.copy(tipUrl)}
        disabled={!tipUrl}
        data-testid="tip-copy-primary"
        className="mt-3 w-full rounded-xl bg-brand px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-brand-dark active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
      >
        {urlCopy.copied ? t('copied') : t('copyLinkButton')}
      </button>
      {tipUrl && (
        <div
          data-testid="tip-share-secondary"
          className="mt-3 flex flex-wrap gap-2"
        >
          {/* リンクの QR: URL が容量を超えると qrcode.react が「Data too long」で throw し share タブが落ちる
              (長い thanksUrl/preset で URL が肥大した場合) ため、共有の上限定数以下だけ提示する
              (リンク/X シェアは長い URL でも機能する)。 */}
          {tipUrl.length <= QR_MAX_URL_LEN && (
            <>
              <button
                type="button"
                onClick={onOpenQr}
                className="inline-flex min-w-[6.5rem] flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 active:translate-y-px"
              >
                <QrCode className="h-3.5 w-3.5" aria-hidden />
                {t('qrButton')}
              </button>
              <LinkQrModal
                open={qrOpen}
                value={tipUrl}
                title={t('qrTitle')}
                closeLabel={t('qrClose')}
                onClose={onCloseQr}
              />
            </>
          )}
          {/* X (Twitter) シェア: 貼ると動的 OG カードが unfurl される。 */}
          <a
            href={xShareUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-[6.5rem] flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 active:translate-y-px"
          >
            <Share2 className="h-3.5 w-3.5" aria-hidden />
            {t('shareXButton')}
          </a>
          <a
            href={tipUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-[6.5rem] flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 active:translate-y-px"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            {t('openInNewTab')}
          </a>
        </div>
      )}
    </div>
  );
}
