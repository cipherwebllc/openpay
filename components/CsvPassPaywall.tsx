'use client';

// CSV 24時間パス (都度 100 JPYC) の購入パネル。会計CSVダウンロードが CSV パスゲート (passLocked)
// のときに HistoryView が描画する。SIWE ログイン → 支払い前確認 (100 JPYC/24時間/自動更新なし/返金不可/
// 合算なし/超過も24時間/別途ガス代) → 100 JPYC を FEE_RECEIVER へ送金 → /api/csv-pass/subscribe で
// 検証 + 付与。検証失敗時は再支払いさせず再検証導線を出す。FEE_RECEIVER 未設定時は支払いボタンを
// 無効化する (未設定の宛先へ 100 JPYC を送らせない)。設計: plans/csv-pass.md。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount, useSwitchChain } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useCsvPassSubscribe } from '@/hooks/useCsvPassSubscribe';
import { env } from '@/lib/env';
import {
  resolveDeployment,
  defaultDeploymentForSymbol,
} from '@/lib/tokens';
import { CSV_PASS_PRICE_JPYC, CSV_PASS_GRANT_HOURS } from '@/lib/csvPass';

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

export function CsvPassPaywall() {
  const t = useTranslations('CsvPass');
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { isSignedIn, signIn, isSigningIn, mismatch, signInError } =
    useSiweSession();
  // 支払い前の最終確認を経たか (100 JPYC/24時間/返金不可 等を提示してから署名させる)。
  const [confirmed, setConfirmed] = useState(false);

  const payDeployment = useMemo(
    () => (chainId != null ? resolveDeployment('jpyc', chainId) : undefined),
    [chainId],
  );
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');
  // hook は常に有効な deployment で呼ぶ (条件付き呼出は不可)。実支払いは payDeployment 定義時のみ。
  const sub = useCsvPassSubscribe(payDeployment ?? defaultJpyc);

  const feeReceiverReady = env.feeReceiverConfigured;

  return (
    <div className="rounded-2xl border border-amber-300 bg-white p-5 shadow-sm">
      <h3 className="text-base font-bold text-slate-900">{t('title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('intro')}</p>
      <p className="mt-2 text-lg font-bold text-slate-900">
        {t('price', { price: CSV_PASS_PRICE_JPYC, hours: CSV_PASS_GRANT_HOURS })}
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
          {/* 支払い前の最終確認 (法務 §役務の対価 の必須項目を署名前に再提示)。 */}
          <ul className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] leading-relaxed text-slate-600">
            <li>
              {t('confirmPrice', {
                price: CSV_PASS_PRICE_JPYC,
                hours: CSV_PASS_GRANT_HOURS,
              })}
            </li>
            <li>{t('confirmNoAutoRenew')}</li>
            <li>{t('confirmNoRefund')}</li>
            <li>{t('confirmNoStacking', { hours: CSV_PASS_GRANT_HOURS })}</li>
            <li>{t('confirmOverpay', { hours: CSV_PASS_GRANT_HOURS })}</li>
            <li>{t('confirmGas')}</li>
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
                ? t('granted', { date: formatDate(sub.expiresAt) })
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
              {!confirmed ? (
                <button
                  type="button"
                  onClick={() => setConfirmed(true)}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
                >
                  {t('reviewCta', { price: CSV_PASS_PRICE_JPYC })}
                </button>
              ) : (
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
                      : t('payCta', { price: CSV_PASS_PRICE_JPYC })}
                </button>
              )}
              {sub.isPayError && (
                <p className="text-[11px] text-red-600">
                  {t('payError', { reason: sub.error?.message ?? 'error' })}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {t('note')}
      </p>
    </div>
  );
}
