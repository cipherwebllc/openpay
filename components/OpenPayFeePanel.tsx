'use client';

// OpenPay 利用料 (a1) の店主向け支払いパネル。SIWE ログイン → インボイス表示 (前月分=清算対象 +
// 当月これまで) → JPYC をガスレス (EIP-3009 署名のみ・店主は native gas 不要) で FEE_RECEIVER へ送金 →
// /api/billing/settle で on-chain 照合 → fee-current 付与。NEXT_PUBLIC_ENABLE_BILLING ON のときのみ
// 親が描画する。アルファ (bypass) 中は「無料」を表示し支払いを出さない。
// 設計: docs/plans/merchant-gasless-fee-a1.md (S6)。
//
// 支払いは「送金 (pay)」と「清算 (settle)」を分離する: 送金確定後に txHash を保持し、settle が失敗
// しても **同じ txHash で settle のみ再試行** する (再送金 = 二重支払いを防ぐ)。relay が pending を
// 返したら再送せず確定待ちを促す。連署名ウォレット不一致 (mismatch) 中は支払いを出さない
// (送金元と SIWE セッションが食い違い settle が from 不一致で失敗するため)。

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSwitchChain } from 'wagmi';
import { formatUnits, type Hex } from 'viem';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useBillingInvoice } from '@/hooks/useBillingInvoice';
import { useUsageFeePayment } from '@/hooks/useUsageFeePayment';
import { env } from '@/lib/env';
import { resolveDeployment, defaultDeploymentForSymbol } from '@/lib/tokens';

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

