'use client';

// 受注フルフィルメントの 1 カード (OrderFulfillmentBoard から抽出)。厨房/ホール共通の受注カード。
// 親は 30s tick (経過時間) と 8s フィードポーリングで頻繁に再レンダーするため、React.memo + カスタム
// 比較で「このカード自身の表示入力が変わったときだけ」再レンダーする。raw な now は渡さず、親が算出した
// ageMin (表示分) を渡す = tick で表示分が変わらない限り再レンダーしない。テーブル訂正の入力ドラフトは
// 編集中の当該カードだけ描画に影響する (他カードは draft 変化で再レンダーしない)。

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { Bell, CheckCircle2, Clock, RotateCcw } from 'lucide-react';
import { env } from '@/lib/env';
import { jpycChainLabel } from '@/lib/mobileOrder';
import { tokyoHHMM } from '@/lib/shopTime';
import { declaredItemsTotalMinor, type StoredOrder } from '@/lib/orderRelay';

const JPYC_DECIMALS = 18;
// 経過時間バッジの色しきい値 (分)。受信からの経過でホール/厨房が遅れを察知する。
export const ELAPSED_WARN_MIN = 10; // これ以上で黄
export const ELAPSED_LATE_MIN = 20; // これ以上で赤

// 受取チェーンの表示名 (bare "Polygon")。OrderFeedPanel は "JPYC (...)" 形式で別 (jpycChainLabel を共有)。
function chainLabel(chainId: number): string {
  return jpycChainLabel(chainId) ?? `chain ${chainId}`;
}

export type OrderCardProps = {
  order: StoredOrder;
  mode: 'kitchen' | 'hall';
  // 折りたたみ「調理済み/配膳済み」セクション側 (淡色・ボタンは「戻す」)。
  inDone: boolean;
  isNew: boolean; // 新着 (点滅) — 折りたたみ側は対象外 (親が算出)
  ageMin: number | null; // 受信からの経過分 (null=不明)。親が now から算出 (memo のため raw now は渡さない)。
  pickupUrgency: 'normal' | 'soon' | 'late'; // 受取時刻の緊急度。親が now から算出 (raw now は渡さない)。
  hallReady: boolean; // お渡し準備完了通知済み (ホール・flag ENABLE_ORDER_PICKUP)
  showMarkReady: boolean; // 「準備完了(通知)」ボタンを出す (ホール・ready 前)
  readyToServe: boolean; // 全品 調理済み (= 配膳準備OK の素材)
  isPending: boolean; // op POST 中 (ボタン disable)
  isEditingTable: boolean; // このカードのテーブル訂正が編集中
  tableDraft: string; // テーブル訂正の入力ドラフト (編集中カードのみ意味を持つ)
  onToggleItem: (index: number, on: boolean) => void;
  onSetStationDone: (value: boolean) => void;
  onMarkReady: (value: boolean) => void;
  onStartEditTable: () => void;
  onTableDraftChange: (value: string) => void;
  onSaveTable: () => void;
  onCancelEditTable: () => void;
};

