'use client';

// レジの「お店の端末のガス用ウォレット」(flag NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET・plans/store-gas-wallet.md P1)。
// 作る・チェーンごとの残高を見る・残りを戻す・この端末から消す。鍵は表示も書き出しもしない (戻すのは送金で)。
// 鍵 (アドレス) は 1 つで、対象のチェーン (Polygon・Kaia・Avalanche のうち使えるもの) すべてで使う。使えないチェーンも、
// 残高があれば見せて戻せるようにする (開示や設定から外したチェーンに残ったガス代を見失わない)。

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEther, type Address, type Hex } from 'viem';
import { nativeSymbolForChainId, txExplorerUrl } from '@/lib/chains';
import { estimateRemainingSends, storeGasFundGuide } from '@/lib/storeGasWallet';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import { usePwaDisplayMode } from '@/hooks/usePwaDisplayMode';
import { useStoreGasWallet } from '@/hooks/useStoreGasWallet';
import { detectMobilePlatform } from '@/lib/walletDeepLink';
import { StoreGasWalletTopUp } from './StoreGasWalletTopUp';

// 残り回数がこれを下回ったら補充を促す。
const LOW_REMAINING_SENDS = 20;

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_BTN =
  'rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50';

const WITHDRAW_INPUT_ID = 'store-gas-withdraw-to';
const WITHDRAW_MESSAGE_ID = 'store-gas-withdraw-message';
const WITHDRAW_CHAIN_ID = 'store-gas-withdraw-chain';

