'use client';

import { useTranslations } from 'next-intl';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const t = useTranslations('ConnectButton');

  if (isConnected && address) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span>{shorten(address)}</span>
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
