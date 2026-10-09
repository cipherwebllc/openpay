'use client';

// レジの「お店の端末のガス用ウォレット」(flag NEXT_PUBLIC_ENABLE_STORE_GAS_WALLET・plans/store-gas-wallet.md P1)。
// 作る・チェーンごとの残高を見る・残りを戻す・この端末から消す。鍵は表示も書き出しもしない (戻すのは送金で)。
// 鍵 (アドレス) は 1 つで、対象のチェーン (Polygon・Kaia・Avalanche のうち使えるもの) すべてで使う。使えないチェーンも、
// 残高があれば見せて戻せるようにする (開示や設定から外したチェーンに残ったガス代を見失わない)。

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, Fuel, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { formatEther, type Address, type Hex } from 'viem';
import { nativeSymbolForChainId, txExplorerUrl } from '@/lib/chains';
import { estimateRemainingSends, storeGasFundGuide } from '@/lib/storeGasWallet';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import { usePwaDisplayMode } from '@/hooks/usePwaDisplayMode';
import { useStoreGasWallet } from '@/hooks/useStoreGasWallet';
import { detectMobilePlatform } from '@/lib/walletDeepLink';
import { StoreGasWalletTopUp } from './StoreGasWalletTopUp';
import { NativeTokenLogo } from './AssetLogo';

// 残り回数がこれを下回ったら補充を促す。
const LOW_REMAINING_SENDS = 20;

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50';
// 「作る」は、この枠でいちばん大事な一歩なので主ボタンの見た目にする。
const PRIMARY_BTN =
  'inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-transform hover:bg-brand-dark active:scale-[0.98]';
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