// wei (18 decimals) を JPYC 表示文字列に。末尾 0 を整理 (例 "100" / "100.5")。
function formatJpyc(wei: string): string {
  const s = formatUnits(BigInt(wei), 18);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function OpenPayFeePanel() {
  const t = useTranslations('UsageFee');
  const qc = useQueryClient();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { isSignedIn, signIn, isSigningIn, mismatch, signInError } =
    useSiweSession();

  const billingOn = env.enableUsageFee;
  const invoice = useBillingInvoice(isSignedIn && billingOn);

  const payDeployment = useMemo(
    () => (chainId != null ? resolveDeployment('jpyc', chainId) : undefined),
    [chainId],
  );
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');
  // hook は常に有効な deployment で呼ぶ (条件付き呼出は不可)。実支払いは payDeployment 定義時のみ。
  const pay = useUsageFeePayment(payDeployment ?? defaultJpyc);

  // 送金確定後の txHash を保持し、settle 失敗時はこの hash で settle だけ再試行する (再送金しない)。
  const payTxRef = useRef<Hex | null>(null);
  const [payPending, setPayPending] = useState(false);

  const settle = useMutation({
    mutationFn: async (txHash: Hex) => {
      const res = await fetch('/api/billing/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, chainId }), // period はサーバが前月で導出
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'settle_failed');
      return json;
    },
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['billing-invoice'] }),
  });

  // 送金 → 確定で txHash を保持 → settle 自動起動。pending は再送/清算せず確定待ちを促す。
  async function startPay() {
    const due = invoice.data?.due;
    if (!payDeployment || !due) return;
    const r = await pay
      .mutateAsync({ value: BigInt(due.feeWei) })
      .catch(() => null);
    if (!r) return; // 送金エラーは pay.isError で表示
    if (r.pending) {
      setPayPending(true);
      return;
    }
    if (r.success && r.txHash) {
      payTxRef.current = r.txHash;
      settle.mutate(r.txHash);
    }
  }

  const data = invoice.data;
  const due = data?.due;
  const current = data?.current;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-base font-bold text-slate-900">{t('title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        {t('intro')}
      </p>

      {/* アルファ (billing 未点灯) は無料。点灯後のみ請求 UI を描画する。 */}
      {!billingOn && (
        <p className="mt-3 text-sm font-semibold text-emerald-700">
          {t('bypassNote')}
        </p>
      )}

      {billingOn && (
        <>
          {!env.feeReceiverConfigured && (
            <p className="mt-3 text-xs text-amber-700">{t('misconfigured')}</p>
          )}

          {env.feeReceiverConfigured && !isConnected && (
            <p className="mt-3 text-xs text-slate-500">
              {t('connectRequired')}
            </p>
          )}

          {env.feeReceiverConfigured && isConnected && mismatch && (
            <p className="mt-3 text-xs text-amber-700">{t('mismatch')}</p>
          )}

          {env.feeReceiverConfigured &&
            isConnected &&
            !mismatch &&
            !isSignedIn && (
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

          {isSignedIn && invoice.isLoading && (
            <p className="mt-3 text-xs text-slate-500">{t('loading')}</p>
          )}
          {isSignedIn && invoice.isError && (
            <p className="mt-3 text-xs text-red-600">{t('loadError')}</p>
          )}

          {isSignedIn && data && (
            <div className="mt-3 space-y-3">
              {data.bypass ? (
                <p className="text-sm font-semibold text-emerald-700">
                  {t('bypassNote')}
                </p>
              ) : (
                <>
                  {data.feeCurrent && data.expiresAt ? (
                    <p className="text-sm font-semibold text-emerald-700">
                      {t('currentPaid', { date: formatDate(data.expiresAt) })}
                    </p>
                  ) : null}

                  {current && (
                    <p className="text-[11px] text-slate-500">
                      {t('currentSummary', {
                        period: current.period,
                        count: current.count,
                        volume: formatJpyc(current.volumeWei),
                      })}
                    </p>
                  )}

                  {due && due.free ? (
                    <p className="text-xs text-slate-500">{t('noneDue')}</p>
                  ) : due ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-600">
                        {t('dueSummary', {
                          period: due.period,
                          count: due.count,
                          volume: formatJpyc(due.volumeWei),
                          rate: `${(due.rateBps / 100).toString()}%`,
                        })}
                      </p>
                      <p className="mt-1 text-lg font-bold text-slate-900">
                        {t('dueAmount', { fee: formatJpyc(due.feeWei) })}
                      </p>
                    </div>
                  ) : null}

                  {/* 支払い: 残額あり・未払い・ウォレット一致のときのみ。mismatch は上で警告済。 */}
                  {due && !due.free && !data.feeCurrent && !mismatch && (
                    <div className="space-y-2">
                      {!payDeployment ? (
                        <button
                          type="button"
                          disabled={isSwitching}
                          onClick={() =>
                            switchChain({ chainId: defaultJpyc.chainId })
                          }
                          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
                        >
                          {t('switchChain', { chain: defaultJpyc.name })}
                        </button>
                      ) : payPending ? (
                        <p className="text-[11px] text-amber-700">
                          {t('pending')}
                        </p>
                      ) : payTxRef.current && settle.isError ? (
                        // 送金は確定済。settle のみ再試行する (再送金しない)。
                        <>
                          <button
                            type="button"
                            disabled={settle.isPending}
                            onClick={() =>
                              settle.mutate(payTxRef.current as Hex)
                            }
                            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {settle.isPending
                              ? t('settling')
                              : t('retrySettle')}
                          </button>
                          <p className="text-[11px] text-red-600">
                            {t('settleError', {
                              reason:
                                (settle.error as Error)?.message ?? 'error',
                            })}
                          </p>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={pay.isPending || settle.isPending}
                            onClick={() => void startPay()}
                            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {pay.isPending
                              ? t('signing')
                              : settle.isPending
                                ? t('settling')
                                : t('payCta', { fee: formatJpyc(due.feeWei) })}
                          </button>
                          {pay.isError && (
                            <p className="text-[11px] text-red-600">
                              {t('payError', {
                                reason:
                                  (pay.error as Error)?.message ?? 'error',
                              })}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {settle.isSuccess && (
                    <p className="text-sm font-semibold text-emerald-700">
                      {t('paid')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {t('note')}
      </p>
    </div>
  );
}
