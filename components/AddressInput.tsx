'use client';

import { useEffect } from 'react';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { isLikelyName } from '@/lib/resolveAddress';

// 受取アドレス入力。0x アドレスまたは .eth / .base.eth を受け付け、
// 名前解決の結果を resolved に返す (親が settings.receiver の確定値として
// 保存できる)。0x がそのまま入力されたら即時 resolved を呼ぶ。
//
// "resolved" の責任分担:
// - 入力中の文字列 (input) は親が state として保持
// - 解決結果 (resolved address) は名前から解決した時のみ親へ通知
// - parent はどちらを保存するか自由 (現状は input を保存し、submit 時に再解決)
export function AddressInput({
  value,
  onChange,
  onResolved,
  placeholder = '0x... または vitalik.eth / name.base.eth',
}: {
  value: string;
  onChange: (v: string) => void;
  onResolved?: (address: `0x${string}` | null) => void;
  placeholder?: string;
}) {
  const trimmed = value.trim();
  const looksLikeName = isLikelyName(trimmed);
  // 0x アドレスは isAddress でローカル検証されるので RPC を叩かない。
  // 名前 (.eth / .base.eth) のときだけ enabled。
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
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
      />
      {looksLikeName && query.isFetching && (
        <p className="mt-1 text-xs text-slate-500">名前を解決しています…</p>
      )}
      {looksLikeName && query.error && (
        <p className="mt-1 text-xs text-red-600">{query.error.message}</p>
      )}
      {looksLikeName && query.data?.name && (
        <p className="mt-1 break-all text-xs text-emerald-700">
          ✓ {query.data.name} →{' '}
          <span className="font-mono">{query.data.address}</span>
        </p>
      )}
    </div>
  );
}
