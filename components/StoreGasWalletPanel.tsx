'use client';

// レジの「お店の端末のガス用ウォレット」(flag NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET・plans/store-gas-wallet.md P1)。
// 作る・残高を見る・残りの POL を戻す・この端末から消す。鍵は表示も書き出しもしない (戻すのは送金で)。

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEther, type Address, type Hex } from 'viem';
import { txExplorerUrl } from '@/lib/chains';
import { estimateRemainingSends } from '@/lib/storeGasWallet';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import { useStoreGasWallet } from '@/hooks/useStoreGasWallet';

// 残り回数がこれを下回ったら補充を促す。
const LOW_REMAINING_SENDS = 20;

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_BTN =
  'rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50';

const WITHDRAW_INPUT_ID = 'store-gas-withdraw-to';
const WITHDRAW_MESSAGE_ID = 'store-gas-withdraw-message';

function formatPol(wei: bigint): string {
  const n = Number(formatEther(wei));
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** レジの「お店の端末で送る」の切替 (P2b-2・任意)。blocked = この端末・設定で使えない理由。 */
export type StoreDeviceToggle = {
  on: boolean;
  onToggle: (on: boolean) => void;
  blocked: 'no_locks' | 'config' | null;
  /** QR を出している・支払いを送っている・結果を待っている間は切り替えさせない。 */
  locked?: boolean;
};

export function StoreGasWalletPanel({
  storeDevice,
  onAddressChange,
}: {
  storeDevice?: StoreDeviceToggle;
  /** 使えるガス用ウォレットのアドレス (無い・読めないは null) をレジに知らせる。 */
  onAddressChange?: (address: Address | null) => void;
} = {}) {
  const t = useTranslations('RegisterMode');
  const g = useStoreGasWallet();
  const usableAddress = g.walletState?.state === 'ok' ? g.address : null;
  useEffect(() => {
    onAddressChange?.(usableAddress);
  }, [onAddressChange, usableAddress]);
  const { copy, copied, available } = useCopyToClipboard();
  const copyAvailable = useHydrationSafeAvailable(available);
  const [createError, setCreateError] = useState<string | null>(null);
  const [withdrawTo, setWithdrawTo] = useState('');
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);

  if (!g.hydrated || !g.walletState) return null;

  const remaining =
    g.balance != null && g.gasPrice != null ? estimateRemainingSends(g.balance, g.gasPrice) : null;
  const ws = g.withdrawStatus;
  const withdrawing = ws.phase === 'sending' || ws.phase === 'pending';
  const inputRejected =
    ws.phase === 'rejected' &&
    (ws.reason === 'invalid_address' ||
      ws.reason === 'zero_address' ||
      ws.reason === 'same_address' ||
      ws.reason === 'contract_recipient');

  async function handleCreate() {
    const r = await g.create();
    setCreateError(r.ok ? null : r.reason);
  }

  async function handleRemove() {
    const ok = await g.remove();
    setRemoveFailed(!ok);
    if (ok) setConfirmingRemove(false);
  }

  const txLink = (hash: Hex) => (
    <a
      href={txExplorerUrl(g.chain.id, hash)}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2"
    >
      {t('storeGasWallet.viewTx')}
    </a>
  );

  const removeSection = (
    <div className="border-t border-slate-100 pt-3">
      {!confirmingRemove ? (
        <button
          type="button"
          className={DANGER_BTN}
          disabled={g.removeBlocked}
          onClick={() => {
            setConfirmingRemove(true);
            setRemoveFailed(false);
          }}
        >
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
              disabled={g.removeBlocked}
              onClick={() => void handleRemove()}
            >
              {t('storeGasWallet.removeYes')}
            </button>
            <button type="button" className={BTN} onClick={() => setConfirmingRemove(false)}>
              {t('storeGasWallet.cancel')}
            </button>
          </div>
        </div>
      )}
      {g.removeBlocked && (
        <p className="mt-1 text-xs text-slate-500">{t('storeGasWallet.removeBlockedNote')}</p>
      )}
      {removeFailed && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {t('storeGasWallet.removeFailed')}
        </p>
      )}
    </div>
  );

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
      <summary className="cursor-pointer font-semibold text-slate-800">
        {t('storeGasWallet.title')}
        <span className="ml-2 text-xs font-normal text-slate-500">
          {g.walletState.state === 'ok'
            ? g.balance != null
              ? t('storeGasWallet.balanceValue', { amount: formatPol(g.balance) })
              : ''
            : g.walletState.state === 'none'
              ? t('storeGasWallet.badgeNone')
              : ''}
        </span>
      </summary>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">{t('storeGasWallet.intro')}</p>
      <p className="mt-2 text-xs leading-relaxed text-amber-800">{t('storeGasWallet.keyNote')}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('storeGasWallet.safariNote')}</p>

      {g.walletState.state === 'unavailable' && (
        <p role="alert" className="mt-3 text-xs text-red-600">
          {t('storeGasWallet.createFailedStorage')}
        </p>
      )}

      {g.walletState.state === 'corrupt' && (
        <div className="mt-3 space-y-3">
          <p role="alert" className="text-xs text-red-700">
            {t('storeGasWallet.corruptNote')}
          </p>
          {removeSection}
        </div>
      )}

      {g.walletState.state === 'none' && (
        <div className="mt-3">
          <button type="button" className={BTN} onClick={() => void handleCreate()}>
            {t('storeGasWallet.createButton')}
          </button>
          {createError && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {createError === 'corrupt'
                ? t('storeGasWallet.corruptNote')
                : t('storeGasWallet.createFailedStorage')}
            </p>
          )}
        </div>
      )}

      {g.walletState.state === 'ok' && g.address && (
        <div className="mt-3 space-y-3">
          {storeDevice && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="flex items-start gap-2 text-xs font-semibold text-slate-800">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={storeDevice.on}
                  disabled={storeDevice.blocked !== null || !!storeDevice.locked}
                  onChange={(e) => storeDevice.onToggle(e.target.checked)}
                />
                <span>{t('storeDevice.toggle')}</span>
              </label>
              <p className="mt-1 text-xs text-slate-500">
                {t('storeDevice.toggleNote', { chain: g.chain.name })}
              </p>
              {storeDevice.blocked && (
                <p role="alert" className="mt-1 text-xs text-amber-800">
                  {t(`storeDevice.blocked.${storeDevice.blocked}`)}
                </p>
              )}
            </div>
          )}
          <div>
            <p className="text-xs text-slate-500">
              {t('storeGasWallet.addressLabel', { chain: g.chain.name })}
            </p>
            <p className="break-all font-mono text-xs text-slate-800">{g.address}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {copyAvailable && (
                <button type="button" className={BTN} onClick={() => copy(g.address!)}>
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
            <label htmlFor={WITHDRAW_INPUT_ID} className="text-xs font-semibold text-slate-700">
              {t('storeGasWallet.withdrawTitle')}
            </label>
            <p className="text-xs text-slate-500">{t('storeGasWallet.withdrawToHint')}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                id={WITHDRAW_INPUT_ID}
                type="text"
                value={withdrawTo}
                onChange={(e) => {
                  setWithdrawTo(e.target.value);
                  setConfirmingWithdraw(false);
                }}
                placeholder="0x..."
                autoComplete="off"
                spellCheck={false}
                aria-invalid={inputRejected}
                aria-describedby={inputRejected ? WITHDRAW_MESSAGE_ID : undefined}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs focus:border-brand focus:outline-none"
              />
              {!confirmingWithdraw && (
                <button
                  type="button"
                  className={BTN}
                  disabled={!withdrawTo.trim() || withdrawing}
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
                  <button
                    type="button"
                    className={BTN}
                    disabled={withdrawing}
                    onClick={() => {
                      setConfirmingWithdraw(false);
                      void g.withdraw(withdrawTo);
                    }}
                  >
                    {t('storeGasWallet.withdrawSend')}
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmingWithdraw(false)}>
                    {t('storeGasWallet.cancel')}
                  </button>
                </div>
              </div>
            )}
            <div id={WITHDRAW_MESSAGE_ID} className="mt-2 text-xs">
              {(ws.phase === 'sending' || ws.phase === 'pending') && (
                <p role="status" className="text-slate-600">
                  {t('storeGasWallet.withdrawPending')}{' '}
                  {ws.phase === 'pending' && txLink(ws.hash)}
                </p>
              )}
              {ws.phase === 'confirmed' && (
                <p role="status" className="text-emerald-700">
                  {t('storeGasWallet.withdrawDone')} {txLink(ws.hash)}
                </p>
              )}
              {ws.phase === 'reverted' && (
                <p role="alert" className="text-red-600">
                  {t('storeGasWallet.withdrawReverted')} {txLink(ws.hash)}
                </p>
              )}
              {ws.phase === 'unknown' && (
                <p role="alert" className="text-amber-700">
                  {t('storeGasWallet.withdrawUnknown')} {ws.hash && txLink(ws.hash)}
                </p>
              )}
              {ws.phase === 'rejected' && (
                <p role="alert" className="text-red-600">
                  {t(`storeGasWallet.withdrawError.${ws.reason}`)}
                </p>
              )}
            </div>
          </div>

          {removeSection}
        </div>
      )}
    </details>
  );
}
