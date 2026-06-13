'use client';

// 期限付き利用権 (OpenPay Pro / CSV 24時間パス) の購入パネルの**共有スケルトン**。両 tier の paywall
// (ProPaywall / CsvPassPaywall) は wagmi/SIWE/deployment 解決と自 tier の subscribe hook 呼出だけを担い、
// 描画はすべて本コンポーネントへ委譲する (外枠カード・ヘッダ・FEE_RECEIVER 未設定ガード・接続/不一致/
// SIWE サインイン・支払い前確認 <ul>・switchChain・成功/付与・subscribe 再検証・確認→支払いフロー・
// payError・フッター note)。差分は config prop で注入する。設計: plans/pro-plan.md / csv-pass.md。
//
// CSV パスのみ持つ**ガスレス relay サブフロー** (supportsGasless=true) は本体に内包する: relay 503 後の
// ガスあり fallback (別途同意 gasPaidFallbackConfirmed)・pending(hash 無し) の retryRelay・payCtaGasless /
// noteGasless の出し分け。Pro (supportsGasless=false) はガスレス分岐を一切描画せず従来のガスあり挙動を
// 完全維持する (sub.gasless 等の gasless フィールドは undefined のままで分岐が all-false に畳まれる)。
//
// 確認ステートマシン (confirmed / gasPaidFallbackConfirmed) は本コンポーネントが所有する。

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount, useSwitchChain } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';
import { env } from '@/lib/env';
import { defaultDeploymentForSymbol, resolveDeployment } from '@/lib/tokens';

// next-intl の翻訳引数 (price/days/hours/chain/reason/date)。tier ごとの i18n 値を config から差し込む。
type MessageValues = Record<string, string | number>;

// subscribe hook (useProSubscribe / useCsvPassSubscribe・どちらも useJpycEntitlementPay の wrapper) の
// 返り値の **superset**。ガスレス系フィールド (gasless / gaslessUnavailable / canRetryRelay /
// retryRelay / startGasPaid) は Pro hook には無いので optional。supportsGasless=false の paywall は
// これらを参照せず、undefined のまま安全に畳む。
export type EntitlementSubscription = {
  /** 既定の送金開始 (ガスレス可ならガスレス、不可ならガスあり)。 */
  start: () => void;
  /** subscribe (検証+付与) のみ再試行 (再送金しない)。 */
  retrySubscribe: () => void;
  isPaying: boolean;
  isSubscribing: boolean;
  isSuccess: boolean;
  isPayError: boolean;
  isSubscribeError: boolean;
  /** 付与確定後の失効時刻 (ms)。未確定は null。 */
  expiresAt: number | null;
  error: Error | null;
  // --- ガスレス relay サブフロー (CSV パスのみ・Pro は undefined) ---
  /** ガスレス可 (relay 構成 + 対応 chain + FEE_RECEIVER 設定)。 */
  gasless?: boolean;
  /** relay 未構成 (503) を検知。UI はガスあり fallback を提示する。 */
  gaslessUnavailable?: boolean;
  /** pending(hash 無し) の同一 payload 再 POST が可能か。 */
  canRetryRelay?: boolean;
  /** pending(hash 無し) の relay 再試行 (同一署名を再送信・再署名しない)。 */
  retryRelay?: () => void;
  /** ガスあり送金開始 (relay 503 fallback)。 */
  startGasPaid?: () => void;
};

export type EntitlementPaywallConfig = {
  /** useTranslations に渡す namespace ('Pro' | 'CsvPass')。両 tier の文言を切り替える。 */
  namespace: 'Pro' | 'CsvPass';
  /** ガスレス relay サブフローを描画するか。true=CSV パス / false=Pro (ガスありのみ・従来挙動)。 */
  supportsGasless: boolean;
  /** ヘッダ価格 t('price', priceValues) の引数 (Pro: {price,days} / CsvPass: {price,hours})。 */
  priceValues: MessageValues;
  /** reviewCta / payCta / payCtaGasless に渡す引数 (両 tier とも {price})。 */
  ctaValues: MessageValues;
  /** 支払い前確認 <ul> の項目列。key=i18n キー、values=引数 (省略可)。gas 行は gasless 出し分けを
   *  config 側で組み立てず、`gasLineKey` で別途指定する (本体が gaslessMode で confirmGasGasless と
   *  切り替える)。confirm 系項目をここに順序どおり列挙する。 */
  confirmItems: ReadonlyArray<{ key: string; values?: MessageValues }>;
  /** ガス行の i18n キー (gasless 不可時・通常)。supportsGasless=true のとき gaslessMode では
   *  代わりに gaslessGasLineKey を使う。Pro/CsvPass とも通常は 'confirmGas'。 */
  gasLineKey: string;
  /** gaslessMode 時のガス行 i18n キー (CSV パス: 'confirmGasGasless')。supportsGasless=true のみ使用。 */
  gaslessGasLineKey?: string;
  /** 失効時刻 (ms) → 表示文字列。Pro=日付のみ / CsvPass=日付+時刻。granted の {date} に使う。 */
  formatExpiry: (ms: number) => string;
};

