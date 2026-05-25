'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Connector } from 'wagmi';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { shortAddress } from '@/lib/format';

/**
 * wagmi の connectors リストから表示用のサブセットを生成する。
 * 1. injected コネクタのうち provider 不在のもの (モバイルでブラウザ拡張なし) を除外
 * 2. 同名コネクタの重複を排除 (EIP-6963 auto-discovery + 明示 target の併用時)
 */
function useVisibleConnectors(raw: readonly Connector[]): Connector[] {
  const [visible, setVisible] = useState<Connector[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const accepted: Connector[] = [];
      const seen = new Set<string>();
      for (const c of raw) {
        if (c.type === 'injected') {
          try {
            const p = await c.getProvider();
            if (!p) continue;
          } catch {
            continue;
          }
        }
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        accepted.push(c);
      }
      if (!cancelled) setVisible(accepted);
    })();
    return () => { cancelled = true; };
  }, [raw]);

  return visible;
}

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const t = useTranslations('ConnectButton');

  const visible = useVisibleConnectors(connectors);

  if (isConnected && address) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span>{shortAddress(address)}</span>
          {chain && <span className="text-slate-400">/ {chain.name}</span>}
        </div>
        <button
          type="button"
          onClick={() => disconnect()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {t('disconnect')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {visible.map((c) => (
          <button
            key={c.uid}
            type="button"
            disabled={isPending}
            onClick={() => connect({ connector: c })}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {c.name}
          </button>
        ))}
      </div>
      {error && (
        <p className="text-sm text-red-600">
          {t('connectError', { message: error.message })}
        </p>
      )}
    </div>
  );
}
