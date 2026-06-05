'use client';

// 利用料の支払い UI (ペイウォール)。SIWE ログイン → tier 選択 → JPYC を OpenPay 受領
// アドレスへ送金 → txHash を /api/fee/verify に提出 → on-chain 照合で利用権付与。
// /history のぼかしオーバーレイ (B4) と freee パネルの両方から requiredTier を変えて使う。
// soft-gate: 強制力は無く、生データは本人のもの。回避可能 (思想と整合)。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSwitchChain } from 'wagmi';
import type { Hex } from 'viem';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useBillingPayment } from '@/hooks/useBillingPayment';
import {
  BILLING_TIERS,
  TIER_PRICE_JPYC,
  TIER_PRICE_YEN,
  tierAtLeast,
  type EntitlementTier,
} from '@/lib/billing';
import { env } from '@/lib/env';
import { resolveDeployment, defaultDeploymentForSymbol } from '@/lib/tokens';

type VerifyResponse = { ok: true; tier: EntitlementTier; expiresAt: number };

function formatDate(ms: number): string {
  // ローカル日付 (YYYY/MM/DD)。SSR/CSR で安定するよう UTC ベースで簡易整形。
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

export function BillingPaywall({
  requiredTier,
}: {
  requiredTier: EntitlementTier;
}) {
  const t = useTranslations('Billing');
  const qc = useQueryClient();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { isSignedIn, signIn, isSigningIn, mismatch } = useSiweSession();
  const entitlement = useEntitlement(isSignedIn);
  const pay = useBillingPayment();

  const [selectedTier, setSelectedTier] = useState<EntitlementTier>(requiredTier);
  // requiredTier が (mount 後に) 上がった場合、選択中が下回ったままにならないよう引き上げる。
  useEffect(() => {
    setSelectedTier((cur) => (tierAtLeast(cur, requiredTier) ? cur : requiredTier));
  }, [requiredTier]);
  // pay() 起動時の tier/chain を固定し、確定後の verify に使う (選択変更で drift させない)。
  const payCtxRef = useRef<{ tier: EntitlementTier; chainId: number } | null>(null);
  const verifiedForRef = useRef<string | null>(null);

  const verify = useMutation({
    mutationFn: async (args: {
      txHash: Hex;
      chainId: number;
      tier: EntitlementTier;
    }): Promise<VerifyResponse> => {
      const res = await fetch('/api/fee/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      const json = (await res.json().catch(() => ({}))) as
        | VerifyResponse
        | { ok: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        const reason =
          'error' in json && json.error ? json.error : 'verify_failed';
        throw new Error(reason);
      }
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['entitlement'] });
    },
  });

  // 接続 chain が JPYC 対応か (Polygon/Kaia + testnet)。非対応なら switch を促す。
  const payDeployment = useMemo(
    () => (chainId != null ? resolveDeployment('jpyc', chainId) : undefined),
    [chainId],
  );
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');

  // pay 確定 → verify を一度だけ起動。
  useEffect(() => {
    if (!pay.isConfirmed || !pay.txHash || !payCtxRef.current) return;
    if (verifiedForRef.current === pay.txHash) return;
    verifiedForRef.current = pay.txHash;
    verify.mutate({
      txHash: pay.txHash,
      chainId: payCtxRef.current.chainId,
      tier: payCtxRef.current.tier,
    });
  }, [pay.isConfirmed, pay.txHash, verify]);

  function startPay() {
    if (!payDeployment || chainId == null) return;
    // requiredTier 未満では支払わせない (pro gate で basic 過少支払い → 解除されない事故を防ぐ)。
    if (!tierAtLeast(selectedTier, requiredTier)) return;
    payCtxRef.current = { tier: selectedTier, chainId };
    verifiedForRef.current = null;
    verify.reset();
    pay.pay({
      tokenAddress: payDeployment.address,
      to: env.feeReceiver,
      amount: TIER_PRICE_JPYC[selectedTier],
      chainId,
    });
  }

  // 検証失敗時の再試行。既に確定済の txHash を再検証する (再送金させない → 二重支払い防止)。
  function retryVerify() {
    if (!pay.txHash || !payCtxRef.current) return;
    verify.mutate({
      txHash: pay.txHash,
      chainId: payCtxRef.current.chainId,
      tier: payCtxRef.current.tier,
    });
  }

  const granted = verify.data;
  const currentTier = entitlement.data?.tier ?? null;
  const currentExpiry = entitlement.data?.expiresAt ?? null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-base font-bold text-slate-900">{t('title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('intro')}</p>

      {/* 現在の利用権状態 (ログイン時) */}
      {isSignedIn && entitlement.data && !entitlement.data.bypass && (
        <p className="mt-2 text-[11px] text-slate-500">
          {currentTier && currentExpiry
            ? t('currentActive', {
                tier: t(`tier.${currentTier}.name`),
                date: formatDate(currentExpiry),
              })
            : t('currentNone')}
        </p>
      )}

      {/* tier カード */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {BILLING_TIERS.map((tier) => {
          const active = selectedTier === tier;
          // requiredTier 未満は選択不可 (例: freee=pro gate で basic を選ばせない)。
          const selectable = tierAtLeast(tier, requiredTier);
          return (
            <button
              key={tier}
              type="button"
              disabled={!selectable}
              onClick={() => selectable && setSelectedTier(tier)}
              aria-pressed={active}
              className={`rounded-xl border px-4 py-3 text-left transition ${
                active
                  ? 'border-brand bg-brand/5 ring-1 ring-brand'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              } ${!selectable ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-bold text-slate-900">
                  {t(`tier.${tier}.name`)}
                </span>
                <span className="text-sm font-semibold text-slate-900">
                  {t('priceMonthly', { yen: TIER_PRICE_YEN[tier] })}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {t(`tier.${tier}.desc`)}
              </p>
            </button>
          );
        })}
      </div>

      {/* 行動エリア: 接続 → ログイン → 支払い */}
      <div className="mt-4 space-y-2">
        {!isConnected ? (
          <p className="text-xs text-slate-500">{t('connectRequired')}</p>
        ) : mismatch ? (
          <p className="text-xs text-amber-700">{t('mismatch')}</p>
        ) : !isSignedIn ? (
          <button
            type="button"
            disabled={isSigningIn}
            onClick={() => void signIn(t('signInStatement')).catch(() => undefined)}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {isSigningIn ? t('signingIn') : t('signIn')}
          </button>
        ) : granted ? (
          <p className="text-sm font-semibold text-emerald-700">
            {t('granted', {
              tier: t(`tier.${granted.tier}.name`),
              date: formatDate(granted.expiresAt),
            })}
          </p>
        ) : !payDeployment ? (
          <button
            type="button"
            disabled={isSwitching}
            onClick={() => switchChain({ chainId: defaultJpyc.chainId })}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            {t('switchChain', { chain: defaultJpyc.name })}
          </button>
        ) : pay.isConfirmed && pay.txHash ? (
          // 送金は確定済。あとは検証のみ — 失敗しても再送金させず verify を再試行する。
          <>
            <button
              type="button"
              disabled={verify.isPending || !payCtxRef.current}
              onClick={retryVerify}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {verify.isPending ? t('verifying') : t('retryVerify')}
            </button>
            {verify.isError && (
              <p className="text-[11px] text-red-600">
                {t('verifyError', {
                  reason: (verify.error as Error)?.message ?? 'verify_failed',
                })}
              </p>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={pay.isSending || pay.isMining}
              onClick={startPay}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pay.isSending
                ? t('sending')
                : pay.isMining
                  ? t('mining')
                  : t('payCta', {
                      yen: TIER_PRICE_YEN[selectedTier],
                      symbol: payDeployment.displaySymbol,
                    })}
            </button>

            {pay.isError && (
              <p className="text-[11px] text-red-600">{t('payError')}</p>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {t('softGateNote')}
      </p>
    </div>
  );
}