function OrderCardInner({
  order: o,
  mode,
  inDone,
  isNew,
  ageMin,
  pickupUrgency,
  hallReady,
  showMarkReady,
  readyToServe,
  isPending,
  isEditingTable,
  tableDraft,
  onToggleItem,
  onSetStationDone,
  onMarkReady,
  onStartEditTable,
  onTableDraftChange,
  onSaveTable,
  onCancelEditTable,
}: OrderCardProps) {
  const t = useTranslations('OrderFulfillment');
  const doneBtnLabel = mode === 'kitchen' ? t('cookedDoneBtn') : t('servedDoneBtn');
  const undoBtnLabel = mode === 'kitchen' ? t('cookedUndo') : t('servedUndo');
  const amountWarning = o.amountMismatch
    ? t('amountMismatchBadge')
    : o.amountUnchecked
      ? t('amountUncheckedBadge')
      : null;
  const amountWarningClass = o.amountMismatch
    ? 'bg-red-600 text-white'
    : 'border border-amber-300 bg-amber-50 text-amber-800';
  const formattedAmount = formatUnits(BigInt(o.amount), JPYC_DECIMALS);
  const declaredAmount = o.amountMismatch
    ? declaredItemsTotalMinor(o.items, JPYC_DECIMALS)
    : null;
  const formattedDeclaredAmount =
    declaredAmount !== null ? formatUnits(declaredAmount, JPYC_DECIMALS) : null;
  return (
    <li
      className={`flex flex-col rounded-2xl border p-3 transition ${
        isNew
          ? 'animate-pulse border-amber-400 bg-white ring-2 ring-amber-300'
          : inDone
            ? 'border-slate-200 bg-white opacity-70'
            : ageMin !== null && ageMin >= ELAPSED_LATE_MIN
              ? 'border-red-400 bg-red-50/60'
              : ageMin !== null && ageMin >= ELAPSED_WARN_MIN
                ? 'border-amber-400 bg-amber-50/70'
                : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-400">
            {t('orderNo')} #{o.orderId}
          </p>
          {/* テーブル表示/訂正は店内 (table あり) のみ。テイクアウト (table 空) は非表示。 */}
          {o.table ? (
            isEditingTable ? (
              <div className="mt-0.5 flex items-center gap-1">
                <input
                  value={tableDraft}
                  onChange={(e) => onTableDraftChange(e.target.value.slice(0, 64))}
                  aria-label={t('tableLabel')}
                  className="w-24 rounded border border-slate-300 px-2 py-0.5 text-sm focus:border-brand focus:outline-none"
                />
                <button
                  type="button"
                  onClick={onSaveTable}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {t('tableSave')}
                </button>
                <button
                  type="button"
                  onClick={onCancelEditTable}
                  className="text-xs text-slate-400 hover:underline"
                >
                  {t('cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onStartEditTable}
                className="mt-0.5 flex items-center gap-1 text-left"
              >
                <span className="text-lg font-bold text-slate-900">{o.table}</span>
                <span className="text-[10px] text-slate-400">{t('tableEdit')}</span>
              </button>
            )
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {/* 新着 (ポーリングで届いた直後・点滅中)。 */}
          {isNew ? (
            <span className="rounded bg-amber-400 px-1.5 py-0.5 text-xs font-bold text-white">
              {t('newBadge')}
            </span>
          ) : null}
          {amountWarning ? (
            <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${amountWarningClass}`}>
              {amountWarning}
            </span>
          ) : null}
          {/* 受信からの経過時間。10分で黄・20分で赤 (遅れを察知)。折りたたみ側は出さない。 */}
          {!inDone && ageMin !== null && ageMin >= 1 ? (
            <span
              className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold ${
                ageMin >= ELAPSED_LATE_MIN
                  ? 'bg-red-100 text-red-700'
                  : ageMin >= ELAPSED_WARN_MIN
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-100 text-slate-500'
              }`}
            >
              <Clock className="h-3 w-3" aria-hidden /> {t('elapsed', { m: ageMin })}
            </span>
          ) : null}
          {/* お渡し準備完了通知済み = 顧客に通知し受取待ち (受け渡し前の独立状態)。readyToServe より優先。 */}
          {hallReady && !inDone ? (
            <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-xs font-bold text-white">
              {t('notifiedAwaitingPickup')}
            </span>
          ) : null}
          {/* ホール: 全品 調理済み = 厨房完了 → 「配膳準備OK」(配膳待ちが一目で分かる)。通知済みなら出さない。 */}
          {mode === 'hall' && !inDone && readyToServe && !hallReady ? (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold text-emerald-700">
              {t('readyToServe')}
            </span>
          ) : null}
          <span className="text-xs text-slate-400">{chainLabel(o.chainId)}</span>
          {/* 受取予定時刻 (Phase 4・preorder のみ・flag ON かつ あるとき)。Asia/Tokyo HH:mm。 */}
          {env.enablePreorderTime && o.pickupAt ? (
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                pickupUrgency === 'late'
                  ? 'bg-red-100 text-red-700'
                  : pickupUrgency === 'soon'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-sky-100 text-sky-700'
              }`}
            >
              {t('pickupAt', { time: tokyoHHMM(o.pickupAt) })}
            </span>
          ) : null}
        </div>
      </div>

      <ul className="mt-2 flex-1 space-y-1">
        {o.items.length === 0 && <li className="text-sm text-slate-400">{t('noItems')}</li>}
        {o.items.map((it, i) => {
          const cooked = it.cooked === true;
          const served = it.served === true;
          const itemDone = mode === 'kitchen' ? cooked : served;
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
                onClick={() => onToggleItem(i, itemDone)}
                disabled={isPending}
                aria-pressed={itemDone}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${cls}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {it.name} × {it.qty}
                </span>
                {itemDone && <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span
          className={
            amountWarning
              ? 'rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-right'
              : 'text-xs text-slate-400'
          }
        >
          {amountWarning ? (
            <span className="block text-[10px] font-semibold text-slate-500">
              {t('onChainAmount')}
            </span>
          ) : null}
          <span className={amountWarning ? 'text-sm font-bold text-slate-900' : ''}>
            {formattedAmount} JPYC
          </span>
          {formattedDeclaredAmount !== null ? (
            <span className="block text-[10px] font-semibold text-slate-500">
              {t('declaredAmount')}: {formattedDeclaredAmount} JPYC
            </span>
          ) : null}
        </span>
        {/* お渡し準備完了通知 (ホール・flag ON・ready 前): 顧客に「準備完了」を通知する 1 段目。 */}
        {showMarkReady ? (
          <button
            type="button"
            onClick={() => onMarkReady(true)}
            disabled={isPending}
            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Bell className="h-4 w-4" aria-hidden /> {t('markReadyBtn')}
          </button>
        ) : (
          /* 注文単位の完了/戻す。done 側は淡いセカンダリ、active 側は brand。通知済み active は「受け渡し済」。 */
          <button
            type="button"
            onClick={() => onSetStationDone(!inDone)}
            disabled={isPending}
            className={
              inDone
                ? 'flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand disabled:opacity-50'
                : 'flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-50'
            }
          >
            {inDone ? (
              <>
                <RotateCcw className="h-4 w-4" aria-hidden /> {undoBtnLabel}
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> {doneBtnLabel}
              </>
            )}
          </button>
        )}
      </div>
    </li>
  );
}

// memo 比較: このカード自身の表示入力が変わったときだけ再レンダー。raw now (親の 30s tick) は
// props に無く、代わりに ageMin を比較する = 表示分が変わらない tick では再レンダーしない。
// コールバックは order/mode に束縛され描画に依存しない (毎レンダー新規参照) ため比較しない。
function cardPropsEqual(a: OrderCardProps, b: OrderCardProps): boolean {
  return (
    a.order === b.order &&
    a.mode === b.mode &&
    a.inDone === b.inDone &&
    a.isNew === b.isNew &&
    a.ageMin === b.ageMin &&
    a.pickupUrgency === b.pickupUrgency &&
    a.hallReady === b.hallReady &&
    a.showMarkReady === b.showMarkReady &&
    a.readyToServe === b.readyToServe &&
    a.isPending === b.isPending &&
    a.isEditingTable === b.isEditingTable &&
    // tableDraft は編集中の当該カードだけ描画に影響する (他カードは draft 変化で再レンダーしない)。
    (!b.isEditingTable || a.tableDraft === b.tableDraft)
  );
}

export const OrderCard = memo(OrderCardInner, cardPropsEqual);
