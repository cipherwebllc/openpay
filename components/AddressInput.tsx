'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { isLikelyName } from '@/lib/nameDetection';

// 0x / .eth / .base.eth を受け付ける。名前解決成功時のみ onResolved に
// checksum 化された Address を通知。入力値の永続化は親の責任 (生入力を
// 保存し submit 時に再解決する設計)。
export function AddressInput({
  value,
  onChange,
  onResolved,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolved?: (address: Address | null) => void;
  placeholder?: string;
}) {
  const t = useTranslations('AddressInput');
  const trimmed = value.trim();
  const looksLikeName = isLikelyName(trimmed);
  const query = useResolveAddress(looksLikeName ? trimmed : '');

  useEffect(() => {
    if (!onResolved) return;
    if (query.data) {
      onResolved(query.data.address);
    } else {
      onResolved(null);
    }
  }, [query.data, onResolved]);

  return (
    <div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder ?? t('placeholder')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
      />
      {looksLikeName && query.isFetching && (
        <p className="mt-1 text-xs text-slate-500">{t('resolving')}</p>
      )}
      {looksLikeName && query.error && (
        <p className="mt-1 text-xs text-red-600">{query.error.message}</p>
      )}
      {looksLikeName && query.data?.name && (
        // R: span 直接に break-all を付ける。iOS Safari は font-family 切替時に
        //    親 <p> の word-break 継承が不安定で、0x アドレスが viewport を突き抜ける。
        <p className="mt-1 break-all text-xs text-emerald-700">
          ✓ {query.data.name} →{' '}
          <span className="break-all font-mono">{query.data.address}</span>
        </p>
      )}
    </div>
  );
}
