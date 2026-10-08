'use client';

// 「接続中のウォレットから補充」: 右上で接続したお店のウォレットから、この端末のガス用ウォレットへガス代のトークン
// (POL・KAIA・AVAX) を送る。送るのはお店のウォレット (wagmi) で、ガス用ウォレットの鍵は使わない。
// 1 回で送れるのは入れておく目安の上限まで (開示どおり「少額だけ入れる」・もっと入れたいときは繰り返す)。
//
// 二重に送らない・届く途中の宛先を消さないための決まり:
//   - 送る直前に、保存されている鍵のアドレスが表示中の宛先と同じかを (鍵のロックの中で) 確かめ、補充の途中の印を置く
//     (別のタブで作り直された古いアドレスへ送らない・別のタブの「消す」は印を見て止まる)。
//   - 頼んでから結果 (確定・取り消し・置き換え) が出るまでは、次の送信・チェーンや額の変更をさせない。確定の確認が
//     失敗しても「途中」のまま (tx へのリンクと確かめ直すボタンを出す)。
//   - ウォレットで取り消し・別の取引に置き換えられたら「補充しました」と言わない。

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { parseEther, type Address, type Hex } from 'viem';
import { useAccount, useBalance, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi';
import { nativeSymbolForChainId, txExplorerUrl } from '@/lib/chains';
import {
  clearStoreGasTopUp,
  loadStoreGasWallet,
  markStoreGasTopUp,
  storeGasFundRange,
  withStoreGasWalletLock,
} from '@/lib/storeGasWallet';
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

type Phase =
  | { kind: 'idle' }
  // ウォレットで確認中 (まだ tx が無い)
  | { kind: 'approving'; chainId: number }
  // 送った・結果待ち (確定の確認が失敗しても、ここに留まる)
  | { kind: 'sent'; chainId: number; hash: Hex }
  | { kind: 'done'; chainId: number; hash: Hex; result: 'success' | 'reverted' | 'cancelled' | 'replaced' };

type LocalError = 'wallet_changed' | 'storage' | 'failed';

export function StoreGasWalletTopUp({
  chains,
  gasAddress,
  onDone,
  onPendingChange,
}: {
  /** 新しい会計に使えるチェーン (補充先の候補)。 */
  chains: readonly StoreGasChainState[];
  gasAddress: Address;
  /** 補充の結果が出たら呼ぶ (残高の読み直し)。 */
  onDone: () => void;
  /** 補充が途中 (ウォレットで確認中・結果待ち) かを知らせる (途中は鍵を消させない)。 */
  onPendingChange?: (pending: boolean) => void;
}) {
  const t = useTranslations('RegisterMode.storeGasWallet');
  const [chainId, setChainId] = useState<number | null>(null);
  const target = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const range = target ? storeGasFundRange(target.chainId) : null;
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [localError, setLocalError] = useState<LocalError | null>(null);
  // ウォレットでの置き換え (速くする・取り消す・別の取引)。確定の結果の見分けに使う。
  const replacedRef = useRef<{ reason: 'cancelled' | 'replaced' | 'repriced' } | null>(null);

  const { address: wallet, isConnected, chainId: walletChainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance({ address: wallet, chainId: target?.chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const sent = phase.kind === 'sent' ? phase : null;
  const receipt = useWaitForTransactionReceipt({
    hash: sent?.hash,
    chainId: sent?.chainId,
    onReplaced: (r) => {
      replacedRef.current = { reason: r.reason };
    },
  });

  const pending = phase.kind === 'approving' || phase.kind === 'sent';
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  // チェーンを選び直したら、そのチェーンの目安の下限を既定額にする。
  const targetId = target?.chainId;
  const rangeMin = range?.min;
  useEffect(() => {
    if (rangeMin) setAmount(rangeMin);
  }, [targetId, rangeMin]);

  // 結果が出たら印を外し、1 回だけ残高を読み直す。
  const receiptData = receipt.data;
  useEffect(() => {
    if (phase.kind !== 'sent' || !receiptData) return;
    const rep = replacedRef.current;
    const result =
      rep?.reason === 'cancelled'
        ? 'cancelled'
        : rep?.reason === 'replaced'
          ? 'replaced'
          : receiptData.status === 'success'
            ? 'success'
            : 'reverted';
    clearStoreGasTopUp(gasAddress);
    setPhase({ kind: 'done', chainId: phase.chainId, hash: receiptData.transactionHash, result });
    onDone();
  }, [phase, receiptData, gasAddress, onDone]);

  if (!target || !range) return null;
  const symbol = nativeSymbolForChainId(target.chainId) ?? '';
  const check = checkAmount(amount, range.max);
  const wrongChain = isConnected && walletChainId !== target.chainId;
  const sameAddress = !!wallet && wallet.toLowerCase() === gasAddress.toLowerCase();
  const insufficient = check.ok && balance !== undefined && check.wei > balance.value;
  const canSend = isConnected && !wrongChain && !sameAddress && check.ok && !insufficient && !pending;

  async function onSend() {
    if (!canSend || !check.ok || !target) return;
    const sendChainId = target.chainId;
    const value = check.wei;
    setLocalError(null);
    // 送る直前に、保存されている鍵が表示中の宛先と同じかを確かめ、補充の途中の印を置く (鍵のロックの中で)。
    const ready = await withStoreGasWalletLock(async (): Promise<'ok' | LocalError> => {
      const current = loadStoreGasWallet();
      if (current.state !== 'ok' || current.info.address.toLowerCase() !== gasAddress.toLowerCase()) {
        return 'wallet_changed';
      }
      return markStoreGasTopUp(gasAddress) ? 'ok' : 'storage';
    });
    if (ready !== 'ok') {
      setLocalError(ready);
      return;
    }
    replacedRef.current = null;
    setPhase({ kind: 'approving', chainId: sendChainId });
    let hash: Hex;
    try {
      hash = await sendTransactionAsync({ to: gasAddress, value, chainId: sendChainId });
    } catch (e) {
      // 送っていない (ウォレットで断った・送る前の失敗)。印を外して元に戻す。
      clearStoreGasTopUp(gasAddress);
      setPhase({ kind: 'idle' });
      if (!isUserRejection(e)) setLocalError('failed');
      return;
    }
    setPhase({ kind: 'sent', chainId: sendChainId, hash });
  }

  const inputError = !check.ok
    ? amount.trim() === ''
      ? null
      : check.reason === 'too_much'
        ? t('topUpError.too_much', { max: range.max, symbol })
        : t('topUpError.invalid')
    : insufficient && !pending
      ? t('topUpError.insufficient', { symbol })
      : null;
  const error = localError ? t(`topUpError.${localError}`) : inputError;

  const txLink = (chain: number, hash: Hex) => (
    <a href={txExplorerUrl(chain, hash)} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
      {t('viewTx')}
    </a>
  );

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
                disabled={pending}
                onChange={(e) => {
                  setChainId(Number(e.target.value));
                  setLocalError(null);
                  if (phase.kind === 'done') setPhase({ kind: 'idle' });
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
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
              disabled={pending}
              onChange={(e) => {
                setAmount(e.target.value);
                setLocalError(null);
              }}
              autoComplete="off"
              aria-invalid={!!inputError}
              className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs focus:border-brand focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1 text-slate-500">{t('topUpRange', { min: range.min, max: range.max, symbol })}</p>
          </div>
          {wrongChain && !pending ? (
            <button
              type="button"
              className={BTN}
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: target.chainId })}
            >
              {t('topUpSwitch', { chain: target.chain.name })}
            </button>
          ) : (
            <button type="button" className={BTN} disabled={!canSend} onClick={() => void onSend()}>
              {t('topUpSend', { amount: check.ok ? amount.trim() : '—', symbol })}
            </button>
          )}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          {phase.kind === 'approving' && (
            <p role="status" className="text-slate-600">
              {t('topUpConfirmInWallet')}
            </p>
          )}
          {phase.kind === 'sent' &&
            (receipt.isError ? (
              <div role="alert" className="text-amber-700">
                <p>
                  {t('topUpUnknown')} {txLink(phase.chainId, phase.hash)}
                </p>
                <button type="button" className={`${BTN} mt-1`} onClick={() => void receipt.refetch()}>
                  {t('topUpCheckAgain')}
                </button>
              </div>
            ) : (
              <p role="status" className="text-slate-600">
                {t('topUpMining')} {txLink(phase.chainId, phase.hash)}
              </p>
            ))}
          {phase.kind === 'done' && (
            <p
              role={phase.result === 'success' ? 'status' : 'alert'}
              className={phase.result === 'success' ? 'text-emerald-700' : 'text-red-600'}
            >
              {t(`topUpResult.${phase.result}`)} {txLink(phase.chainId, phase.hash)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
