'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Connector } from 'wagmi';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { shortAddress } from '@/lib/format';

/**
 * wagmi の multiInjectedProviderDiscovery (EIP-6963) と明示的 injected({ target })
 * の両方を有効にすると、同一ウォレットが 2 つ列挙される場合がある。
 * connector.name をキーに最初の出現を残し、後続の重複を除外する。
 */
function deduplicateConnectors(connectors: Connector[]): Connector[] {
  const seen = new Set<string>();
  return connectors.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

/**
 * injected コネクタのうち provider が存在しないもの (モバイル環境でブラウザ
 * 拡張が無い場合など) を非同期で除外する。WalletConnect / Coinbase Wallet 等の
 * non-injected コネクタは常に通す。
 */
function useAvailableConnectors(rawConnectors: readonly Connector[]): Connector[] {
  const [available, setAvailable] = useState<Connector[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const results: Connector[] = [];
      for (const c of rawConnectors) {
        if (c.type !== 'injected') {
          results.push(c);
          continue;
        }
        try {
          const provider = await c.getProvider();
          if (provider) results.push(c);
        } catch {
          // provider が見つからない injected コネクタは除外
        }
      }
      if (!cancelled) setAvailable(results);
    }
    probe();
    return () => { cancelled = true; };
  }, [rawConnectors]);

  return available;
}

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connectors: rawConnectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const t = useTranslations('ConnectButton');

  const probed = useAvailableConnectors(rawConnectors);
  const connectors = useMemo(
    () => deduplicateConnectors(probed),
    [probed],
  );

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
        {connectors.map((c) => (
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
