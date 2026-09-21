'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { erc20Abi, formatUnits, maxUint256, parseUnits, type Address, type Hash } from 'viem';
import type { AgentPageContent } from '@/lib/agentPage';
import { trackAgentEvent } from '@/lib/agentTrack';
import { chainNameForId, txExplorerUrl } from '@/lib/chains';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { isUserRejection } from '@/lib/walletErrors';

type Review = { sender: Address; recipient: Address; amount: bigint };

export function AgentFundFromWallet({ locale, c, agentAddress, onSent, onBusyChange }: {
  locale: string;
  c: AgentPageContent['wallet']['fundFromWallet'];
  agentAddress: Address;
  onSent: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const deployment = defaultDeploymentForSymbol('jpyc');
  const sameWallet = address?.toLowerCase() === agentAddress.toLowerCase();
  const balance = useReadContract({
    abi: erc20Abi,
    address: deployment.address,
    chainId: deployment.chainId,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: isConnected && Boolean(address) && !sameWallet },
  });
  const write = useWriteContract();
  const switcher = useSwitchChain();
  const [replacement, setReplacement] = useState<{ hash: Hash; invalid: boolean } | null>(null);
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    chainId: deployment.chainId,
    onReplaced: ({ reason, transactionReceipt }) => {
      // キャンセルや別取引への置換の成功 receipt を、元の送金の成功にしない。
      // ガス代だけを変更した speed-up (repriced) は同じ送金として追跡する。
      setReplacement((previous) => ({ hash: transactionReceipt.transactionHash, invalid: Boolean(previous?.invalid) || reason !== 'repriced' }));
    },
  });
  const [value, setValue] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const notifiedRef = useRef<string | null>(null);

  // parseUnits の丸めで入力額と送金額がずれないよう、精度超過を先に弾く。
  const validFormat = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && (value.split('.')[1]?.length ?? 0) <= deployment.decimals;
  const amount = validFormat ? parseUnits(value, deployment.decimals) : 0n;
  const validAmount = amount > 0n && amount <= maxUint256;
  const insufficient = validAmount && balance.data !== undefined && amount > balance.data;
  const amountError = value && !validAmount ? c.invalidAmount : insufficient ? c.insufficient : null;
  const wrongChain = chainId !== deployment.chainId;
  const waitingWallet = isSubmitting || write.isPending || switcher.isPending;
  const locked = waitingWallet || Boolean(write.data);
  const canReview = isConnected && Boolean(address) && !sameWallet && validAmount && balance.data !== undefined && !balance.isError && !insufficient && !locked;
  // 確認中に送り手や送り先が変わったら、改めて確認を求める。旧確認で別の送金をしない。
  const currentReview = review && review.sender.toLowerCase() === address?.toLowerCase() && review.recipient.toLowerCase() === agentAddress.toLowerCase() && review.amount === amount;
  const confirmed = Boolean(write.data) && !replacement?.invalid && receipt.isSuccess && receipt.data?.status === 'success';
  const failed = replacement?.invalid || receipt.isError || receipt.data?.status === 'reverted' || (!write.data && balance.isError);
  const walletError = write.error ?? switcher.error;
  const status = confirmed ? c.confirmed : walletError ? (isUserRejection(walletError) ? c.rejected : c.failed) : failed ? c.failed : write.data ? c.sent : waitingWallet ? c.waitingWallet : null;
  // 結果が確定した送金 (成功 / revert) の後だけ「戻る」で入力に戻れる。receipt を取れなかった (RPC エラー) 送金は
  // 成否が不明で、戻して再送させると二重送金になり得るので固定したままにする (explorer で確かめてもらう)。
  const settled = confirmed || receipt.data?.status === 'reverted';
  const inFlight = waitingWallet || (Boolean(write.data) && !settled);
  const txHash = replacement?.hash ?? write.data;
  const explorerUrl = txHash ? txExplorerUrl(deployment.chainId, txHash) : undefined;

  useEffect(() => {
    if (!confirmed || !write.data || notifiedRef.current === write.data) return;
    notifiedRef.current = write.data;
    trackAgentEvent('agent_fund_send', { locale });
    onSent();
  }, [confirmed, write.data, locale, onSent]);

  useEffect(() => {
    onBusyChange?.(inFlight);
  }, [inFlight, onBusyChange]);

  function openReview() {
    if (!canReview || !address) return;
    write.reset();
    switcher.reset();
    setReview({ sender: address, recipient: agentAddress, amount });
    if (wrongChain) switcher.switchChain({ chainId: deployment.chainId });
  }

  function send() {
    if (!canReview || !currentReview || !review || wrongChain || submittingRef.current) return;
    // React の再描画前に連続クリックされても、ウォレットへの依頼は 1 回に限定する。
    submittingRef.current = true;
    setIsSubmitting(true);
    write.writeContract({
      abi: erc20Abi,
      address: deployment.address,
      chainId: deployment.chainId,
      account: review.sender,
      functionName: 'transfer',
      args: [review.recipient, review.amount],
    }, {
      onSettled: () => {
        submittingRef.current = false;
        setIsSubmitting(false);
      },
    });
  }

  if (!isConnected || !address) return null;
  if (sameWallet) return <p className="text-sm text-slate-600">{c.sameWalletNote}</p>;

  return (
    <div className="min-w-0 rounded-xl border border-slate-200 p-4 sm:p-5">
      <h3 className="font-bold text-slate-900">{c.title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{c.gasNote}</p>
      {currentReview || (review && locked) ? (
        <div className="mt-4 min-w-0 space-y-3">
          <h4 className="font-bold text-slate-900">{c.confirmTitle}</h4>
          <dl className="space-y-2 text-sm">
            <div><dt className="text-slate-500">{c.toLabel}</dt><dd className="break-all font-mono">{review.recipient}</dd></div>
            <div><dt className="text-slate-500">{c.amountConfirmLabel}</dt><dd className="break-all">{formatUnits(review.amount, deployment.decimals)} JPYC</dd></div>
            <div><dt className="text-slate-500">{c.chainLabel}</dt><dd>{chainNameForId(deployment.chainId)}</dd></div>
          </dl>
          <p className="text-sm font-medium text-amber-900">{c.irreversible}</p>
          <p className="text-xs leading-relaxed text-slate-600">{c.ownershipWarning}</p>
          {amountError ? <p className="text-sm text-red-700">{amountError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="min-h-11 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={!canReview || !currentReview || wrongChain} onClick={send}>{c.confirmSend}</button>
            <button type="button" className="min-h-11 rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium disabled:opacity-50" disabled={inFlight} onClick={() => { if (settled) setValue(''); setReview(null); setReplacement(null); write.reset(); switcher.reset(); }}>{c.back}</button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <label htmlFor="agent-fund-amount" className="block text-sm font-medium">{c.amountLabel}</label>
          <input id="agent-fund-amount" type="text" inputMode="decimal" className="mt-2 block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2 text-sm" placeholder={c.amountPlaceholder} value={value} disabled={locked} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'agent-fund-amount-error' : undefined} onChange={(event) => setValue(event.target.value)} />
          {amountError ? <p id="agent-fund-amount-error" className="mt-2 text-sm text-red-700">{amountError}</p> : null}
          <button type="button" className="mt-3 min-h-11 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={!canReview} onClick={openReview}>{c.send}</button>
        </div>
      )}
      <div role="status" className="mt-3 break-all text-sm text-slate-700">
        {status ? <p>{status}</p> : null}
        {txHash ? (explorerUrl ? <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="underline">{c.viewTx}: {txHash}</a> : <p>{txHash}</p>) : null}
      </div>
    </div>
  );
}