export function EntitlementPaywall({
  config,
  sub,
}: {
  config: EntitlementPaywallConfig;
  sub: EntitlementSubscription;
}) {
  const t = useTranslations(config.namespace);
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { isSignedIn, signIn, isSigningIn, mismatch, signInError } =
    useSiweSession();
  // 支払い前の最終確認を経たか (価格/期間/返金不可 等を提示してから署名させる)。
  const [confirmed, setConfirmed] = useState(false);
  // relay 503 後のガスあり fallback は、ガスレス時の確認を流用せず別途同意を取る (CSV パスのみ)。
  const [gasPaidFallbackConfirmed, setGasPaidFallbackConfirmed] =
    useState(false);

  // payDeployment 未解決 (未対応 chain) なら switchChain 誘導、解決済なら購入フロー。
  const payDeployment =
    chainId != null ? resolveDeployment('jpyc', chainId) : undefined;
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');

  // relay 未構成を検知したら両確認をリセットする (ガスレス前提の同意をガスあり fallback に流用しない)。
  // supportsGasless=false (Pro) は gaslessUnavailable が常に undefined なので no-op。
  useEffect(() => {
    if (!config.supportsGasless || !sub.gaslessUnavailable) return;
    setConfirmed(false);
    setGasPaidFallbackConfirmed(false);
  }, [config.supportsGasless, sub.gaslessUnavailable]);

  const feeReceiverReady = env.feeReceiverConfigured;
  // ガスレスで送れる状態か (relay 可 + まだ 503 を踏んでいない)。supportsGasless=false は常に false。
  const gaslessMode =
    config.supportsGasless && !!sub.gasless && !sub.gaslessUnavailable;
  // 現在アクティブな確認フラグ: 503 後はガスあり fallback 用の別同意、それ以外は通常の確認。
  const activeConfirmed = sub.gaslessUnavailable
    ? gasPaidFallbackConfirmed
    : confirmed;
  const canRetryRelay = config.supportsGasless && !!sub.canRetryRelay;

  // ガス行: gaslessMode のみ「当社負担」文言、それ以外は通常のガス代利用者負担文言。
  const gasLine: ReactNode =
    gaslessMode && config.gaslessGasLineKey
      ? t(config.gaslessGasLineKey)
      : t(config.gasLineKey);

  return (
    <div className="rounded-2xl border border-amber-300 bg-white p-5 shadow-sm">
      <h3 className="text-base font-bold text-slate-900">{t('title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('intro')}</p>
      <p className="mt-2 text-lg font-bold text-slate-900">
        {t('price', config.priceValues)}
      </p>

      {/* 送金前ガード: FEE_RECEIVER 未設定なら支払い不可 (準備中表示)。 */}
      {!feeReceiverReady && (
        <p className="mt-3 text-xs text-amber-700">{t('misconfigured')}</p>
      )}

      {feeReceiverReady && !isConnected && (
        <p className="mt-3 text-xs text-slate-500">{t('connectRequired')}</p>
      )}

      {feeReceiverReady && isConnected && mismatch && (
        <p className="mt-3 text-xs text-amber-700">{t('mismatch')}</p>
      )}

      {/* SIWE 未ログイン → sign-in 誘導。 */}
      {feeReceiverReady && isConnected && !mismatch && !isSignedIn && (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            disabled={isSigningIn}
            onClick={() =>
              void signIn(t('signInStatement')).catch(() => undefined)
            }
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {isSigningIn ? t('signingIn') : t('signIn')}
          </button>
          {signInError && (
            <p className="text-[11px] text-red-600">{t('signInError')}</p>
          )}
        </div>
      )}

      {/* ログイン済 → 支払い前確認 + 送金。 */}
      {feeReceiverReady && isSignedIn && !mismatch && (
        <div className="mt-3 space-y-3">
          {/* 支払い前の最終確認 (法務の必須項目を署名前に再提示)。 */}
          <ul className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] leading-relaxed text-slate-600">
            {config.confirmItems.map((item) => (
              <li key={item.key}>{t(item.key, item.values)}</li>
            ))}
            {/* ガス行は gasless 出し分けのため確認項目とは別に末尾へ。 */}
            <li>{gasLine}</li>
          </ul>

          {!payDeployment ? (
            <button
              type="button"
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: defaultJpyc.chainId })}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
            >
              {t('switchChain', { chain: defaultJpyc.name })}
            </button>
          ) : sub.isSuccess ? (
            <p className="text-sm font-semibold text-emerald-700">
              {sub.expiresAt
                ? t('granted', { date: config.formatExpiry(sub.expiresAt) })
                : t('grantedNoDate')}
            </p>
          ) : sub.isSubscribeError ? (
            // 送金は確定済。subscribe (検証+付与) のみ再試行する (再送金しない)。
            <div className="space-y-2">
              <button
                type="button"
                disabled={sub.isSubscribing}
                onClick={sub.retrySubscribe}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sub.isSubscribing ? t('verifying') : t('retryVerify')}
              </button>
              <p className="text-[11px] text-red-600">
                {t('verifyError', { reason: sub.error?.message ?? 'error' })}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* 未解決の署名済 relay payload がある間は通常の購入 CTA を隠す (Codex P1):
                  再署名 = 新 nonce = 二重支払いリスク。再試行 (同一署名の再送信) のみを提示する。
                  engine 側 (startGasless/startGasPaid) にも同ガードがあり二重防御。
                  supportsGasless=false (Pro) は canRetryRelay/gaslessUnavailable が常に false なので
                  「!confirmed → reviewCta / confirmed → payCta」の従来 2 分岐に畳まれる。 */}
              {!activeConfirmed && !canRetryRelay ? (
                <button
                  type="button"
                  onClick={() => {
                    if (sub.gaslessUnavailable) {
                      setGasPaidFallbackConfirmed(true);
                    } else {
                      setConfirmed(true);
                    }
                  }}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
                >
                  {t('reviewCta', config.ctaValues)}
                </button>
              ) : activeConfirmed && !canRetryRelay && !sub.gaslessUnavailable ? (
                <button
                  type="button"
                  disabled={sub.isPaying || sub.isSubscribing}
                  onClick={sub.start}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sub.isPaying
                    ? t('paying')
                    : sub.isSubscribing
                      ? t('verifying')
                      : // ガスレス可なら「署名のみ・ガス代不要」CTA、不可ならガスあり CTA。
                        gaslessMode
                        ? t('payCtaGasless', config.ctaValues)
                        : t('payCta', config.ctaValues)}
                </button>
              ) : null}
              {/* ガスレス relay が pending(hash 無し) で宙吊り → 同一署名を再送信 (再署名しない)。 */}
              {canRetryRelay && (
                <button
                  type="button"
                  disabled={sub.isPaying || sub.isSubscribing}
                  onClick={sub.retryRelay}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('retryRelay')}
                </button>
              )}
              {/* relay 未構成 (503) → 自動フォールバックはせず、明示の「ガスありで送金して購入」を出す。 */}
              {sub.gaslessUnavailable && (
                <div className="space-y-2">
                  <p className="text-[11px] text-amber-700">
                    {t('relayUnavailable')}
                  </p>
                  {gasPaidFallbackConfirmed && (
                    <button
                      type="button"
                      disabled={sub.isPaying || sub.isSubscribing}
                      onClick={sub.startGasPaid}
                      className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('fallbackGasPaid')}
                    </button>
                  )}
                </div>
              )}
              {sub.isPayError &&
                (!sub.gaslessUnavailable || gasPaidFallbackConfirmed) && (
                  <p className="text-[11px] text-red-600">
                    {t('payError', { reason: sub.error?.message ?? 'error' })}
                  </p>
                )}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {/* CSV パスは note の後に「当社負担/利用者負担」を付す。Pro は note のみ (gasless 文言なし)。 */}
        {config.supportsGasless ? (
          <>
            {t('note')} {gaslessMode ? t('noteGasless') : t('noteGasPaid')}
          </>
        ) : (
          t('note')
        )}
      </p>
    </div>
  );
}
