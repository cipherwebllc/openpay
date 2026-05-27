'use client';

import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { shortAddress } from '@/lib/format';

type Props = {
  delegateAddress: Address | null;
  nativeToken: string;
  canFallbackToStandard: boolean;
  onSwitchToStandard?: () => void;
  // 'pristine': 未委任 EOA で初回ガスレス不可 (delegate 無し → address を出さない文言)。
  // 'incompatible': 未対応の delegate に委任済み (delegate address を出す)。default。
  reason?: 'pristine' | 'incompatible';
};

export function SmartAccountFallbackBanner({
  delegateAddress,
  nativeToken,
  canFallbackToStandard,
  onSwitchToStandard,
  reason = 'incompatible',
}: Props) {
  const t = useTranslations('SmartAccountFallback');
  const addr = delegateAddress ? shortAddress(delegateAddress) : 'unknown';
  const isPristine = reason === 'pristine';

  const title = isPristine
    ? t('pristineTitle')
    : t(canFallbackToStandard ? 'bannerTitle' : 'tipOnlyTitle');
  const body = isPristine
    ? canFallbackToStandard
      ? t('pristineBannerBody', { nativeToken })
      : t('pristineTipBody')
    : canFallbackToStandard
      ? t('bannerBody', { address: addr, nativeToken })
      : t('tipOnlyBody', { address: addr });

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-xs">{body}</p>
      {canFallbackToStandard && (
        <button
          type="button"
          onClick={onSwitchToStandard}
          className="mt-3 w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
        >
          {t('switchButton')}
        </button>
      )}
    </div>
  );
}
