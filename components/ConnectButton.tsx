'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { shortAddress } from '@/lib/format';
import { walletIconSrc } from '@/lib/walletIcons';
import { useVisibleConnectors } from '@/hooks/useVisibleConnectors';

function isUserRejection(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes('user rejected') || msg.includes('connection request reset');
}

// ウォレットアプリ (MetaMask) の in-app ブラウザで現在ページを開くディープリンク。
// SNS リンクをモバイルの通常ブラウザで開くと injected ウォレットが無く接続できない
// ことが多いため、ウォレットアプリへ誘導する (metamask.app.link/dapp/<host+path>)。
function metamaskDappLink(): string {
  if (typeof window === 'undefined') return '';
  const { host, pathname, search } = window.location;
  return `https://metamask.app.link/dapp/${host}${pathname}${search}`;
}

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const t = useTranslations('ConnectButton');

  const visible = useVisibleConnectors(connectors);

  // useVisibleConnectors の provider プローブは非同期で、完了タイミングを外から知れない。
  // 短い猶予後に「検出ゼロ」を確定させる: ウォレットがあれば猶予内に visible が埋まり
  // 未検出 UI は出ない (検出中のチラつき防止)。猶予後も空なら「ウォレット無し」と判断。
  const [probeSettled, setProbeSettled] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setProbeSettled(true), 700);
    return () => clearTimeout(id);
  }, []);
  const noWallet = !isConnected && probeSettled && visible.length === 0;

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

  const dappLink = metamaskDappLink();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {visible.map((c) => (
          <button
            key={c.uid}
            type="button"
            disabled={isPending}
            onClick={() => connect({ connector: c })}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {/* ウォレットアイコン (EIP-6963 data URI or 同梱 SVG)。brand 青地で青系ロゴが
                沈まないよう白チップに載せる。装飾なので alt は空。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={walletIconSrc(c)}
              alt=""
              aria-hidden
              className="h-5 w-5 shrink-0 rounded-md bg-white object-contain p-0.5"
            />
            {c.name}
          </button>
        ))}
      </div>

      {/* ウォレット未検出 (モバイルの通常ブラウザ等): 案内 + ウォレットアプリで開く導線。 */}
      {noWallet && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">{t('noWalletTitle')}</p>
          <p className="mt-1 leading-relaxed">{t('noWalletHint')}</p>
          {dappLink && (
            <a
              href={dappLink}
              className="mt-2 inline-block rounded-md bg-brand px-3 py-1.5 font-semibold text-white hover:bg-brand-dark"
            >
              {t('openInMetaMask')}
            </a>
          )}
        </div>
      )}

      {error && !isUserRejection(error) && (
        <p className="text-sm text-red-600">
          {t('connectError', { message: error.message })}
        </p>
      )}
    </div>
  );
}
