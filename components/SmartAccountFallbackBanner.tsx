'use client';

import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { shortAddress } from '@/lib/format';

type Props = {
  delegateAddress: Address | null;
  nativeToken: string;
  canFallbackToStandard: boolean;
  onSwitchToStandard?: () => void;
};

export function SmartAccountFallbackBanner({
  delegateAddress,
  nativeToken,
  canFallbackToStandard,
  onSwitchToStandard,
}: Props) {
  const t = useTranslations('SmartAccountFallback');
  const addr = delegateAddress ? shortAddress(delegateAddress) : 'unknown';

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">
        {t(canFallbackToStandard ? 'bannerTitle' : 'tipOnlyTitle')}
      </p>
      <p className="mt-1 text-xs">
        {canFallbackToStandard
          ? t('bannerBody', { address: addr, nativeToken })
          : t('tipOnlyBody', { address: addr })}
      </p>
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
