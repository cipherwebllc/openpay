'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useAccount, useReadContract } from 'wagmi';
import { erc20Abi, formatUnits, isAddress } from 'viem';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { chainNameForId } from '@/lib/chains';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

// 再訪時に残高カードをすぐ出すための端末ローカルの控え (公開アドレスのみ・秘密ではない)。
const STORAGE_KEY = 'openpay.agent.address';

const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });
const AgentFundFromWallet = dynamic(() => import('./AgentFundFromWallet').then((m) => m.AgentFundFromWallet), { ssr: false });

export function AgentWalletCard({ c }: { c: AgentPageContent['wallet'] }) {
  const locale = useLocale();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const params = useSearchParams();
  const [input, setInput] = useState(() => {
    const initial = params.get('address');
    return initial && isAddress(initial) ? initial : '';
  });
  // localStorage は SSR と初回描画に無いので mount 後に読む (hydration 不一致を避ける)。
  // ブラウザ API の失敗 (private mode 等) をページ描画へ波及させないための try-catch。
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && isAddress(saved)) setInput((current) => (current === '' ? saved : current));
    } catch {
      // 控えが読めなくても手入力で使える。
    }
  }, []);
  const { address: connectedAddress, isConnected } = useAccount();
  const { copy, copied, available } = useCopyToClipboard();
  const value = input.trim();
  const address = isAddress(value) ? value : undefined;
  useEffect(() => {
    try {
      if (address) window.localStorage.setItem(STORAGE_KEY, address);
      else if (value === '') window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 控えの保存失敗は次回の手入力で足りる。
    }
  }, [address, value]);
  const deployment = defaultDeploymentForSymbol('jpyc');
  const balance = useReadContract({
    abi: erc20Abi,
    address: deployment.address,
    chainId: deployment.chainId,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  return (
    <section className="min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-8">
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <p className="mt-3 text-sm text-slate-700">{c.lead}</p>
      <label htmlFor="agent-wallet-address" className="mt-5 block text-sm font-medium">{c.inputLabel}</label>
      <input id="agent-wallet-address" className="mt-2 block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm" placeholder={c.inputPlaceholder} value={input} spellCheck={false} autoCapitalize="none" aria-invalid={Boolean(value && !address)} aria-describedby={value && !address ? 'agent-wallet-error' : undefined} onChange={(e) => setInput(e.target.value)} />
      {value && !address ? <p id="agent-wallet-error" className="mt-2 text-xs text-red-700">{c.invalidAddress}</p> : null}
      {isConnected && connectedAddress ? <button type="button" className="mt-3 rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium" onClick={() => setInput(connectedAddress)}>{c.useConnected}</button> : null}
      <p className="mt-4 text-xs leading-relaxed text-slate-500">{c.ownershipNote}</p>
      {address ? (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-1 gap-6 rounded-2xl bg-slate-900 p-5 text-white sm:grid-cols-[1fr_auto] sm:items-start sm:p-7">
            <div className="min-w-0">
              <p className="inline-flex max-w-full items-center rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-slate-200">
                <span className="truncate">{address.slice(0, 6)}…{address.slice(-4)}</span>
              </p>
              <div role="status" className="mt-4 text-sm text-slate-300">
                {balance.isError ? c.balanceError : balance.data === undefined ? c.balanceLoading : (
                  <>
                    <p className="break-all text-5xl font-light tracking-tight text-white sm:text-6xl">
                      {formatUnits(balance.data, deployment.decimals)}
                      <span className="ml-2 text-base font-normal text-slate-400">JPYC</span>
                    </p>
                    <p className="mt-2 text-xs text-slate-400">{balance.data > 0n ? c.hasBalance : c.noBalance}</p>
                  </>
                )}
              </div>
              <p className="mt-2 text-xs text-slate-400">{c.balanceLabel} · {chainNameForId(deployment.chainId)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href="#agent-connect" className="rounded-xl border border-white/30 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10">{c.connectCta}</a>
              <a href="#agent-fund" className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-slate-900 transition hover:bg-slate-100">{c.fundCta}</a>
            </div>
          </div>
          <div id="agent-fund" className="grid scroll-mt-24 grid-cols-1 gap-6 sm:grid-cols-[1fr_auto]">
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900">{c.fundTitle}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.fundBody}</p>
              <p className="mt-3 select-all break-all font-mono text-sm">{address}</p>
              {available ? <button type="button" className="mt-3 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white" onClick={async () => { if (await copy(address)) setCopiedAddress(address); }}>{copied && copiedAddress === address ? c.copied : c.copyAddress}</button> : null}
            </div>
            {/* QR は直前のアドレス行と同じ情報なので a11y ツリーからは外す (掟 8: 可視テキストなしの名前を付けない)。 */}
            <div aria-hidden className="h-fit w-fit rounded-xl bg-white p-3 ring-1 ring-slate-200/70"><QRCodeSVG value={address} size={160} /></div>
            <div className="min-w-0 sm:col-span-2">
              <AgentFundFromWallet locale={locale} c={c.fundFromWallet} agentAddress={address} onSent={() => { void balance.refetch(); }} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
