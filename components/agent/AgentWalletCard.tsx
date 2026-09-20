'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useAccount, useReadContract } from 'wagmi';
import { erc20Abi, formatUnits, isAddress } from 'viem';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { chainNameForId } from '@/lib/chains';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });

export function AgentWalletCard({ c }: { c: AgentPageContent['wallet'] }) {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const params = useSearchParams();
  const [input, setInput] = useState(() => {
    const initial = params.get('address');
    return initial && isAddress(initial) ? initial : '';
  });
  const { address: connectedAddress, isConnected } = useAccount();
  const { copy, copied, available } = useCopyToClipboard();
  const value = input.trim();
  const address = isAddress(value) ? value : undefined;
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
        <div className="mt-5 grid grid-cols-1 gap-6 rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200/70 sm:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">{c.balanceLabel} · {chainNameForId(deployment.chainId)}</p>
            <div role="status" className="mt-2 text-sm text-slate-700">
              {balance.isError ? c.balanceError : balance.data === undefined ? c.balanceLoading : (
                <>
                  <p className="break-all text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
                    {formatUnits(balance.data, deployment.decimals)}
                    <span className="ml-2 text-base font-medium text-slate-500">JPYC</span>
                  </p>
                  <p className="mt-2 text-xs text-slate-500">{balance.data > 0n ? c.hasBalance : c.noBalance}</p>
                </>
              )}
            </div>
            <h3 className="mt-6 font-bold text-slate-900">{c.fundTitle}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.fundBody}</p>
            <p className="mt-3 select-all break-all font-mono text-sm">{address}</p>
            {available ? <button type="button" className="mt-3 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white" onClick={async () => { if (await copy(address)) setCopiedAddress(address); }}>{copied && copiedAddress === address ? c.copied : c.copyAddress}</button> : null}
          </div>
          {/* QR は直前のアドレス行と同じ情報なので a11y ツリーからは外す (掟 8: 可視テキストなしの名前を付けない)。 */}
          <div aria-hidden className="h-fit w-fit rounded-xl bg-white p-3 ring-1 ring-slate-200/70"><QRCodeSVG value={address} size={160} /></div>
        </div>
      ) : null}
    </section>
  );
}
