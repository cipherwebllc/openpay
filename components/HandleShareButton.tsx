'use client';

import { useState } from 'react';
import { Copy, QrCode, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LinkQrModal } from '@/components/LinkQrModal';
import { useOrigin } from '@/hooks/useOrigin';

export function HandleShareButton({
  handle,
  name,
  dark = false,
}: {
  handle: string;
  name?: string;
  dark?: boolean;
}) {
  const t = useTranslations('HandleProfile');
  const origin = useOrigin();
  const [open, setOpen] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const shareUrl = origin ? `${origin}/@${handle}` : '';
  const shareText = name
    ? t('shareTextNamed', { name, handle })
    : t('shareTextGeneric', { handle });
  const xShareUrl = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`
    : '';
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copyUrl = async () => {
    if (!shareUrl || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permissions must not make QR/X sharing unavailable.
    }
  };

  const shareElsewhere = async () => {
    if (!shareUrl || !navigator.share) return;
    try {
      await navigator.share({ title: shareText, text: shareText, url: shareUrl });
    } catch {
      // ユーザ取消 (AbortError) や許可拒否は正常系。共有失敗がページ本体に波及しないよう
      // ここで握る (掟13: コピー/QR/X の代替導線が常に残るため黙殺で害がない)。
    }
  };

  const triggerClass = dark
    ? 'border-white/20 bg-white/10 text-slate-100 hover:bg-white/15 disabled:border-white/10 disabled:text-slate-500'
    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:text-slate-400';
  const popoverClass = dark
    ? 'border-slate-700 bg-slate-900 text-slate-100 shadow-black/30'
    : 'border-slate-200 bg-white text-slate-800 shadow-slate-900/10';
  const actionClass = dark
    ? 'hover:bg-white/10 focus-visible:bg-white/10'
    : 'hover:bg-slate-50 focus-visible:bg-slate-50';

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!shareUrl}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60 ${triggerClass}`}
      >
        <Share2 className="h-3.5 w-3.5" aria-hidden />
        {t('share')}
      </button>

      {open ? (
        <div
          className={`absolute left-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border py-1 shadow-lg ${popoverClass}`}
        >
          <button
            type="button"
            onClick={() => void copyUrl()}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition ${actionClass}`}
          >
            <Copy className="h-4 w-4" aria-hidden />
            {copied ? t('copied') : t('copyUrl')}
          </button>
          <button
            type="button"
            onClick={() => setShowQr(true)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition ${actionClass}`}
          >
            <QrCode className="h-4 w-4" aria-hidden />
            {t('showQr')}
          </button>
          <a
            href={xShareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition ${actionClass}`}
          >
            <span className="flex h-4 w-4 items-center justify-center text-xs font-bold" aria-hidden>
              X
            </span>
            {t('shareOnX')}
          </a>
          {canNativeShare ? (
            <button
              type="button"
              onClick={() => void shareElsewhere()}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition ${actionClass}`}
            >
              <Share2 className="h-4 w-4" aria-hidden />
              {t('moreShare')}
            </button>
          ) : null}
        </div>
      ) : null}

      <LinkQrModal
        open={showQr}
        value={shareUrl}
        title={t('shareQrTitle', { handle })}
        closeLabel={t('qrClose')}
        onClose={() => setShowQr(false)}
      />
    </div>
  );
}
