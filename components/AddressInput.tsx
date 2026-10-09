'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { isLikelyName } from '@/lib/nameDetection';
import { ResolveAddressError } from '@/lib/resolveAddressError';

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

  // 再解決に失敗しても react-query は前回の解決結果 (data) を残す。失敗した名前の古いアドレスを着金先として
  // 渡さない・表示しないため、失敗中は「解決できていない」と扱う。
  const resolvedAddress = query.error ? null : query.data?.address ?? null;
  useEffect(() => {
    if (!onResolved) return;
    onResolved(resolvedAddress);
  }, [resolvedAddress, onResolved]);

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
        // 未登録・形式違いはそのまま。RPC や外部サーバ (CCIP-Read) の失敗は生の技術的な文面を見せず言い換える。
        <p className="mt-1 text-xs text-red-600">
          {query.error instanceof ResolveAddressError ? query.error.message : t('resolveFailed')}
        </p>
      )}
      {looksLikeName && !query.error && query.data?.name && (
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
