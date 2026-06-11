'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { shortAddress } from '@/lib/format';
import { walletIconSrc } from '@/lib/walletIcons';
import { useVisibleConnectors } from '@/hooks/useVisibleConnectors';
import { isMobilePlatform, metamaskDappLink } from '@/lib/walletDeepLink';

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

  // useVisibleConnectors の provider プローブは非同期で、完了タイミングを外から知れない。
  // 短い猶予後に「検出ゼロ」を確定させる: ウォレットがあれば猶予内に visible が埋まり
  // 未検出 UI は出ない (検出中のチラつき防止)。猶予後も空なら「ウォレット無し」と判断。
  const [probeSettled, setProbeSettled] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setProbeSettled(true), 700);
    return () => clearTimeout(id);
  }, []);

  // モバイル判定は client effect 後に確定する。SSR / 初回 client render では false に
  // 倒し (PwaInstallHint と同パターン)、useEffect で真の platform に切替えて hydration
  // mismatch を防ぐ。useState(isMobilePlatform) の lazy init は SSR=false → hydrate=true
  // で HTML mismatch を起こす本物バグになるため避ける。
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    setIsMobile(isMobilePlatform());
  }, []);

  const dappLink =
    typeof window !== 'undefined'
      ? metamaskDappLink(window.location)
      : '';

  // injected ウォレットが visible に無いモバイル (= 通常ブラウザで開いている) では、
  // WalletConnect 接続で署名要求元が 64 桁ハッシュになり Blockaid 赤警告が出やすい。
  // MetaMask アプリ内ブラウザで開けば origin が実 URL (Verify 登録済) になり警告が
  // 構造的に出ないため、WC 接続より前に「MetaMask アプリで開く」誘導を推奨として出す。
  const hasInjected = visible.some((c) => c.type === 'injected');
  const recommendInAppBrowser =
    !isConnected &&
    probeSettled &&
    !hasInjected &&
    isMobile &&
    dappLink !== '';

  // recommendInAppBrowser が出るときは同じ導線を二重表示しないよう noWallet の amber を
  // 抑止する (visible 皆無 = injected も皆無 なので推奨カード側に寄せる)。amber は
  // 「モバイルでない/dappLink 無い」フォールバック時 (PC でウォレット皆無等) のみ。
  const noWallet =
    !isConnected && probeSettled && visible.length === 0 && !recommendInAppBrowser;

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
      {/* モバイルの通常ブラウザ (injected 無し): WC 接続より前に「MetaMask アプリで開く」
          を推奨として出す。アプリ内ブラウザなら origin が実 URL になり Blockaid 警告が
          構造的に出ない (= スムーズに支払える正しい開き方)。エラー基調にしない。 */}
      {recommendInAppBrowser && (
        <div className="rounded-lg border border-brand/40 bg-brand/5 p-3 text-sm text-slate-700">
          <p className="font-semibold text-brand-dark">
            {t('openInAppRecommendedTitle')}
          </p>
          <p className="mt-1 leading-relaxed text-slate-600">
            {t('openInAppRecommendedBody')}
          </p>
          <a
            href={dappLink}
            className="mt-2 inline-block rounded-md bg-brand px-4 py-2 font-semibold text-white hover:bg-brand-dark"
          >
            {t('openInMetaMask')}
          </a>
        </div>
      )}

      {/* 推奨カードを出したときは、WC 等の従来コネクタは「または別の方法で接続」見出しの
          下に残す (Android で MetaMask 以外を使う人や上級者のため・選択肢は奪わない)。 */}
      {recommendInAppBrowser && visible.length > 0 && (
        <p className="mt-1 text-xs font-medium text-slate-500">
          {t('orConnectAnother')}
        </p>
      )}

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

      {/* ウォレット未検出 (PC でウォレット皆無等のフォールバック): 案内 + ウォレットアプリで開く導線。 */}
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
