'use client';

// OpenPay 利用料 (a1) の店主向け支払いパネル。SIWE ログイン → インボイス表示 (前月分=清算対象 +
// 当月これまで) → JPYC をガスレス (EIP-3009 署名のみ・店主は native gas 不要) で FEE_RECEIVER へ送金 →
// /api/billing/settle で on-chain 照合 → fee-current 付与。NEXT_PUBLIC_ENABLE_USAGE_FEE ON のときのみ
// 親が描画する。アルファ (bypass) 中は「無料」を表示し支払いを出さない。
// 設計: docs/plans/merchant-gasless-fee-a1.md (S6)。
//
// 支払いは「送金 (pay)」と「清算 (settle)」を分離する: 送金確定後に txHash を保持し、settle が失敗
// しても **同じ txHash で settle のみ再試行** する (再送金 = 二重支払いを防ぐ)。relay が pending を
// 返したら再送せず確定待ちを促す。連署名ウォレット不一致 (mismatch) 中は支払いを出さない
// (送金元と SIWE セッションが食い違い settle が from 不一致で失敗するため)。

import { useMemo, useRef, useState, type ReactElement } from 'react';
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

  // 送金確定後の txHash を **期間別に** 保持し、settle 失敗時はこの hash で settle だけ再試行する
  // (再送金しない)。期間別清算 (owed 複数) でも単一 due フローでも同じ ref を期間キーで使い回す。
  const payTxByPeriod = useRef<Map<string, Hex>>(new Map());
  // pending (relay 未確定) になった期間。再送せず確定待ちを促す。
  const [pendingPeriod, setPendingPeriod] = useState<string | null>(null);
  // on-chain で revert した期間 (送金は成立していない)。throw ではなく success=false の
  // 結果で返るため、明示表示しないと「押しても何も起きない」無反応に見える。
  const [revertedPeriod, setRevertedPeriod] = useState<string | null>(null);
  // 今どの期間を清算中か (settle mutation の状態を期間別に表示するため)。
  const [activePeriod, setActivePeriod] = useState<string | null>(null);

  const settle = useMutation({
    mutationFn: async (vars: { txHash: Hex; period?: string }) => {
      const res = await fetch('/api/billing/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // period 未指定はサーバが前月で導出 (後方互換)。期間別清算では明示する。
        body: JSON.stringify({
          txHash: vars.txHash,
          chainId,
          ...(vars.period ? { period: vars.period } : {}),
        }),
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
  // line = 清算対象期間のインボイス行。period を settle に渡す (owed 複数で期間を取り違えない)。
  async function startPay(line: { period: string; feeWei: string }) {
    if (!payDeployment) return;
    setActivePeriod(line.period);
    setPendingPeriod(null);
    setRevertedPeriod(null);
    const r = await pay
      .mutateAsync({ value: BigInt(line.feeWei) })
      .catch(() => null);
    if (!r) return; // 送金エラーは pay.isError で表示
    if (r.pending) {
      setPendingPeriod(line.period);
      return;
    }
    if (r.success && r.txHash) {
      payTxByPeriod.current.set(line.period, r.txHash);
      settle.mutate({ txHash: r.txHash, period: line.period });
      return;
    }
    // relay は成立したが tx が revert = 送金未成立。再署名して再試行してよい。
    setRevertedPeriod(line.period);
  }

  // settle 失敗後の再試行 (再送金せず、保持済み txHash で settle のみ再実行)。
  function retrySettle(period: string) {
    const tx = payTxByPeriod.current.get(period);
    if (!tx) return;
    setActivePeriod(period);
    settle.mutate({ txHash: tx, period });
  }

  const data = invoice.data;
  const due = data?.due;
  const current = data?.current;
  // 未払い請求の一覧 (lookback 内・新しい順)。複数あれば期間別清算 UI を出す。
  const owed = data?.owed ?? [];
  const multiOwed = owed.length > 1;

  // 期間 line の支払いボタン群 (送金→settle・pending・再試行)。単一 due と期間別 owed で共有する。
  // 状態 (pending/error/success) は period 別に判定し、複数期間で取り違えないようにする。
  function renderPayControls(line: {
    period: string;
    feeWei: string;
  }): ReactElement {
    const isPending = pendingPeriod === line.period;
    const hasTx = payTxByPeriod.current.has(line.period);
    const isActive = activePeriod === line.period;
    // settle のエラー/進行/成功はグローバル mutation の状態を「今その期間を清算中か」で絞る。
    const settleErrored = isActive && settle.isError && hasTx;
    const settling = isActive && settle.isPending;
    if (!payDeployment) {
      return (
        <button
          type="button"
          disabled={isSwitching}
          onClick={() => switchChain({ chainId: defaultJpyc.chainId })}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          {t('switchChain', { chain: defaultJpyc.name })}
        </button>
      );
    }
    if (isPending) {
      return <p className="text-[11px] text-amber-700">{t('pending')}</p>;
    }
    if (settleErrored) {
      // 送金は確定済。settle のみ再試行する (再送金しない)。
      return (
        <>
          <button
            type="button"
            disabled={settle.isPending}
            onClick={() => retrySettle(line.period)}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {settling ? t('settling') : t('retrySettle')}
          </button>
          <p className="text-[11px] text-red-600">
            {t('settleError', {
              reason: (settle.error as Error)?.message ?? 'error',
            })}
          </p>
        </>
      );
    }
    return (
      <>
        <button
          type="button"
          disabled={pay.isPending || settle.isPending}
          onClick={() => void startPay(line)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isActive && pay.isPending
            ? t('signing')
            : settling
              ? t('settling')
              : t('payCta', { fee: formatJpyc(line.feeWei) })}
        </button>
        {isActive && pay.isError && (
          <p className="text-[11px] text-red-600">
            {t('payError', { reason: (pay.error as Error)?.message ?? 'error' })}
          </p>
        )}
        {revertedPeriod === line.period && !pay.isError && (
          <p className="text-[11px] text-red-600">
            {t('payError', { reason: 'reverted' })}
          </p>
        )}
      </>
    );
  }

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

                  {multiOwed ? (
                    /* 未払いが複数月 (古い未収あり): 期間別に明細 + 「この月分を支払う」を出す。
                       期間ごとに送金→settle を実行し、settle には period を渡す。 */
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-slate-700">
                        {t('owedListTitle', { count: owed.length })}
                      </p>
                      <ul className="space-y-2">
                        {owed.map((line) => (
                          <li
                            key={line.period}
                            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                          >
                            <p className="text-xs text-slate-600">
                              {t('dueSummary', {
                                period: line.period,
                                count: line.count,
                                volume: formatJpyc(line.volumeWei),
                                rate: `${(line.rateBps / 100).toString()}%`,
                              })}
                            </p>
                            <p className="mt-1 text-base font-bold text-slate-900">
                              {t('owedPeriodAmount', {
                                fee: formatJpyc(line.feeWei),
                              })}
                            </p>
                            {/* 期間別の支払い: ウォレット一致のときのみ (mismatch は上で警告済)。 */}
                            {!mismatch && (
                              <div className="mt-2 space-y-2">
                                {renderPayControls(line)}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <>
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
                        <div className="space-y-2">{renderPayControls(due)}</div>
                      )}
                    </>
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

      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
        {t('note')}
      </p>
    </div>
  );
}
