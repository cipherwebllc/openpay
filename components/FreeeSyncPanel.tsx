'use client';

// /history の freee 連携パネル。状態に応じて出し分ける:
//   未ログイン        → ウォレットログイン案内 (ログイン自体はヘッダの WalletBadge)
//   未連携            → 「freee と連携」(OAuth authorize へ全画面遷移)
//   連携済・未マッピング → 勘定科目/税区分 の選択 + 保存
//   連携済・マッピング済 → 「freee に同期 (N 件)」+ 結果 + マッピング変更
//
// 同期対象は表示中フィルタ後の income-sale (CSV と同じ filtered を受け取り、ここで再度
// isIncomeSaleEntry で件数を出す。サーバも runFreeeSync 内で再検証)。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { HistoryEntry } from '@/lib/history';
import { isIncomeSaleEntry } from '@/lib/historyFilters';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useEntitlement } from '@/hooks/useEntitlement';
import { tierAtLeast } from '@/lib/billing';
import { BillingPaywall } from './BillingPaywall';
import {
  useFreeeStatus,
  useFreeeMappingOptions,
  useFreeeMutations,
} from '@/hooks/useFreee';

export function FreeeSyncPanel({
  entries,
  usdcJpy,
}: {
  entries: HistoryEntry[];
  usdcJpy: number | undefined;
}) {
  const t = useTranslations('FreeeSync');
  const { isSignedIn } = useSiweSession();
  const status = useFreeeStatus(isSignedIn);
  const entitlement = useEntitlement(isSignedIn);
  const { saveMapping, sync } = useFreeeMutations();
  const [editingMapping, setEditingMapping] = useState(false);

  const incomeEntries = useMemo(
    () => entries.filter(isIncomeSaleEntry),
    [entries],
  );
  // freee は pro 利用権が必要。ロード中は true 既定 (gate のチラつき回避)。最終拒否は
  // サーバ (402) が担保。bypass(アルファ) は全通過。
  const proEntitled = entitlement.data
    ? entitlement.data.bypass || tierAtLeast(entitlement.data.tier, 'pro')
    : true;

  function startConnect() {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/api/freee/authorize?returnTo=${encodeURIComponent(returnTo)}`;
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-bold text-slate-900">{t('title')}</h3>

      {!isSignedIn ? (
        <p className="mt-2 text-xs text-slate-500">{t('signInRequired')}</p>
      ) : status.isLoading ? (
        <p className="mt-2 text-xs text-slate-400">…</p>
      ) : status.isError || !status.data ? (
        <p className="mt-2 text-xs text-red-600">{t('loadError')}</p>
      ) : !status.data.connected ? (
        <button
          type="button"
          onClick={startConnect}
          className="mt-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark"
        >
          {t('connectCta')}
        </button>
      ) : (
        <div className="mt-2 space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-xs text-emerald-700">
            <span className="font-medium">{t('connected')}</span>
            {status.data.companyName && (
              <span className="text-slate-500">
                {t('companyLabel', { name: status.data.companyName })}
              </span>
            )}
          </p>

          {!status.data.mappingSet || editingMapping ? (
            <MappingEditor
              onSaved={() => setEditingMapping(false)}
              save={(m) => saveMapping.mutateAsync(m)}
              saving={saveMapping.isPending}
              saveError={saveMapping.isError}
            />
          ) : !proEntitled ? (
            // pro 未加入 → freee 連携の利用料 paywall (basic からのアップグレード導線)。
            <BillingPaywall requiredTier="pro" />
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                disabled={incomeEntries.length === 0 || sync.isPending}
                onClick={() =>
                  void sync
                    .mutateAsync({ entries: incomeEntries, usdcJpy })
                    .catch(() => undefined)
                }
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sync.isPending
                  ? t('syncing')
                  : t('syncCta', { count: incomeEntries.length })}
              </button>
              <button
                type="button"
                onClick={() => setEditingMapping(true)}
                className="ml-2 text-[11px] text-slate-500 underline hover:text-slate-700"
              >
                {t('editMapping')}
              </button>

              {incomeEntries.length === 0 && (
                <p className="text-[11px] text-slate-400">{t('noIncome')}</p>
              )}
              {sync.data && (
                <p className="text-[11px] text-slate-600">
                  {t('syncDone', {
                    synced: sync.data.synced,
                    skipped: sync.data.skipped,
                    errored: sync.data.errored,
                  })}
                  {sync.data.rateUnavailable > 0 &&
                    t('syncRateNote', { count: sync.data.rateUnavailable })}
                </p>
              )}
              {sync.isError && (
                <p className="text-[11px] text-red-600">
                  {(sync.error as Error)?.message === 'entitlement_required'
                    ? t('entitlementRequired')
                    : t('syncError')}
                </p>
              )}
              <p className="text-[11px] text-slate-400">{t('draftNote')}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MappingEditor({
  onSaved,
  save,
  saving,
  saveError,
}: {
  onSaved: () => void;
  save: (m: { accountItemId: number; taxCode: number }) => Promise<unknown>;
  saving: boolean;
  saveError: boolean;
}) {
  const t = useTranslations('FreeeSync');
  // MappingEditor は連携済・未マッピング/編集中のみ mount されるので常に fetch してよい。
  const options = useFreeeMappingOptions(true);
  const [accountItemId, setAccountItemId] = useState<number | ''>('');
  const [taxCode, setTaxCode] = useState<number | ''>('');

  const data = options.data;
  if (options.isLoading) {
    return <p className="text-[11px] text-slate-400">…</p>;
  }
  if (options.isError || !data) {
    return <p className="text-[11px] text-red-600">{t('connectError')}</p>;
  }

  // 初期選択は「既存マッピング > 名前一致の推定 (売上高 / 課税売上10%) > 空」。ユーザが
  // ドロップダウンで確認/変更して保存する (推定は確定ではなく既定値の提案)。
  const resolvedAccount =
    accountItemId !== ''
      ? accountItemId
      : data.mapping?.accountItemId ?? guessAccountItem(data.accountItems);
  const resolvedTax =
    taxCode !== '' ? taxCode : data.mapping?.taxCode ?? guessTaxCode(data.taxCodes);

  const canSave = resolvedAccount !== '' && resolvedTax !== '';

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">{t('mappingRequired')}</p>
      <label className="block text-[11px] text-slate-600">
        {t('accountItemLabel')}
        <select
          value={resolvedAccount}
          onChange={(e) => setAccountItemId(Number(e.target.value))}
          className="mt-0.5 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
        >
          <option value="">—</option>
          {data.accountItems.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[11px] text-slate-600">
        {t('taxCodeLabel')}
        <select
          value={resolvedTax}
          onChange={(e) => setTaxCode(Number(e.target.value))}
          className="mt-0.5 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
        >
          <option value="">—</option>
          {data.taxCodes.map((tax) => (
            <option key={tax.code} value={tax.code}>
              {tax.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!canSave || saving}
        onClick={() =>
          void save({
            accountItemId: Number(resolvedAccount),
            taxCode: Number(resolvedTax),
          })
            .then(onSaved)
            .catch(() => undefined)
        }
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-50"
      >
        {t('saveMapping')}
      </button>
      {saveError && (
        <p className="text-[11px] text-red-600">{t('connectError')}</p>
      )}
    </div>
  );
}

// freee の勘定科目/税区分を名前一致で初期推定する (確定ではなく既定値の提案)。
// 売上高 完全一致 > '売上' 部分一致 の順。見つからなければ空 (ユーザが手動選択)。
function guessAccountItem(items: ReadonlyArray<{ id: number; name: string }>): number | '' {
  const hit =
    items.find((a) => a.name === '売上高') ?? items.find((a) => a.name.includes('売上'));
  return hit?.id ?? '';
}

// 課税売上 かつ 10% を含む税区分 (課税売上10% 等) を既定にする。
function guessTaxCode(codes: ReadonlyArray<{ code: number; name: string }>): number | '' {
  const hit = codes.find((t) => t.name.includes('課税売上') && t.name.includes('10'));
  return hit?.code ?? '';
}