// Safari (Mac など)。Chrome・Brave・Edge・Firefox などは UA に Safari/ を含んでも除く。
function isSafariBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrome\/|Chromium|CriOS|FxiOS|Edg\/|OPR\/|Firefox\//.test(ua);
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
  const [isSafari, setIsSafari] = useState(false);
  useEffect(() => {
    setIsIos(isIosDevice());
    setIsSafari(isSafariBrowser());
  }, []);
  const iosBrowser = isIos && !isStandalone;
  // iPhone・iPad のブラウザで「それでもブラウザで作る」を選んだ (作るボタンを出す)。
  const [createInBrowser, setCreateInBrowser] = useState(false);
  // 接続中のウォレットからの補充が途中 (ウォレットで確認中・結果待ち)。途中は鍵を消させない (届く途中の宛先を消さない)。
  const [topUpPending, setTopUpPending] = useState(false);
  const removeBlocked = g.removeBlocked || topUpPending;
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
  const fundGuide = active.map((c) => `${symbolOf(c.chainId)} ${storeGasFundGuide(c.chainId)}`).join('・');
  const fundSymbols = active.map((c) => symbolOf(c.chainId)).join('・');
  // チェーンごとの「あと何回送れるか」と「少ないか」(見出しのチップと行で同じ値を使う)。
  const remainingOf = (c: (typeof g.chains)[number]) =>
    !c.readFailed && c.balance != null && c.gasPrice != null ? estimateRemainingSends(c.balance, c.gasPrice) : null;
  const isLow = (c: (typeof g.chains)[number]) => {
    const r = remainingOf(c);
    return c.active && r != null && r < LOW_REMAINING_SENDS;
  };
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
      ws.reason === 'contract_recipient' ||
      ws.reason === 'delegated_recipient');

  function refreshAfterTopUp() {
    void g.refresh();
  }

  async function handleCreate() {
    const r = await g.create();
    setCreateError(r.ok ? null : r.reason);
  }

  async function handleRemove() {
    // クリック時に見せていた「確かめられていない」補充の集合を渡す (ロック待ちの間に増えた・変わった記録は hook が止める)。
    const ok = await g.remove(g.staleTopUps);
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
          disabled={removeBlocked}
          onClick={() => {
            // 確認を開く時点で、結果を確かめられていない補充の記録を読み直す (古い state のまま警告を出し損ねない)。
            g.refreshStaleTopUps();
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
          {g.staleTopUps.length > 0 && (
            // 送って 1 日たっても結果を確かめられていない補充 (まだ入りうる)。消すのは止めないが、取引を見てから決められるようにする。
            <p className="mt-1">
              {t('storeGasWallet.removeConfirmTopUpUnresolved')}{' '}
              {g.staleTopUps.map((r) => (
                <span key={r.id}>{r.hash && txLink(r.chainId, r.hash)} </span>
              ))}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={DANGER_BTN}
              disabled={removeBlocked}
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
      {removeBlocked && (
        <p className="mt-1 text-xs text-slate-500">
          {topUpPending ? t('storeGasWallet.removeBlockedTopUpNote') : t('storeGasWallet.removeBlockedNote')}
        </p>
      )}
      {removeFailed && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {t('storeGasWallet.removeFailed')}
        </p>
      )}
    </div>
  );

  // 端末・ブラウザで違う「鍵が消える場面」の注意 (iPhone・iPad = 下の案内 / Safari = 7 日の消去 / それ以外 = 閉じるときの削除設定)。
  const deviceRisk = isIos
    ? iosBrowser && g.walletState.state === 'ok'
      ? t('storeGasWallet.iosBrowserKeptNote')
      : null
    : isSafari
      ? t('storeGasWallet.safariNote')
      : t('storeGasWallet.browserClearNote');

  return (
    // 見た目は会計画面の他の行 (明細・換金) と同じ折りたたみの行。見出しにチェーンごとの残高をトークンのマーク付きで出す。
    <details className="group/gas rounded-2xl bg-white p-4 text-sm text-slate-700 shadow-card ring-1 ring-slate-200/70">
      <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
        <Fuel className="mt-0.5 h-4 w-4 flex-none text-slate-400" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-slate-700">{t('storeGasWallet.title')}</span>
          {g.walletState.state === 'none' ? (
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
              {t('storeGasWallet.badgeNone')}
            </span>
          ) : null}
          {g.walletState.state === 'ok' ? (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {shown
                // 読めていない間は前に読めた値を見出しに出さない (行には「読めませんでした」が出る)
                .filter((c) => c.balance != null && !c.readFailed)
                .map((c) => (
                  <span
                    key={c.chainId}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ring-1 ${
                      isLow(c) ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-slate-50 text-slate-600 ring-slate-200'
                    }`}
                  >
                    <NativeTokenLogo chainId={c.chainId} size={12} />
                    {t('storeGasWallet.balanceValue', { amount: formatNative(c.balance!), symbol: symbolOf(c.chainId) })}
                  </span>
                ))}
            </span>
          ) : null}
        </span>
        <ChevronRight
          className="mt-0.5 h-4 w-4 flex-none text-slate-400 transition-transform group-open/gas:rotate-90"
          aria-hidden
        />
      </summary>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">{t('storeGasWallet.intro')}</p>

      {/* 鍵の扱いのリスク。いちばん大事なので、見出し + 箇条書きの囲みにして「戻せません」を強める。 */}
      <div role="note" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
        <p className="flex items-start gap-2 text-sm font-semibold text-amber-950">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-amber-600" aria-hidden />
          {t('storeGasWallet.keyTitle')}
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-6 text-xs leading-relaxed text-amber-950">
          <li>
            {t.rich('storeGasWallet.keyLose', {
              b: (chunks) => <strong className="font-bold text-red-700">{chunks}</strong>,
            })}
          </li>
          <li>{t('storeGasWallet.keyPrivate')}</li>
          <li>{t('storeGasWallet.keySmall', { guide: fundGuide })}</li>
          {deviceRisk ? <li>{deviceRisk}</li> : null}
        </ul>
      </div>
      {/* iPhone・iPad のアプリは 7 日の消去の対象外 (安心材料は囲みの外に、緑で短く)。 */}
      {isIos && isStandalone && (
        <p className="mt-2 text-xs leading-relaxed text-emerald-700">{t('storeGasWallet.iosAppNote')}</p>
      )}
      {/* iPhone・iPad では出さない (消されにくい保存が 7 日の消去を防ぐ根拠は無い = 偽の安心にしない) */}
      {g.persisted === true && !isIos && (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('storeGasWallet.persistedNote')}</p>
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
        <div className="mt-4">
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
            <button type="button" className={PRIMARY_BTN} onClick={() => void handleCreate()}>
              <Plus className="h-4 w-4" aria-hidden />
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
        <div className="mt-4 space-y-4">
          {/* 残高: チェーンごとに、トークンのマーク・残高 (太字)・あと何回送れるか。少ないチェーンにだけ印。 */}
          <section aria-labelledby="store-gas-balance-heading">
            <div className="flex items-center justify-between gap-2">
              <h3 id="store-gas-balance-heading" className="text-sm font-semibold text-slate-800">
                {t('storeGasWallet.balanceLabel')}
              </h3>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand"
                onClick={() => void g.refresh()}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                {t('storeGasWallet.refresh')}
              </button>
            </div>
            <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
              {shown.map((c) => {
                const remaining = remainingOf(c);
                // まだ入れていない (残高 0) は「残りわずか」ではなく「未入金」。回数 (あと約 0 回) も出さない。
                const empty = !c.readFailed && c.balance === 0n;
                return (
                  <li key={c.chainId} className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <NativeTokenLogo chainId={c.chainId} size={24} />
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{c.chain.name}</p>
                      {c.readFailed ? (
                        <p className="shrink-0 text-xs font-medium text-amber-700">{t('storeGasWallet.balanceUnknown')}</p>
                      ) : c.balance != null ? (
                        <p className="shrink-0 font-mono text-sm font-semibold text-slate-900">
                          {t('storeGasWallet.balanceValue', {
                            amount: formatNative(c.balance),
                            symbol: symbolOf(c.chainId),
                          })}
                        </p>
                      ) : (
                        <p className="shrink-0 text-slate-400">…</p>
                      )}
                    </div>
                    {/* 2 行目 (マークの下にそろえる): あと何回送れるか・少ない/未入金の印・使えないチェーンの注記 */}
                    {(remaining != null && !empty) || isLow(c) || !c.active ? (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-9">
                        {remaining != null && !empty && (
                          <p className="text-xs text-slate-500">{t('storeGasWallet.remaining', { count: remaining })}</p>
                        )}
                        {isLow(c) && (
                          <p className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                            <AlertTriangle className="h-3 w-3" aria-hidden />
                            {empty
                              ? t('storeGasWallet.emptyBalance', { symbol: symbolOf(c.chainId) })
                              : t('storeGasWallet.lowBalance', { symbol: symbolOf(c.chainId) })}
                          </p>
                        )}
                        {!c.active && (
                          <p className="text-xs text-slate-500">{t('storeGasWallet.inactiveNote')}</p>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* 入れるためのアドレス (どのチェーンも同じ)。 */}
          <section aria-labelledby="store-gas-address-heading">
            <h3 id="store-gas-address-heading" className="text-sm font-semibold text-slate-800">
              {t('storeGasWallet.addressLabel')}
            </h3>
            <p className="mt-1.5 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 ring-1 ring-slate-200">
              {g.address}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              {copyAvailable && (
                <button type="button" className={BTN} onClick={() => copy(g.address!)}>
                  {copied ? t('storeGasWallet.copied') : t('storeGasWallet.copy')}
                </button>
              )}
              <p className="text-xs text-slate-500">{t('storeGasWallet.fundHint', { symbols: fundSymbols })}</p>
            </div>
          </section>

          {active.length > 0 && (
            <StoreGasWalletTopUp
              chains={active}
              gasAddress={g.address}
              onDone={refreshAfterTopUp}
              onPendingChange={setTopUpPending}
            />
          )}

          <div className="border-t border-slate-100 pt-3">
            <label htmlFor={WITHDRAW_INPUT_ID} className="text-sm font-semibold text-slate-800">
              {t('storeGasWallet.withdrawTitle')}
            </label>
            <p className="text-xs text-slate-500">{t('storeGasWallet.withdrawToHint')}</p>
            {shown.length > 1 && (
              <div className="mt-1 flex items-center gap-2">
                <label htmlFor={WITHDRAW_CHAIN_ID} className="text-xs text-slate-600">
                  {t('storeGasWallet.withdrawChainLabel')}
                </label>
                {targetChainId !== null && <NativeTokenLogo chainId={targetChainId} size={16} />}
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
