'use client';

// 店主の受注画面: 受取ウォレットで SIWE サインインし、自分宛の着金済み注文 (テーブル番号 + 申告明細 +
// **実着金額**) を ~12s ポーリングで表示し、「対応済み」で消す。read authz は server 側で厳格に
// session.address === 受取アドレス (受取ウォレット本人のみ)。
// react-query を使うため、親 (create ページ) は env.enableOrderRelay でこのパネルの**マウント自体**を
// ゲートする (OFF の単体テストで QueryClient を要求しない)。設計: plans/swift-puzzling-sky.md。

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { useSiweSession } from '@/hooks/useSiweSession';
import { isJpycChainSlug, slugForChain, txExplorerUrl } from '@/lib/chains';
import { JPYC_CHAIN_LABEL } from '@/lib/mobileOrder';
import type { StoredOrder } from '@/lib/orderRelay';

// JPYC は全チェーン 18 decimals。保存 amount は minor units の十進文字列 (parseStoredOrder で検証済み)。
const JPYC_DECIMALS = 18;

async function fetchFeed(): Promise<StoredOrder[]> {
  const res = await fetch('/api/order/feed');
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // KV 障害 (503) を「受注ゼロ」と偽装しない (isError でエラー表示 + 再試行)。
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${res.status}`);
  return Array.isArray(json.orders) ? (json.orders as StoredOrder[]) : [];
}

function chainLabel(chainId: number): string {
  const slug = slugForChain(chainId);
  return slug && isJpycChainSlug(slug) ? `JPYC (${JPYC_CHAIN_LABEL[slug]})` : `chain ${chainId}`;
}

export function OrderFeedPanel() {
  const t = useTranslations('OrderRelay');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } = useSiweSession();
  const qc = useQueryClient();

  const feed = useQuery({
    // wallet 切替で前 wallet の cache を流用しないよう session address でスコープ。
    queryKey: ['order-feed', sessionAddress],
    enabled: isSignedIn,
    refetchInterval: 12_000, // ~12s ポーリング (serverless 親和・タブレット常時表示向け)
    queryFn: fetchFeed,
  });

  const fulfill = useMutation({
    mutationFn: async (orderId: string) => {
      const res = await fetch('/api/order/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order-feed', sessionAddress] }),
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">{t('heading')}</h2>
        <p className="mt-1 text-sm text-slate-500">{t('subheading')}</p>
      </div>

      {!isSignedIn ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-center">
          <p className="text-sm text-slate-600">{t('signInPrompt')}</p>
          <button
            type="button"
            onClick={() => signIn(t('signInStatement'))}
            disabled={isSigningIn}
            className="mt-3 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {isSigningIn ? t('signingIn') : t('signIn')}
          </button>
          {signInError && <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">{t('autoRefresh')}</p>
            <button
              type="button"
              onClick={() => feed.refetch()}
              className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t('refresh')}
            </button>
          </div>

          {feed.isError ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {t('loadError')}
            </p>
          ) : feed.isLoading ? (
            <p className="text-center text-sm text-slate-400">{t('loading')}</p>
          ) : (feed.data?.length ?? 0) === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
              {t('empty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {feed.data!.map((o) => {
                const explorer = txExplorerUrl(o.chainId, o.txHash);
                return (
                  <li key={o.orderId} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {o.table && (
                          // o.table は checkout description (例「テーブル 7」) をそのまま表示。
                          <p className="text-base font-bold text-slate-900">{o.table}</p>
                        )}
                        <p className="text-xs text-slate-400">{chainLabel(o.chainId)}</p>
                      </div>
                      <span className="shrink-0 text-right">
                        <span className="text-base font-bold text-slate-900">
                          {formatUnits(BigInt(o.amount), JPYC_DECIMALS)}
                        </span>{' '}
                        <span className="text-[10px] font-medium text-slate-400">JPYC</span>
                      </span>
                    </div>
                    {o.items.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
                        {o.items.map((it, i) => (
                          <li key={i} className="truncate">
                            {it.name} × {it.qty}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* 明細/テーブルは顧客申告・金額はオンチェーン検証済み (advisory 原則の明示)。 */}
                    <p className="mt-1 text-[11px] text-slate-400">{t('claimedNote')}</p>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      {explorer ? (
                        <a
                          href={explorer}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-brand hover:underline"
                        >
                          {t('viewTx')} ↗
                        </a>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        onClick={() => fulfill.mutate(o.orderId)}
                        disabled={fulfill.isPending}
                        className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('markFulfilled')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-slate-400">{t('disclosure')}</p>
    </div>
  );
}
