'use client';

// 受注フルフィルメントの全画面ボード (Phase 3)。mode で 厨房 (調理) / ホール (配膳) を切替。
// - 厨房: 商品別「調理済み」トグル + 注文「対応済み」。
// - ホール: 調理済みは **青** (配膳待ちが一目で分かる) + 商品別「配膳済み」トグル + 注文「対応済み」。
// 受取ウォレットで SIWE サインイン → useOrderFeed (8s ポーリング・状態更新は op POST + kvEval 原子)。
// ルート (app/[locale]/orders/{kitchen,hall}) が env.enableOrderFulfillment でゲートしてマウントする。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useOrderFeed } from '@/hooks/useOrderFeed';
import { isJpycChainSlug, slugForChain } from '@/lib/chains';
import { JPYC_CHAIN_LABEL } from '@/lib/mobileOrder';
import { tokyoHHMM } from '@/lib/shopTime';
import type { StoredOrder } from '@/lib/orderRelay';

const JPYC_DECIMALS = 18;

function chainLabel(chainId: number): string {
  const slug = slugForChain(chainId);
  return slug && isJpycChainSlug(slug) ? JPYC_CHAIN_LABEL[slug] : `chain ${chainId}`;
}

export function OrderFulfillmentBoard({ mode }: { mode: 'kitchen' | 'hall' }) {
  const t = useTranslations('OrderFulfillment');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } = useSiweSession();
  // 稼働画面なので少し短めの 8s ポーリング。
  const { feed, update } = useOrderFeed(sessionAddress, isSignedIn, 8_000);
  // テーブル訂正 (setTable op)。編集中の注文 txHash + 入力ドラフト。
  const [editTx, setEditTx] = useState<string | null>(null);
  const [tableDraft, setTableDraft] = useState('');

  const orders = (feed.data ?? []).filter((o) => !o.fulfilled);

  const toggleItem = (o: StoredOrder, index: number, active: boolean) =>
    update.mutate({
      txHash: o.txHash,
      op:
        mode === 'kitchen'
          ? { kind: 'itemCooked', index, value: !active }
          : { kind: 'itemServed', index, value: !active },
    });
  // 注文「対応済み」(fulfill) は受注 (OrderFeedPanel) に集約。厨房/ホールは商品別の調理済み/配膳済み
  // だけを扱い、対応済み (= 両画面から消える) は受注で行う (厨房で押すとホールからも消える事故を回避)。

  if (!isSignedIn) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
        <p className="text-sm text-slate-600">{t('signInPrompt')}</p>
        <button
          type="button"
          onClick={() => void signIn(t('signInStatement')).catch(() => {})}
          disabled={isSigningIn}
          className="mt-3 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
        >
          {isSigningIn ? t('signingIn') : t('signIn')}
        </button>
        {signInError && <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">
          {mode === 'kitchen' ? t('kitchenTitle') : t('hallTitle')}
        </h1>
        <button
          type="button"
          onClick={() => feed.refetch()}
          className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t('refresh')}
        </button>
      </div>
      <p className="text-xs text-slate-400">{t('autoRefresh')}</p>
      {/* 状態更新 (op POST) の失敗 (409 競合枯渇 / KV / ネットワーク) を黙殺せず告知。 */}
      {update.isError && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {t('updateError')}
        </p>
      )}

      {feed.isError ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('loadError')}
        </p>
      ) : feed.isLoading ? (
        <p className="text-center text-sm text-slate-400">{t('loading')}</p>
      ) : orders.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-400">
          {t('empty')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orders.map((o) => (
            <li key={o.txHash} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-400">
                    {t('orderNo')} #{o.orderId}
                  </p>
                  {/* テーブル表示/訂正は店内 (table あり) のみ。テイクアウト (table 空) は非表示。 */}
                  {o.table ? (
                    editTx === o.txHash ? (
                    <div className="mt-0.5 flex items-center gap-1">
                      <input
                        value={tableDraft}
                        onChange={(e) => setTableDraft(e.target.value.slice(0, 64))}
                        aria-label={t('tableLabel')}
                        className="w-24 rounded border border-slate-300 px-2 py-0.5 text-sm focus:border-brand focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          update.mutate({
                            txHash: o.txHash,
                            op: { kind: 'setTable', table: tableDraft.trim() || null },
                          });
                          setEditTx(null);
                        }}
                        className="text-xs font-medium text-brand hover:underline"
                      >
                        {t('tableSave')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditTx(null)}
                        className="text-xs text-slate-400 hover:underline"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditTx(o.txHash);
                        setTableDraft(o.table ?? '');
                      }}
                      className="mt-0.5 flex items-center gap-1 text-left"
                    >
                      <span className="text-lg font-bold text-slate-900">{o.table}</span>
                      <span className="text-[10px] text-slate-400">{t('tableEdit')}</span>
                    </button>
                    )
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                  <span className="text-xs text-slate-400">{chainLabel(o.chainId)}</span>
                  {/* 受取予定時刻 (Phase 4・preorder のみ・flag ON かつ あるとき)。Asia/Tokyo HH:mm。
                      flag OFF では表示しない (= 手動 pickup_at が混入しても観測上 inert)。 */}
                  {env.enablePreorderTime && o.pickupAt ? (
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-700">
                      {t('pickupAt', { time: tokyoHHMM(o.pickupAt) })}
                    </span>
                  ) : null}
                </div>
              </div>

              <ul className="mt-2 flex-1 space-y-1">
                {o.items.length === 0 && (
                  <li className="text-sm text-slate-400">{t('noItems')}</li>
                )}
                {o.items.map((it, i) => {
                  const cooked = it.cooked === true;
                  const served = it.served === true;
                  const active = mode === 'kitchen' ? cooked : served;
                  // ホール: 調理済み (配膳待ち) は青で強調。配膳済みは done 表示。
                  const cls =
                    mode === 'hall'
                      ? served
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 line-through'
                        : cooked
                          ? 'border-sky-300 bg-sky-50 text-sky-700'
                          : 'border-slate-200 text-slate-400'
                      : cooked
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 line-through'
                        : 'border-slate-300 text-slate-700';
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => toggleItem(o, i, active)}
                        disabled={update.isPending}
                        aria-pressed={active}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${cls}`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {it.name} × {it.qty}
                        </span>
                        {active && <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-3">
                <span className="text-xs text-slate-400">
                  {formatUnits(BigInt(o.amount), JPYC_DECIMALS)} JPYC
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-slate-400">{t('claimedNote')}</p>
    </div>
  );
}
