'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Connector } from 'wagmi';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { shortAddress } from '@/lib/format';
import { logger } from '@/lib/logger';

// injected provider 不在 (モバイル) の除外 + 同名 connector の dedup
function useVisibleConnectors(raw: readonly Connector[]): Connector[] {
  const [visible, setVisible] = useState<Connector[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    async function probe() {
      const accepted: Connector[] = [];
      const seen = new Set<string>();
      for (const c of raw) {
        if (ctrl.signal.aborted) return;
        if (c.type === 'injected') {
          try {
            const p = await c.getProvider();
            if (!p) continue;
          } catch (err) {
            logger.debug('connector.provider_unavailable', { name: c.name, err });
            continue;
          }
        }
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        accepted.push(c);
      }
      if (!ctrl.signal.aborted) setVisible(accepted);
    }
    probe();
    return () => ctrl.abort();
  }, [raw]);

  return visible;
}

function isUserRejection(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes('user rejected') || msg.includes('connection request reset');
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
      {error && !isUserRejection(error) && (
        <p className="text-sm text-red-600">
          {t('connectError', { message: error.message })}
        </p>
      )}
    </div>
  );
}
