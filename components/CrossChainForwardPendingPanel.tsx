'use client';

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import type { PendingForwardRecovery } from '@/hooks/useCrossChainPayment';
import type { AcceptedQuote } from '@/lib/crossChain/cctp';
import { blockExplorerUrl } from '@/lib/chains';

export function CrossChainForwardPendingPanel({ recovery, quote, busy, disabled, onRecheck, onConsent }: {
  recovery: PendingForwardRecovery; quote?: AcceptedQuote; busy: boolean; disabled?: boolean;
  onRecheck: () => void; onConsent: () => void;
}) {
  const t = useTranslations('CrossChainForwardPendingPanel');
  const forward = recovery.state?.forward;
  const sourceExplorer = recovery.sourceChainId ? blockExplorerUrl(recovery.sourceChainId) : undefined;
  const destExplorer = forward ? blockExplorerUrl(forward.acceptedQuote.destChainId) : undefined;
  const pre = forward?.state === 'intent' || forward?.state === 'broadcast';
  return (
    <section className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm" aria-live="polite">
      <p className="font-semibold">{t('title')}</p>
      <p>{t(recovery.kind === 'scanning' ? 'scanning' : recovery.kind === 'unreadable' ? 'unreadable' : forward?.sourceUnresolved ? 'unresolved' : pre ? 'preConfirmation' : forward?.state === 'verified' ? 'verified' : !forward?.nonce ? 'waitingCircle' : 'waitingMint')}</p>
      {forward?.delayReason && <p>{t('delay', { reason: forward.delayReason })}</p>}
      {sourceExplorer && recovery.state?.burnTxHash && <a className="block underline" href={`${sourceExplorer}/tx/${recovery.state.burnTxHash}`} target="_blank" rel="noreferrer">{t('sourceTx')}</a>}
      {destExplorer && forward?.candidateHash && <a className="block underline" href={`${destExplorer}/tx/${forward.candidateHash}`} target="_blank" rel="noreferrer">{t('destinationTx')}</a>}
      {recovery.kind === 'pending' && <button type="button" className="rounded border px-3 py-2" disabled={busy || disabled} onClick={onRecheck}>{t(busy ? 'checking' : 'recheck')}</button>}
      {quote && <div className="space-y-2">
        <p>{t('quote', { fee: formatUnits(BigInt(quote.maxFeeAtomic), 6), total: formatUnits(BigInt(quote.grossAtomic), 6) })}</p>
        <button type="button" className="rounded border px-3 py-2" disabled={busy || disabled} onClick={onConsent}>{t('consent')}</button>
      </div>}
      <a className="block underline" href="https://github.com/cipherwebllc/openpay/blob/main/docs/DEPLOY_CHECKLIST.md#1012-arc-forwarding">{t('help')}</a>
    </section>
  );
}
