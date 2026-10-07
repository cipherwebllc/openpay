'use client';

// レジの「お店の端末のガス用ウォレット」(flag NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET・plans/store-gas-wallet.md P1)。
// 作る・残高を見る・残りの POL を戻す・この端末から消す。鍵は表示も書き出しもしない (戻すのは送金で)。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEther, type Hex } from 'viem';
import { txExplorerUrl } from '@/lib/chains';
import { estimateRemainingSends } from '@/lib/storeGasWallet';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import { useStoreGasWallet, type WithdrawResult } from '@/hooks/useStoreGasWallet';

// 残り回数がこれを下回ったら補充を促す。
const LOW_REMAINING_SENDS = 20;

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_BTN =
  'rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50';

function formatPol(wei: bigint): string {
  const n = Number(formatEther(wei));
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function StoreGasWalletPanel() {
  const t = useTranslations('RegisterMode');
  const g = useStoreGasWallet();
  const { copy, copied, available } = useCopyToClipboard();
  const copyAvailable = useHydrationSafeAvailable(available);
  const [createError, setCreateError] = useState(false);
  const [withdrawTo, setWithdrawTo] = useState('');
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<WithdrawResult | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  if (!g.hydrated) return null;

  const remaining =
    g.balance != null && g.gasPrice != null ? estimateRemainingSends(g.balance, g.gasPrice) : null;

  async function handleWithdraw() {
    setConfirmingWithdraw(false);
    setWithdrawResult(await g.withdraw(withdrawTo));
  }

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
      <summary className="cursor-pointer font-semibold text-slate-800">
        {t('storeGasWallet.title')}
        <span className="ml-2 text-xs font-normal text-slate-500">
          {g.wallet
            ? g.balance != null
              ? t('storeGasWallet.balanceValue', { amount: formatPol(g.balance) })
              : ''
            : t('storeGasWallet.badgeNone')}
        </span>
      </summary>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">{t('storeGasWallet.intro')}</p>
      <p className="mt-2 text-xs leading-relaxed text-amber-800">{t('storeGasWallet.keyNote')}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('storeGasWallet.safariNote')}</p>

      {!g.wallet ? (
        <div className="mt-3">
          <button
            type="button"
            className={BTN}
            onClick={() => setCreateError(!g.create().ok)}
          >
            {t('storeGasWallet.createButton')}
          </button>
          {createError && (
            <p className="mt-2 text-xs text-red-600">{t('storeGasWallet.createFailedStorage')}</p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-xs text-slate-500">
              {t('storeGasWallet.addressLabel', { chain: g.chain.name })}
            </p>
            <p className="break-all font-mono text-xs text-slate-800">{g.wallet.address}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {copyAvailable && (
                <button type="button" className={BTN} onClick={() => copy(g.wallet!.address)}>
                  {copied ? t('storeGasWallet.copied') : t('storeGasWallet.copy')}
                </button>
              )}
              <button type="button" className={BTN} onClick={() => void g.refresh()}>
                {t('storeGasWallet.refresh')}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {t('storeGasWallet.fundHint', { chain: g.chain.name })}
            </p>
          </div>

          <div className="text-xs">
            <span className="text-slate-500">{t('storeGasWallet.balanceLabel')}: </span>
            {g.readFailed ? (
              <span className="text-amber-700">{t('storeGasWallet.balanceUnknown')}</span>
            ) : g.balance != null ? (
              <span className="font-mono">
                {t('storeGasWallet.balanceValue', { amount: formatPol(g.balance) })}
              </span>
            ) : (
              <span className="text-slate-400">…</span>
            )}
            {remaining != null && (
              <span className="ml-2 text-slate-500">
                {t('storeGasWallet.remaining', { count: remaining })}
              </span>
            )}
            {remaining != null && remaining < LOW_REMAINING_SENDS && (
              <p className="mt-1 text-amber-700">{t('storeGasWallet.lowBalance')}</p>
            )}
          </div>

          <div className="border-t border-slate-100 pt-3">
            <p className="text-xs font-semibold text-slate-700">{t('storeGasWallet.withdrawTitle')}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                type="text"
                value={withdrawTo}
                onChange={(e) => {
                  setWithdrawTo(e.target.value);
                  setConfirmingWithdraw(false);
                  setWithdrawResult(null);
                }}
                placeholder={t('storeGasWallet.withdrawPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs focus:border-brand focus:outline-none"
              />
              {!confirmingWithdraw && (
                <button
                  type="button"
                  className={BTN}
                  disabled={!withdrawTo.trim() || g.busy}
                  onClick={() => setConfirmingWithdraw(true)}
                >
                  {t('storeGasWallet.withdrawButton')}
                </button>
              )}
            </div>
            {confirmingWithdraw && (
              <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs">
                <p>{t('storeGasWallet.withdrawConfirm')}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className={BTN} disabled={g.busy} onClick={() => void handleWithdraw()}>
                    {t('storeGasWallet.withdrawSend')}
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmingWithdraw(false)}>
                    {t('storeGasWallet.cancel')}
                  </button>
                </div>
              </div>
            )}
            {withdrawResult?.ok && (
              <p className="mt-2 text-xs text-emerald-700">
                {t('storeGasWallet.withdrawDone')}{' '}
                <a
                  href={txExplorerUrl(g.chain.id, withdrawResult.hash as Hex)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {t('storeGasWallet.viewTx')}
                </a>
              </p>
            )}
            {withdrawResult && !withdrawResult.ok && (
              <p className="mt-2 text-xs text-red-600">
                {t(`storeGasWallet.withdrawError.${withdrawResult.reason}`)}
              </p>
            )}
          </div>

          <div className="border-t border-slate-100 pt-3">
            {!confirmingRemove ? (
              <button type="button" className={DANGER_BTN} onClick={() => setConfirmingRemove(true)}>
                {t('storeGasWallet.removeButton')}
              </button>
            ) : (
              <div className="rounded-lg bg-red-50 p-2 text-xs text-red-800">
                <p>
                  {g.balance != null && g.balance > 0n
                    ? t('storeGasWallet.removeConfirmWithBalance', { amount: formatPol(g.balance) })
                    : t('storeGasWallet.removeConfirm')}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={DANGER_BTN}
                    onClick={() => {
                      g.remove();
                      setConfirmingRemove(false);
                      setWithdrawResult(null);
                    }}
                  >
                    {t('storeGasWallet.removeYes')}
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmingRemove(false)}>
                    {t('storeGasWallet.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </details>
  );
}