function formatNative(wei: bigint): string {
  const n = Number(formatEther(wei));
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

const symbolOf = (chainId: number) => nativeSymbolForChainId(chainId) ?? '';

// iPhone・iPad (iPad の「モバイル用サイト」の UA も含む)。
function isIosDevice(): boolean {
  return detectMobilePlatform() === 'ios' || (typeof navigator !== 'undefined' && /iPad/.test(navigator.userAgent));
}

export function StoreGasWalletPanel({
  onAddressChange,
}: {
  /** 使えるガス用ウォレットのアドレス (無い・読めないは null) を知らせる (お店負担の決済モードで使う)。 */
  onAddressChange?: (address: Address | null) => void;
} = {}) {
  const t = useTranslations('RegisterMode');
  const tScan = useTranslations('Scan');
  const g = useStoreGasWallet();
  // iPhone・iPad のブラウザ (ホーム画面に追加したアプリでない) は、7 日ほど開かないとサイトのデータ (= 鍵) を消す。
  // ホーム画面のアプリはこの消去の対象外で保存場所も別なので、アプリで作るよう案内する (描画後に判定 = hydration 安全)。
  const { isStandalone } = usePwaDisplayMode();
  const [isIos, setIsIos] = useState(false);
  useEffect(() => {
    setIsIos(isIosDevice());
  }, []);
  const iosBrowser = isIos && !isStandalone;
  // iPhone・iPad のブラウザで「それでもブラウザで作る」を選んだ (作るボタンを出す)。
  const [createInBrowser, setCreateInBrowser] = useState(false);
  const usableAddress = g.walletState?.state === 'ok' ? g.address : null;
  useEffect(() => {
    // 読み込む前は知らせない (読み込み前の「無い」で、タブを戻ったときに送信中の支払いや「もう一度送る」を
    // 消さない = 作成ページでは前に知らせたアドレスのまま)。
    if (!g.hydrated) return;
    onAddressChange?.(usableAddress);
  }, [onAddressChange, usableAddress, g.hydrated]);
  const { copy, copied, available } = useCopyToClipboard();
  const copyAvailable = useHydrationSafeAvailable(available);
  const [createError, setCreateError] = useState<string | null>(null);
  const [withdrawTo, setWithdrawTo] = useState('');
  // 戻すチェーン (1 つだけのときは選ばせない)。
  const [withdrawChainId, setWithdrawChainId] = useState<number | null>(null);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);

  if (!g.hydrated || !g.walletState) return null;

  const active = g.chains.filter((c) => c.active);
  // 表示するチェーン = 使えるチェーンと、使えないが残高があるチェーン (前に読めた値を含む)。
  const funded = g.chains.filter((c) => c.balance != null && c.balance > 0n);
  // 一度も読めていないチェーン (残高が分からない)。消す前に知らせる (残っているかもしれない)。
  const unread = g.chains.some((c) => c.readFailed && c.balance == null);
  const shown = g.chains.filter((c) => c.active || funded.includes(c));
  const chainsLabel = active.map((c) => `${c.chain.name} (${symbolOf(c.chainId)})`).join('・');
  const fundGuide = active.map((c) => `${symbolOf(c.chainId)} ${storeGasFundGuide(c.chainId)}`).join('・');
  const amountsLabel = funded.map((c) => `${formatNative(c.balance!)} ${symbolOf(c.chainId)}`).join('・');
  const targetChainId =
    (withdrawChainId !== null && shown.some((c) => c.chainId === withdrawChainId) ? withdrawChainId : null) ??
    shown[0]?.chainId ??
    null;
  const ws = g.withdrawStatus;
  const withdrawing = ws.phase === 'sending' || ws.phase === 'pending';
  const inputRejected =
    ws.phase === 'rejected' &&
    (ws.reason === 'invalid_address' ||
      ws.reason === 'zero_address' ||
      ws.reason === 'same_address' ||
      ws.reason === 'contract_recipient');

  function refreshAfterTopUp() {
    void g.refresh();
  }

  async function handleCreate() {
    const r = await g.create();
    setCreateError(r.ok ? null : r.reason);
  }

  async function handleRemove() {
    const ok = await g.remove();
    setRemoveFailed(!ok);
    if (ok) setConfirmingRemove(false);
  }

  const txLink = (chainId: number, hash: Hex) => (
    <a
      href={txExplorerUrl(chainId, hash)}
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
            {funded.length > 0
              ? t('storeGasWallet.removeConfirmWithBalance', { amount: amountsLabel })
              : t('storeGasWallet.removeConfirm')}
            {unread && ` ${t('storeGasWallet.removeConfirmUnread')}`}
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
            ? shown
                // 読めていない間は前に読めた値を見出しに出さない (行には「読めませんでした」が出る)
                .filter((c) => c.balance != null && !c.readFailed)
                .map((c) => t('storeGasWallet.balanceValue', { amount: formatNative(c.balance!), symbol: symbolOf(c.chainId) }))
                .join('・')
            : g.walletState.state === 'none'
              ? t('storeGasWallet.badgeNone')
              : ''}
        </span>
      </summary>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        {t('storeGasWallet.intro', { chains: chainsLabel })}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-amber-800">
        {t('storeGasWallet.keyNote', { guide: fundGuide })}
      </p>
      {isIos ? (
        isStandalone && (
          <p className="mt-1 text-xs leading-relaxed text-emerald-700">{t('storeGasWallet.iosAppNote')}</p>
        )
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('storeGasWallet.safariNote')}</p>
      )}
      {g.persisted === true && !(isIos && isStandalone) && (
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('storeGasWallet.persistedNote')}</p>
      )}
      {iosBrowser && g.walletState.state === 'ok' && (
        <p role="note" className="mt-2 rounded-lg bg-amber-50 p-2 text-xs leading-relaxed text-amber-900">
          {t('storeGasWallet.iosBrowserKeptNote')}
        </p>
      )}

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
          {iosBrowser && (
            <div role="note" className="mb-3 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
              <p className="font-semibold">{t('storeGasWallet.iosBrowserTitle')}</p>
              <p className="mt-1">{t('storeGasWallet.iosBrowserBody')}</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>{tScan('installHintIosStep1')}</li>
                <li>{tScan('installHintIosStep2')}</li>
                <li>{t('storeGasWallet.iosBrowserStep3')}</li>
              </ol>
            </div>
          )}
          {iosBrowser && !createInBrowser ? (
            <button type="button" className={BTN} onClick={() => setCreateInBrowser(true)}>
              {t('storeGasWallet.iosBrowserCreateAnyway')}
            </button>
          ) : (
            <button type="button" className={BTN} onClick={() => void handleCreate()}>
              {t('storeGasWallet.createButton')}
            </button>
          )}
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
          <div>
            <p className="text-xs text-slate-500">
              {t('storeGasWallet.addressLabel', { chain: active.map((c) => c.chain.name).join('・') })}
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
              {t('storeGasWallet.fundHint', { chains: chainsLabel })}
            </p>
          </div>

          <div className="space-y-1 text-xs">
            {shown.map((c) => {
              const remaining =
                !c.readFailed && c.balance != null && c.gasPrice != null
                  ? estimateRemainingSends(c.balance, c.gasPrice)
                  : null;
              return (
                <div key={c.chainId}>
                  <span className="text-slate-500">
                    {t('storeGasWallet.balanceLabel')} ({c.chain.name}):{' '}
                  </span>
                  {c.readFailed ? (
                    <span className="text-amber-700">{t('storeGasWallet.balanceUnknown')}</span>
                  ) : c.balance != null ? (
                    <span className="font-mono">
                      {t('storeGasWallet.balanceValue', {
                        amount: formatNative(c.balance),
                        symbol: symbolOf(c.chainId),
                      })}
                    </span>
                  ) : (
                    <span className="text-slate-400">…</span>
                  )}
                  {remaining != null && (
                    <span className="ml-2 text-slate-500">
                      {t('storeGasWallet.remaining', { count: remaining })}
                    </span>
                  )}
                  {c.active && remaining != null && remaining < LOW_REMAINING_SENDS && (
                    <p className="mt-1 text-amber-700">
                      {t('storeGasWallet.lowBalance', { symbol: symbolOf(c.chainId) })}
                    </p>
                  )}
                  {!c.active && (
                    <p className="mt-1 text-slate-500">{t('storeGasWallet.inactiveNote')}</p>
                  )}
                </div>
              );
            })}
          </div>

          {active.length > 0 && (
            <StoreGasWalletTopUp chains={active} gasAddress={g.address} onDone={refreshAfterTopUp} />
          )}

          <div className="border-t border-slate-100 pt-3">
            <label htmlFor={WITHDRAW_INPUT_ID} className="text-xs font-semibold text-slate-700">
              {t('storeGasWallet.withdrawTitle')}
            </label>
            <p className="text-xs text-slate-500">{t('storeGasWallet.withdrawToHint')}</p>
            {shown.length > 1 && (
              <div className="mt-1">
                <label htmlFor={WITHDRAW_CHAIN_ID} className="mr-2 text-xs text-slate-600">
                  {t('storeGasWallet.withdrawChainLabel')}
                </label>
                <select
                  id={WITHDRAW_CHAIN_ID}
                  value={targetChainId ?? ''}
                  onChange={(e) => {
                    setWithdrawChainId(Number(e.target.value));
                    setConfirmingWithdraw(false);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                >
                  {shown.map((c) => (
                    <option key={c.chainId} value={c.chainId}>
                      {c.chain.name} ({symbolOf(c.chainId)})
                    </option>
                  ))}
                </select>
              </div>
            )}
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
                  disabled={!withdrawTo.trim() || withdrawing || targetChainId === null}
                  onClick={() => setConfirmingWithdraw(true)}
                >
                  {t('storeGasWallet.withdrawButton')}
                </button>
              )}
            </div>
            {confirmingWithdraw && (
              <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs">
                <p>
                  {t('storeGasWallet.withdrawConfirm', {
                    symbol: targetChainId !== null ? symbolOf(targetChainId) : '',
                    chain: g.chains.find((c) => c.chainId === targetChainId)?.chain.name ?? '',
                  })}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={BTN}
                    disabled={withdrawing || targetChainId === null}
                    onClick={() => {
                      setConfirmingWithdraw(false);
                      if (targetChainId !== null) void g.withdraw(targetChainId, withdrawTo);
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
                  {ws.phase === 'pending' && txLink(ws.chainId, ws.hash)}
                </p>
              )}
              {ws.phase === 'confirmed' && (
                <p role="status" className="text-emerald-700">
                  {t('storeGasWallet.withdrawDone')} {txLink(ws.chainId, ws.hash)}
                </p>
              )}
              {ws.phase === 'reverted' && (
                <p role="alert" className="text-red-600">
                  {t('storeGasWallet.withdrawReverted')} {txLink(ws.chainId, ws.hash)}
                </p>
              )}
              {ws.phase === 'unknown' && (
                <p role="alert" className="text-amber-700">
                  {t('storeGasWallet.withdrawUnknown')} {ws.hash && txLink(ws.chainId, ws.hash)}
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
