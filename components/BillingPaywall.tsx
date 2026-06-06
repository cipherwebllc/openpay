'use client';

// 利用料の支払い UI (ペイウォール)。SIWE ログイン → tier 選択 → JPYC を OpenPay 受領
// アドレスへ送金 → txHash を /api/fee/verify に提出 → on-chain 照合で利用権付与。
// /history の CSV ダウンロードゲート (閲覧は無料) や freee パネルから requiredTier を変えて使う。
// soft-gate: 強制力は無く、生データは本人のもの。回避可能 (思想と整合)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSwitchChain } from 'wagmi';
import type { Hex } from 'viem';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useBillingPayment } from '@/hooks/useBillingPayment';
import {
  BILLING_TIERS,
  TIER_PERIOD,
  TIER_PRICE_JPYC,
  TIER_PRICE_YEN,
  tierAtLeast,
  type EntitlementTier,
} from '@/lib/billing';
import { env } from '@/lib/env';
import { resolveDeployment, defaultDeploymentForSymbol } from '@/lib/tokens';

type VerifyResponse = { ok: true; tier: EntitlementTier; expiresAt: number };

// 行動エリアの排他状態。優先順位順に評価して 1 つだけ描画する (深いネスト三項を避け、
// 状態の追加/編集を独立させる)。
type ActionKind =
  | 'misconfigured' // 受領アドレス未設定 (送金先が burn)
  | 'connect' // ウォレット未接続
  | 'mismatch' // ログイン中と接続中の wallet 不一致
  | 'signIn' // 未ログイン
  | 'granted' // 付与完了
  | 'switchChain' // 非 JPYC chain
  | 'verify' // 送金確定済 → 検証/再検証フェーズ
  | 'pay'; // 支払い待ち

function formatDate(ms: number): string {
  // 利用権の満了日を YYYY/MM/DD (ローカル日付) で表示。
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
  const { isSignedIn, signIn, isSigningIn, mismatch, signInError } =
    useSiweSession();
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

  // 確定済 txHash を /api/fee/verify へ。pay 起動時に固定した tier/chain を使う (選択変更で
  // drift させない)。自動起動 (pay 確定) と手動再試行 (検証失敗) の両方から呼ぶ。
  // dep は verify 全体でなく安定参照の verify.mutate にする (useMutation の戻り object は
  // 毎 render で identity が変わるため、verify を dep にすると runVerify が毎 render 再生成される)。
  const verifyMutate = verify.mutate;
  const runVerify = useCallback(() => {
    const ctx = payCtxRef.current;
    if (!pay.txHash || !ctx) return;
    verifyMutate({ txHash: pay.txHash, chainId: ctx.chainId, tier: ctx.tier });
  }, [pay.txHash, verifyMutate]);

  // pay 確定 → verify を一度だけ自動起動。
  useEffect(() => {
    if (!pay.isConfirmed || !pay.txHash || !payCtxRef.current) return;
    if (verifiedForRef.current === pay.txHash) return;
    verifiedForRef.current = pay.txHash;
    runVerify();
  }, [pay.isConfirmed, pay.txHash, runVerify]);

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

  const granted = verify.data;
  const currentTier = entitlement.data?.tier ?? null;
  const currentExpiry = entitlement.data?.expiresAt ?? null;

  // 排他状態を優先順位順に 1 つ決める。各状態の描画は下の {action === ...} で独立に行う。
  const action: ActionKind = !env.feeReceiverConfigured
    ? 'misconfigured'
    : !isConnected
      ? 'connect'
      : mismatch
        ? 'mismatch'
        : !isSignedIn
          ? 'signIn'
          : granted
            ? 'granted'
            : !payDeployment
              ? 'switchChain'
              : pay.isConfirmed && pay.txHash
                ? 'verify'
                : 'pay';

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
                  {t(
                    TIER_PERIOD[tier] === 'year' ? 'priceAnnual' : 'priceMonthly',
                    { yen: TIER_PRICE_YEN[tier] },
                  )}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {t(`tier.${tier}.desc`)}
              </p>
            </button>
          );
        })}
      </div>

      {/* 行動エリア: action (排他状態) ごとに独立して描画。優先順位は action 算出側に集約。 */}
      <div className="mt-4 space-y-2">
        {action === 'misconfigured' && (
          // 受領アドレス未設定 → 送金先が burn になるため支払いを出さない (運用設定不備)。
          <p className="text-xs text-amber-700">{t('misconfigured')}</p>
        )}
        {action === 'connect' && (
          <p className="text-xs text-slate-500">{t('connectRequired')}</p>
        )}
        {action === 'mismatch' && (
          <p className="text-xs text-amber-700">{t('mismatch')}</p>
        )}
        {action === 'signIn' && (
          <>
            <button
              type="button"
              disabled={isSigningIn}
              onClick={() => void signIn(t('signInStatement')).catch(() => undefined)}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {isSigningIn ? t('signingIn') : t('signIn')}
            </button>
            {signInError && (
              <p className="text-[11px] text-red-600">{t('signInError')}</p>
            )}
          </>
        )}
        {action === 'granted' && granted && (
          <p className="text-sm font-semibold text-emerald-700">
            {t('granted', {
              tier: t(`tier.${granted.tier}.name`),
              date: formatDate(granted.expiresAt),
            })}
          </p>
        )}
        {action === 'switchChain' && (
          <button
            type="button"
            disabled={isSwitching}
            onClick={() => switchChain({ chainId: defaultJpyc.chainId })}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            {t('switchChain', { chain: defaultJpyc.name })}
          </button>
        )}
        {action === 'verify' && (
          // 送金は確定済。あとは検証のみ — 失敗しても再送金させず verify を再試行する。
          <>
            <button
              type="button"
              disabled={verify.isPending || !payCtxRef.current}
              onClick={runVerify}
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
        )}
        {action === 'pay' && payDeployment && (
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
