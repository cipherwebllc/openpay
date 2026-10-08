'use client';

// 「接続中のウォレットから補充」: 右上で接続したお店のウォレットから、この端末のガス用ウォレットへガス代のトークン
// (POL・KAIA・AVAX) を送る。送るのはお店のウォレット (wagmi) で、ガス用ウォレットの鍵は使わない。
// 1 回で送れるのは入れておく目安の上限まで (開示どおり「少額だけ入れる」・もっと入れたいときは繰り返す)。

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { parseEther, type Address, type Hex } from 'viem';
import {
  useAccount,
  useBalance,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { nativeSymbolForChainId, txExplorerUrl } from '@/lib/chains';
import { storeGasFundRange } from '@/lib/storeGasWallet';
import { isUserRejection } from '@/lib/walletErrors';
import type { StoreGasChainState } from '@/hooks/useStoreGasWallet';

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50';

const AMOUNT_ID = 'store-gas-topup-amount';
const CHAIN_ID = 'store-gas-topup-chain';
// 10 進の数 (18 桁まで)。
const DECIMAL = /^\d+(\.\d{1,18})?$/;

type AmountCheck = { ok: true; wei: bigint } | { ok: false; reason: 'invalid' | 'too_much' };

function checkAmount(raw: string, max: string): AmountCheck {
  const v = raw.trim();
  if (!DECIMAL.test(v)) return { ok: false, reason: 'invalid' };
  const wei = parseEther(v);
  if (wei <= 0n) return { ok: false, reason: 'invalid' };
  if (wei > parseEther(max)) return { ok: false, reason: 'too_much' };
  return { ok: true, wei };
}

export function StoreGasWalletTopUp({
  chains,
  gasAddress,
  onDone,
}: {
  /** 新しい会計に使えるチェーン (補充先の候補)。 */
  chains: readonly StoreGasChainState[];
  gasAddress: Address;
  /** 補充が確定したら呼ぶ (残高の読み直し)。 */
  onDone: () => void;
}) {
  const t = useTranslations('RegisterMode.storeGasWallet');
  const [chainId, setChainId] = useState<number | null>(null);
  const target = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const range = target ? storeGasFundRange(target.chainId) : null;
  const [amount, setAmount] = useState('');
  // 送った tx のチェーン (確定待ちは送ったチェーンで見る・あとで選び直しても混ぜない)。
  const [sentChainId, setSentChainId] = useState<number | null>(null);

  const { address: wallet, isConnected, chainId: walletChainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance({ address: wallet, chainId: target?.chainId });
  const { sendTransaction, data: txHash, isPending: isSending, error: sendError, reset } = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId: sentChainId ?? undefined });

  // チェーンを選び直したら、そのチェーンの目安の下限を既定額にする。
  const targetId = target?.chainId;
  const rangeMin = range?.min;
  useEffect(() => {
    if (rangeMin) setAmount(rangeMin);
  }, [targetId, rangeMin]);

  // 確定したら 1 回だけ残高を読み直す。
  const doneRef = useRef<Hex | null>(null);
  const confirmed = receipt.isSuccess && receipt.data?.status === 'success';
  const reverted = receipt.data?.status === 'reverted';
  useEffect(() => {
    if (!confirmed || !txHash || doneRef.current === txHash) return;
    doneRef.current = txHash;
    onDone();
  }, [confirmed, txHash, onDone]);

  if (!target || !range) return null;
  const symbol = nativeSymbolForChainId(target.chainId) ?? '';
  const check = checkAmount(amount, range.max);
  const wrongChain = isConnected && walletChainId !== target.chainId;
  const sameAddress = !!wallet && wallet.toLowerCase() === gasAddress.toLowerCase();
  const insufficient = check.ok && balance !== undefined && check.wei > balance.value;
  const mining = !!txHash && receipt.isLoading;
  const canSend =
    isConnected && !wrongChain && !sameAddress && check.ok && !insufficient && !isSending && !mining;

  function onSend() {
    if (!canSend || !check.ok || !target) return;
    setSentChainId(target.chainId);
    sendTransaction({ to: gasAddress, value: check.wei, chainId: target.chainId });
  }

  const error = !check.ok
    ? amount.trim() === ''
      ? null
      : check.reason === 'too_much'
        ? t('topUpError.too_much', { max: range.max, symbol })
        : t('topUpError.invalid')
    : insufficient
      ? t('topUpError.insufficient', { symbol })
      : sendError && !isUserRejection(sendError)
        ? t('topUpError.failed')
        : null;

  return (
    <div className="border-t border-slate-100 pt-3">
      <p className="text-xs font-semibold text-slate-700">{t('topUpTitle')}</p>
      {!isConnected ? (
        <p className="mt-1 text-xs text-slate-500">{t('topUpConnectHint')}</p>
      ) : (
        <div className="mt-1 space-y-2 text-xs">
          {chains.length > 1 && (
            <div>
              <label htmlFor={CHAIN_ID} className="mr-2 text-slate-600">
                {t('topUpChainLabel')}
              </label>
              <select
                id={CHAIN_ID}
                value={target.chainId}
                onChange={(e) => {
                  setChainId(Number(e.target.value));
                  reset();
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                {chains.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.chain.name} ({nativeSymbolForChainId(c.chainId) ?? ''})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={AMOUNT_ID} className="text-slate-600">
              {t('topUpAmountLabel', { symbol })}
            </label>
            <input
              id={AMOUNT_ID}
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoComplete="off"
              aria-invalid={!!error}
              className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs focus:border-brand focus:outline-none"
            />
            <p className="mt-1 text-slate-500">{t('topUpRange', { min: range.min, max: range.max, symbol })}</p>
          </div>
          {wrongChain ? (
            <button
              type="button"
              className={BTN}
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: target.chainId })}
            >
              {t('topUpSwitch', { chain: target.chain.name })}
            </button>
          ) : (
            <button type="button" className={BTN} disabled={!canSend} onClick={onSend}>
              {t('topUpSend', { amount: check.ok ? amount.trim() : '—', symbol })}
            </button>
          )}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          {isSending && (
            <p role="status" className="text-slate-600">
              {t('topUpConfirmInWallet')}
            </p>
          )}
          {mining && (
            <p role="status" className="text-slate-600">
              {t('topUpMining')}
            </p>
          )}
          {txHash && sentChainId !== null && (confirmed || reverted) && (
            <p role={confirmed ? 'status' : 'alert'} className={confirmed ? 'text-emerald-700' : 'text-red-600'}>
              {confirmed ? t('topUpDone') : t('topUpReverted')}{' '}
              <a
                href={txExplorerUrl(sentChainId, txHash)}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                {t('viewTx')}
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
