'use client';

// 遠隔の注文 (注文リンクなど) の支払いの後、お客様が自分の LINE やメールで「払いました」をお店に知らせる文を用意する。
// 文はこのブラウザの中で作り、スマホの共有 (Web Share) かコピーで渡すだけ。OpenPay のサーバーには送らない
// (注文の内容やお客様の情報を OpenPay が受け取らない・2026-11-03 裁定)。Tx Hash と金額は公開のチェーンの情報。

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Send } from 'lucide-react';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';

type Tone = 'overlay' | 'panel';

const PRIMARY: Record<Tone, string> = {
  overlay:
    'inline-flex min-h-12 w-full max-w-md items-center justify-center gap-2 rounded-xl bg-white px-5 text-base font-bold text-emerald-700 shadow-lg hover:bg-emerald-50',
  panel:
    'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 text-base font-bold text-white hover:bg-brand-dark',
};
const SECONDARY: Record<Tone, string> = {
  overlay: 'inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-white underline underline-offset-4',
  panel: 'inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark',
};
const NOTE: Record<Tone, string> = {
  overlay: 'text-center text-xs text-white/90',
  panel: 'text-center text-xs text-slate-600',
};

/**
 * 遠隔の注文の会計か (お店に知らせるボタンを出すか)。受付番号があり、店頭のモバイル注文 (@handle・利用料の種類) と
 * お店の端末で送る会計ではないとき (注文リンクや外部の /checkout リンク)。
 */
export function isRemoteOrderCheckout(params: {
  orderId?: string;
  storeHandle?: string;
  feeKind?: string;
  submit?: 'store';
}): boolean {
  return Boolean(params.orderId) && !params.storeHandle && !params.feeKind && params.submit !== 'store';
}

/** お店に送る文 (受付番号・金額・Tx Hash・Explorer のリンク)。 */
export function notifyShopMessage(input: {
  intro: string;
  amountLine: string;
  txHash: string;
  explorerTxUrl?: string;
}): string {
  return [input.intro, input.amountLine, `Tx Hash: ${input.txHash}`, input.explorerTxUrl]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function NotifyShopButton({
  orderNo,
  amountDisplay,
  txHash,
  explorerTxUrl,
  tone,
}: {
  orderNo: string;
  amountDisplay: string;
  txHash: string;
  explorerTxUrl?: string;
  tone: Tone;
}) {
  const t = useTranslations('SuccessOverlay');
  const textId = useId();
  const copier = useCopyToClipboard();
  const canCopy = useHydrationSafeAvailable(copier.available);
  const canShare = useHydrationSafeAvailable(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  const [status, setStatus] = useState<'idle' | 'shared' | 'copied' | 'failed'>('idle');
  const text = notifyShopMessage({
    intro: t('notifyShopMessage', { id: orderNo }),
    amountLine: `${t('amountLabel')}: ${amountDisplay}`,
    txHash,
    explorerTxUrl,
  });

  const copy = async () => {
    setStatus((await copier.copy(text)) ? 'copied' : 'failed');
  };
  const notify = async () => {
    if (!canShare) {
      await copy();
      return;
    }
    try {
      await navigator.share({ text });
      setStatus('shared');
    } catch {
      // 取り消しは正常系。共有できなくても下の「文をコピー」が残る (掟 13)。
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-1">
      <button type="button" onClick={() => void notify()} className={PRIMARY[tone]}>
        <Send className="h-5 w-5" aria-hidden />
        {t('notifyShop')}
      </button>
      <p className={NOTE[tone]}>{t('notifyShopHint')}</p>
      {canShare && canCopy && (
        <button type="button" onClick={() => void copy()} className={SECONDARY[tone]}>
          <Copy className="h-4 w-4" aria-hidden />
          {t('notifyShopCopy')}
        </button>
      )}
      {(status === 'shared' || status === 'copied') && (
        <p role="status" className={`inline-flex items-center gap-1 ${NOTE[tone]}`}>
          <Check className="h-3.5 w-3.5" aria-hidden />
          {t(status === 'shared' ? 'notifyShopShared' : 'notifyShopCopied')}
        </p>
      )}
      {/* コピーもできない環境では、文を選んで写せるように見せる。 */}
      {status === 'failed' && (
        <div className="mt-1 w-full max-w-md">
          <label htmlFor={textId} className={`block ${NOTE[tone]}`}>
            {t('notifyShopTextLabel')}
          </label>
          <textarea
            id={textId}
            readOnly
            value={text}
            rows={4}
            onFocus={(event) => event.target.select()}
            className="mt-1 w-full rounded-lg bg-white px-3 py-2 font-mono text-xs text-slate-700 ring-1 ring-slate-200"
          />
        </div>
      )}
    </div>
  );
}
