'use client';

// AppHeader 右上に常時表示する compact wallet badge。
// 接続時: 短縮アドレス + chain.name の chip + ▾ で開く dropdown (disconnect)。
// 未接続時: 「接続」ボタン + ▾ で開く dropdown (利用可能 connector 一覧)。
// dropdown は native <details> で実装し、JS state を最小化する。

import { useTranslations } from 'next-intl';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { ChevronDown } from 'lucide-react';
import { shortAddress } from '@/lib/format';
import { useVisibleConnectors } from '@/hooks/useVisibleConnectors';

function isUserRejection(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes('user rejected') || msg.includes('connection request reset');
}

export function WalletBadge() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const t = useTranslations('Nav');
  const tConnect = useTranslations('ConnectButton');
  const visible = useVisibleConnectors(connectors);

  if (isConnected && address) {
    return (
      <details className="group relative">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          <span className="font-mono">{shortAddress(address)}</span>
          {chain && (
            <span className="hidden text-slate-500 sm:inline">/ {chain.name}</span>
          )}
          <ChevronDown
            className="h-3 w-3 text-slate-400 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-lg"
        >
          {chain && (
            <p className="px-3 py-1 text-[11px] text-slate-500">
              {chain.name}
            </p>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => disconnect()}
            className="block w-full rounded-md px-3 py-1.5 text-left text-slate-700 hover:bg-slate-100"
          >
            {t('disconnect')}
          </button>
        </div>
      </details>
    );
  }

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark">
        {t('connect')}
        <ChevronDown
          className="h-3 w-3 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div
        role="menu"
        className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-lg"
      >
        {visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-slate-500">…</p>
        ) : (
          visible.map((c) => (
            <button
              key={c.uid}
              type="button"
              role="menuitem"
              disabled={isPending}
              onClick={() => connect({ connector: c })}
              className="block w-full rounded-md px-3 py-1.5 text-left text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {c.name}
            </button>
          ))
        )}
        {error && !isUserRejection(error) && (
          <p className="px-3 pb-2 pt-1 text-xs text-red-600">
            {tConnect('connectError', { message: error.message })}
          </p>
        )}
      </div>
    </details>
  );
}
