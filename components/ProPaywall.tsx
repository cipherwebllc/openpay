'use client';

// OpenPay Pro (月額 ¥500) の加入パネル。CSV ダウンロードが Pro ゲート (proLocked) のときに
// HistoryView が描画する。SIWE ログイン → 支払い前確認 (¥500/30日/自動更新なし/返金不可/超過も
// 30日/別途ガス代) → 500 JPYC を FEE_RECEIVER へ送金 → /api/pro/subscribe で検証 + 付与。
// 検証失敗時は再支払いさせず再検証導線を出す。FEE_RECEIVER 未設定時は支払いボタンを無効化する
// (未設定の宛先へ 500 JPYC を送らせない)。設計: plans/pro-plan.md。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount, useSwitchChain } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useProSubscribe } from '@/hooks/useProSubscribe';
import { env } from '@/lib/env';
import {
  resolveDeployment,
  defaultDeploymentForSymbol,
} from '@/lib/tokens';
import { PRO_PRICE_JPYC, PRO_GRANT_DAYS } from '@/lib/proPlan';

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function ProPaywall() {
  const t = useTranslations('Pro');
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { isSignedIn, signIn, isSigningIn, mismatch, signInError } =
    useSiweSession();
  // 支払い前の最終確認を経たか (¥500/30日/返金不可 等を提示してから署名させる)。
  const [confirmed, setConfirmed] = useState(false);

  const payDeployment = useMemo(
    () => (chainId != null ? resolveDeployment('jpyc', chainId) : undefined),
    [chainId],
  );
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');
  // hook は常に有効な deployment で呼ぶ (条件付き呼出は不可)。実支払いは payDeployment 定義時のみ。
  const sub = useProSubscribe(payDeployment ?? defaultJpyc);

  const feeReceiverReady = env.feeReceiverConfigured;

  return (
    <div className="rounded-2xl border border-amber-300 bg-white p-5 shadow-sm">
      <h3 className="text-base font-bold text-slate-900">{t('title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('intro')}</p>
      <p className="mt-2 text-lg font-bold text-slate-900">
        {t('price', { price: PRO_PRICE_JPYC, days: PRO_GRANT_DAYS })}
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
          {/* 支払い前の最終確認 (Codex P2・法務 §3 の必須項目を署名前に再提示)。 */}
          <ul className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] leading-relaxed text-slate-600">
            <li>{t('confirmPrice', { price: PRO_PRICE_JPYC, days: PRO_GRANT_DAYS })}</li>
            <li>{t('confirmNoAutoRenew')}</li>
            <li>{t('confirmNoRefund')}</li>
            <li>{t('confirmOverpay')}</li>
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
                  {t('reviewCta', { price: PRO_PRICE_JPYC })}
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
                      : t('payCta', { price: PRO_PRICE_JPYC })}
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
