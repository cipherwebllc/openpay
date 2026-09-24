'use client';
import { env } from '@/lib/env';
import { CROSS_CHAIN_DISABLED } from '@/lib/crossChain/config';
import { chainNameForId } from '@/lib/chains';
import { useTranslations } from 'next-intl';
import type { PendingGatewayRecovery } from '@/hooks/useCrossChainPayment';
import { activeGatewayAttempt, type GatewayReplacement } from '@/lib/crossChain/gatewayRecovery';

export function CrossChainGatewayRecoveryPanel({ recovery, busy, enabled, onRecheck }: {
  recovery: PendingGatewayRecovery;
  busy: boolean;
  enabled: boolean;
  onRecheck: (replacement?: GatewayReplacement, sourceChainId?: number) => void;
}) {
  const t = useTranslations('CrossChainHint');
  if (recovery.kind === 'scanning') return null;
  if (recovery.entries) return <div className="space-y-3">{recovery.entries.map((entry) => <section key={entry.key!.sourceChainId}>
    <p className="mb-1 text-xs text-slate-600">{chainNameForId(entry.key!.sourceChainId)}</p>
    <CrossChainGatewayRecoveryPanel recovery={entry} busy={busy} enabled={enabled} onRecheck={(replacement) => onRecheck(replacement, entry.key!.sourceChainId)} />
  </section>)}</div>;
  const merchant = activeGatewayAttempt(recovery.state?.merchant);
  const status = merchant?.status === 'replaceable' && recovery.replacementAllowed === false ? 'unknown' : merchant?.status;
  const canAuthorize = enabled && env.enableGatewayCrossChain && !CROSS_CHAIN_DISABLED && recovery.replacementAllowed !== false;
  const fee = activeGatewayAttempt(recovery.state?.fee);
  const feeMissing = status === 'mintable' && (recovery.key?.feeAtomic ?? 0n) > 0n && !fee?.attestation;
  const needsFee = feeMissing && !fee && !recovery.state?.feeAttestation;
  const message = recovery.state?.completion === 'confirming' && status === 'expired-unused' ? 'gatewayConfirmationLost'
    : status === 'awaiting-finality' || status === 'confirming' ? 'gatewayFinality'
    : status === 'expired-unused' ? 'gatewayBalance'
    : status === 'awaiting-balance' ? 'gatewayInsufficientBalance'
    : status === 'replaceable' ? canAuthorize ? 'gatewayReplaceable' : 'gatewayReplacementDisabled'
    : status === 'paid' ? 'gatewayPaid'
    : needsFee ? 'gatewayFeeAuthorizationRequired'
    : feeMissing ? 'gatewayUnknown'
    : status === 'mintable' ? 'gatewayReady' : 'gatewayUnknown';
  const authorization: GatewayReplacement | undefined = canAuthorize && merchant
    ? status === 'replaceable' ? { merchant: merchant.transferSpecHash }
      : needsFee ? { authorizeFee: merchant.transferSpecHash } : undefined
    : undefined;
  return <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
    <p>{t(message)}</p>
    <button type="button" disabled={busy} onClick={() => onRecheck()} className="rounded-lg border border-amber-400 px-3 py-2 disabled:opacity-50">{t('gatewayRecheck')}</button>
    {authorization && <button type="button" disabled={busy} onClick={() => onRecheck(authorization)} className="ml-2 rounded-lg bg-amber-900 px-3 py-2 text-white disabled:opacity-50">
      {t(authorization.authorizeFee ? 'gatewayAuthorizeFee' : 'gatewayReplaceMerchant')}
    </button>}
  </div>;
}
