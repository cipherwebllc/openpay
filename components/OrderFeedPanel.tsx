'use client';

// 店主の受注画面: 受取ウォレットで SIWE サインインし、自分宛の着金済み注文 (受付番号 + テーブル番号 +
// 申告明細 + **実着金額**) を ~12s ポーリングで表示する。「対応済み」は削除でなく **フラグ化** し、
// 「対応済み」セクション + 「未対応に戻す」で誤操作を復旧できる (txHash で対象指定・受付番号は人間向け表示)。
// read authz は server 側で厳格に session.address === 受取アドレス (受取ウォレット本人のみ)。
// react-query を使うため、親 (create ページ) は env.enableOrderRelay でこのパネルの**マウント自体**を
// ゲートする (OFF の単体テストで QueryClient を要求しない)。設計: plans/swift-puzzling-sky.md。

import { OrderBindingNotice } from '@/components/OrderBindingNotice';
import { useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { groupAmountDigits } from '@/lib/amount';
import { CheckCircle2, ChefHat, Clock, RefreshCw, RotateCcw, UtensilsCrossed } from 'lucide-react';
import { env } from '@/lib/env';
import { fetchOrderFeed, orderFeedQueryKey } from '@/hooks/useOrderFeed';
import { useOrderCalls } from '@/hooks/useOrderCalls';
import { useSiweSession } from '@/hooks/useSiweSession';
import { SignInGate } from '@/components/SignInGate';
import { ShopLivePanel } from '@/components/ShopLivePanel';
import { OrderOperatorTokenPanel } from '@/components/OrderOperatorTokenPanel';
import { txExplorerUrl } from '@/lib/chains';
import { jpycChainLabel } from '@/lib/mobileOrder';
import { declaredItemsTotalMinor, type StoredOrder } from '@/lib/orderRelay';
import { ELAPSED_LATE_MIN, ELAPSED_WARN_MIN } from '@/components/OrderCard';
import { OrderCallSection } from '@/components/OrderCallSection';
import { isOrderAlertSoundEnabled } from '@/lib/soundPref';
import { playNewOrderChime } from '@/lib/successChime';
import { fetchMyHandles, myHandlesQueryKey } from '@/lib/handleMine';

// JPYC は全チェーン 18 decimals。保存 amount は minor units の十進文字列 (parseStoredOrder で検証済み)。
const JPYC_DECIMALS = 18;

// OrderFeedPanel は "JPYC (Polygon)" 形式 (OrderFulfillmentBoard は bare "Polygon")。slug→bare label の
// 解決だけ jpycChainLabel で共有し、フォーマット (プレフィックス) は各呼出側が付ける。
function chainLabel(chainId: number): string {
  const label = jpycChainLabel(chainId);
  return label ? `JPYC (${label})` : `chain ${chainId}`;
}

export function OrderFeedPanel({
  onOpenMobileOrder,
}: {
  /** 受注が無いときの「モバイル注文を開く」(モバイル注文タブが使えるときだけ親が渡す)。 */
  onOpenMobileOrder?: () => void;
} = {}) {
  const t = useTranslations('OrderRelay');
  const tF = useTranslations('OrderFulfillment'); // 厨房/ホール導線ラベル
  const tLive = useTranslations('ShopLive'); // 営業中の操作 見出し
  const locale = useLocale();
  const { isSignedIn, sessionAddress } = useSiweSession();
  const qc = useQueryClient();

  // 営業中の操作 (ShopLivePanel) 用の所有 handle (公開済み店舗のみ)。enableShopLive のときだけ取得。
  // queryKey は StorefrontPublishPanel / HandleClaimPanel と共有 (同 cache・返り値の形 {handles,max} 一致必須)。
  const mine = useQuery({
    // 取得と返り値の形は lib/handleMine.ts に 1 つ (他の画面・トップと同じ cache を共有する)。
    queryKey: myHandlesQueryKey(sessionAddress),
    enabled: env.enableHandles && env.enableShopLive && isSignedIn,
    queryFn: fetchMyHandles,
  });
  // 公開済み店舗 (storefront あり) の handle のみが営業中の操作の対象。
  const liveHandles = useMemo(
    () => (mine.data?.handles ?? []).filter((h) => h.storefront),
    [mine.data],
  );
  const [liveSel, setLiveSel] = useState('');
  const liveSelected =
    (liveSel && liveHandles.find((h) => h.handle === liveSel)) || liveHandles[0] || null;

  const feed = useQuery({
    // wallet 切替で前 wallet の cache を流用しないよう session address でスコープ。
    // enableOrderRelay OFF (営業中の操作 だけ shop-live で開いている) では受注フィードを引かない。
    queryKey: orderFeedQueryKey(sessionAddress),
    enabled: isSignedIn && env.enableOrderRelay,
    refetchInterval: 12_000, // ~12s ポーリング (serverless 親和・タブレット常時表示向け)
    queryFn: () => fetchOrderFeed(),
  });
  const callFeed = useOrderCalls(sessionAddress, isSignedIn, 12_000);

  // 対応済み = 削除でなくフラグ化。対象は txHash で指定 (受付番号は短縮で衝突しうるため)。
  const fulfill = useMutation({
    mutationFn: async (vars: { txHash: string; fulfilled: boolean }) => {
      const res = await fetch('/api/order/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: orderFeedQueryKey(sessionAddress) }),
  });

  const renderCard = (o: StoredOrder, done: boolean) => {
    const explorer = txExplorerUrl(o.chainId, o.txHash);
    // 12s ポーリングの再レンダー時に更新すれば十分。経過表示専用の interval は増やさない。
    const ageMin = !done && o.ts > 0
      ? Math.max(0, Math.floor((Date.now() - o.ts) / 60_000))
      : null;
    const amountWarning = o.amountMismatch
      ? t('amountMismatchBadge')
      : o.amountUnchecked
        ? t('amountUncheckedBadge')
        : null;
    const amountWarningClass = o.amountMismatch
      ? 'bg-red-600 text-white'
      : 'border border-amber-300 bg-amber-50 text-amber-800';
    // 表示だけ桁区切り (1,650)。検証済みの実着金額そのものは変えない。
    const formattedAmount = groupAmountDigits(formatUnits(BigInt(o.amount), JPYC_DECIMALS));
    const declaredAmount = o.amountMismatch
      ? declaredItemsTotalMinor(o.items, JPYC_DECIMALS)
      : null;
    const formattedDeclaredAmount =
      declaredAmount !== null ? groupAmountDigits(formatUnits(declaredAmount, JPYC_DECIMALS)) : null;
    return (
      <li
        key={o.txHash}
        className={`rounded-2xl border p-4 ${
          done
            ? 'border-slate-200 bg-slate-50 opacity-70'
            : ageMin !== null && ageMin >= ELAPSED_LATE_MIN
              ? 'border-red-400 bg-red-50/60'
              : ageMin !== null && ageMin >= ELAPSED_WARN_MIN
                ? 'border-amber-400 bg-amber-50/70'
                : 'border-slate-200 bg-white shadow-card'
        }`}
      >
        <OrderBindingNotice order={o} />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* 受付番号 (受け渡し照合用・客の完了画面と同じコード)。 */}
            <p className="text-xs font-medium text-slate-500">
              {t('orderNo')} #{o.orderId}
            </p>
            {o.table && <p className="text-base font-bold text-slate-900">{o.table}</p>}
            <p className="text-xs text-slate-500">{chainLabel(o.chainId)}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-right">
            {o.feeUncollected ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800">
                {t('feeUncollectedBadge')}
              </span>
            ) : null}
            {ageMin !== null && ageMin >= 1 ? (
              <span
                className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold ${
                  ageMin >= ELAPSED_LATE_MIN
                    ? 'bg-red-100 text-red-700'
                    : ageMin >= ELAPSED_WARN_MIN
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-500'
                }`}
              >
                <Clock className="h-3 w-3" aria-hidden /> {tF('elapsed', { m: ageMin })}
              </span>
            ) : null}
            <span
              className={
                amountWarning
                  ? 'rounded-lg border border-amber-300 bg-amber-50 px-2 py-1'
                  : ''
              }
            >
              {amountWarning ? (
                <span className="block text-[10px] font-semibold text-slate-500">
                  {t('onChainAmount')}
                </span>
              ) : null}
              <span className="text-base font-bold text-slate-900">
                {formattedAmount}
              </span>{' '}
              <span className="text-[10px] font-medium text-slate-500">JPYC</span>
              {/* 店舗の値引き (受注時に公開設定から計算・金額が合う注文だけ)。実着金が明細の合計より少ない理由。 */}
              {o.discount ? (
                <span className="block text-[10px] font-semibold text-rose-700">
                  {t('discountApplied', { amount: groupAmountDigits(formatUnits(BigInt(o.discount), JPYC_DECIMALS)) })}
                </span>
              ) : null}
            </span>
          </div>
        </div>
        {amountWarning ? (
          <div className="mt-2">
            <span className={`inline-flex rounded-md px-2 py-1 text-xs font-bold ${amountWarningClass}`}>
              {amountWarning}
            </span>
            {formattedDeclaredAmount !== null ? (
              <span className="mt-1 block text-xs font-semibold text-slate-600">
                {t('declaredAmount')}: {formattedDeclaredAmount} JPYC
              </span>
            ) : null}
          </div>
        ) : null}
        {o.items.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
            {o.items.map((it, i) => (
              <li key={i} className="truncate">
                {it.name} × {it.qty}
              </li>
            ))}
          </ul>
        )}
        {o.customerMemo ? (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-800">{t('customerMemoLabel')}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
              {o.customerMemo}
            </p>
          </div>
        ) : null}
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
            onClick={() => fulfill.mutate({ txHash: o.txHash, fulfilled: !done })}
            disabled={fulfill.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50"
          >
            {done ? (
              <>
                <RotateCcw className="h-4 w-4" aria-hidden /> {t('unfulfill')}
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('markFulfilled')}
              </>
            )}
          </button>
        </div>
      </li>
    );
  };

  const orders = feed.data ?? [];
  const active = orders.filter((o) => !o.fulfilled);
  const done = orders.filter((o) => o.fulfilled);

  const calls = callFeed.calls.data ?? [];
  const countReady = !feed.isLoading && !feed.isError;
  // 完了の流れの案内 (飲食は厨房→ホールで配膳済みにすると自動で対応済み)。
  const completionHint = env.enableOrderFulfillment ? t('completionHintRestaurant') : t('completionHintRetail');

  return (
    <div className="space-y-4">
      {!isSignedIn ? (
        <div className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
          <SignInGate statement={t('signInStatement')} cta={t('signIn')} prompt={t('signInPrompt')} />
        </div>
      ) : (
        <>
          {/* 先頭の要約: 未対応の件数・呼び出し・更新、飲食店は厨房/ホールへ (タブのバッジと同じ受注フィードを数える)。 */}
          {env.enableOrderRelay && (
            <section
              aria-labelledby="orders-open-heading"
              className="rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
            >
              <div className="flex items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <h2 id="orders-open-heading" className="text-sm font-semibold text-slate-700">
                    {t('openHeading')}
                  </h2>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-slate-500">
                    <span>
                      {countReady
                        ? t.rich('openCount', {
                            count: active.length,
                            n: (chunks) => (
                              <span className="text-3xl font-bold tabular-nums text-slate-900">{chunks}</span>
                            ),
                          })
                        : '—'}
                    </span>
                    {env.enableOrderCall && calls.length > 0 ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        {t('callsChip', { count: calls.length })}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      void feed.refetch();
                      if (env.enableOrderCall) void callFeed.calls.refetch();
                    }}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-brand hover:bg-brand/5"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden /> {t('refresh')}
                  </button>
                  <p className="mt-0.5 text-[11px] text-slate-500">{t('autoRefresh')}</p>
                </div>
              </div>
              {/* 飲食店向け: 厨房モニター / ホール配膳 への直接導線。店員用リンク (受注閲覧トークン) を配る
                  運用では不要なので、enableOrderToken OFF のときだけ出す (token ON ではトークンパネルが導線)。 */}
              {env.enableOrderFulfillment && !env.enableOrderToken && (
                <div className="grid grid-cols-2 gap-2 border-t border-slate-100 px-5 py-3">
                  <a
                    href={`/${locale}/orders/kitchen`}
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand-dark"
                  >
                    <ChefHat className="h-4 w-4" aria-hidden /> {tF('kitchenTitle')}
                  </a>
                  <a
                    href={`/${locale}/orders/hall`}
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand-dark"
                  >
                    <UtensilsCrossed className="h-4 w-4" aria-hidden /> {tF('hallTitle')}
                  </a>
                </div>
              )}
            </section>
          )}
          {/* 店員用リンク (受注閲覧トークン)。オーナーが発行し、店員端末は資金鍵なしで厨房/ホールへ。 */}
          {env.enableOrderToken && <OrderOperatorTokenPanel sessionAddress={sessionAddress} />}
          {/* 受注フィード本体は enableOrderRelay のときだけ描画 (shop-live 単独では営業中の操作のみ)。 */}
          {env.enableOrderRelay && (
            <>
              {env.enableOrderCall ? (
                <OrderCallSection
                  calls={calls}
                  subject={sessionAddress}
                  enabled={isSignedIn && !callFeed.calls.isLoading && !callFeed.calls.isError}
                  isLoading={callFeed.calls.isLoading}
                  isError={callFeed.calls.isError || callFeed.resolve.isError}
                  isPending={callFeed.resolve.isPending}
                  onResolve={(id) => callFeed.resolve.mutate(id)}
                  onNewCalls={() => {
                    if (isOrderAlertSoundEnabled()) playNewOrderChime();
                  }}
                  hideWhenEmpty
                />
              ) : null}

              {feed.isError ? (
                <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {t('loadError')}
                </p>
              ) : feed.isLoading ? (
                <p className="text-center text-sm text-slate-500">{t('loading')}</p>
              ) : (
                <>
                  {active.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center">
                      <p className="text-sm font-medium text-slate-600">{t('empty')}</p>
                      {onOpenMobileOrder ? (
                        <>
                          <p className="mt-1 text-xs text-slate-500">{t('emptyHint')}</p>
                          <button
                            type="button"
                            onClick={onOpenMobileOrder}
                            className="mt-3 inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand-dark"
                          >
                            {t('openMobileOrder')}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      {/* 明細/テーブルは顧客申告・金額はオンチェーン検証済み (advisory 原則の明示・一覧に 1 回)。 */}
                      <p className="text-[11px] text-slate-500">{t('claimedNote')}</p>
                      <ul className="grid gap-3 lg:grid-cols-2 lg:items-start">{active.map((o) => renderCard(o, false))}</ul>
                    </>
                  )}

                  {/* 対応済み: 削除でなく折りたたみで保持 (誤操作は「未対応に戻す」で復旧)。 */}
                  {done.length > 0 && (
                    <details className="rounded-2xl bg-white px-4 py-3 shadow-card ring-1 ring-slate-200/70">
                      <summary className="cursor-pointer text-sm font-medium text-slate-600">
                        {t('fulfilledHeading')} ({done.length})
                      </summary>
                      <ul className="mt-3 grid gap-3 lg:grid-cols-2 lg:items-start">{done.map((o) => renderCard(o, true))}</ul>
                    </details>
                  )}
                </>
              )}
            </>
          )}
          {/* 営業中の操作 (売り切れ / 受付一時停止) は受注リストの下へ。頻度が低いので通常は閉じる (details)。 */}
          {env.enableShopLive && liveSelected?.storefront && (
            <details className="rounded-2xl bg-white px-4 py-3 shadow-card ring-1 ring-slate-200/70">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">
                {tLive('heading')}
              </summary>
              <div className="mt-2">
                {liveHandles.length > 1 && (
                  <select
                    value={liveSelected.handle}
                    onChange={(e) => setLiveSel(e.target.value)}
                    aria-label={tLive('heading')}
                    className="mb-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {liveHandles.map((hh) => (
                      <option key={hh.handle} value={hh.handle}>
                        @{hh.handle}
                      </option>
                    ))}
                  </select>
                )}
                <ShopLivePanel
                  handle={liveSelected.handle}
                  menu={liveSelected.storefront.menu}
                  hideHeading
                />
              </div>
            </details>
          )}
        </>
      )}

      {/* 末尾: 完了の流れの案内と、開示 (文言は変えない: 支払いと注文の結びつきの範囲・受注データの保存)。
          注文 (主役) を 1 画面目に出すため、読めば足りるものはここへ。 */}
      {env.enableOrderRelay && (
        <div className="space-y-2 pt-2">
          {isSignedIn ? <p className="text-xs text-slate-500">{completionHint}</p> : null}
          <p className="text-xs text-slate-500">{t('disclosure')}</p>
        </div>
      )}
    </div>
  );
}
