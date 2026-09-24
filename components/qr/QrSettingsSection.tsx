'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Fuel, Zap } from 'lucide-react';
import { Field } from '../Field';
import { SplitEditor } from './SplitEditor';
import { SettingsSummary } from './QrSummaries';
import type { QrSettings } from '@/hooks/useQrSettings';
import { crossChainAllowed } from '@/lib/url/shared';
import {
  SPLIT_MAX_ENTRIES,
  type SplitDraft,
  type SplitDraftsParseResult,
  type SplitEntry,
} from '@/lib/url';
import { isGaslessSupported, type TokenDeployment } from '@/lib/tokens';
import type { GasMode, PayMode } from '@/lib/fee';

// 高度な設定 (決済モード / ガス負担者 / 売上の自動分配 / 他チェーンからの受取)。
// 開閉状態と gas / split の導出 (URL に焼く値) は QrGenerator が持ち、ここは描画と
// 設定の編集だけを行う。
export function QrSettingsSection({
  settings,
  setSettings,
  deployment,
  accordionOpen,
  setAccordionOpen,
  effectiveGasMode,
  payMode,
  hideGasMode,
  isJpycRecover,
  isStandard,
  splitParsed,
  splitsForUrl,
}: {
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  deployment: TokenDeployment;
  accordionOpen: boolean;
  setAccordionOpen: Dispatch<SetStateAction<boolean>>;
  effectiveGasMode: GasMode;
  payMode: PayMode;
  hideGasMode: boolean;
  isJpycRecover: boolean;
  isStandard: boolean;
  splitParsed: SplitDraftsParseResult;
  splitsForUrl: SplitEntry[] | undefined;
}) {
  const t = useTranslations('QrGenerator');

  function setSplits(next: SplitDraft[]) {
    setSettings((s) => ({ ...s, splits: next }));
  }
  function addSplit() {
    // UI 側 ({splits.length < MAX && ...}) で button が消えるため通常 unreachable。
    if (settings.splits.length >= SPLIT_MAX_ENTRIES) return;
    setSplits([...settings.splits, { address: '', percent: '' }]);
  }
  function removeSplit(idx: number) {
    setSplits(settings.splits.filter((_, i) => i !== idx));
  }
  function updateSplit(idx: number, patch: Partial<SplitDraft>) {
    setSplits(
      settings.splits.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  }

  return (
    <SettingsAccordion
      open={accordionOpen}
      onToggle={() => setAccordionOpen((o) => !o)}
      summaryLabel={t('advancedSettings')}
      summary={
        <SettingsSummary
          gasMode={effectiveGasMode}
          payMode={payMode}
          showGasMode={!hideGasMode}
          jpycRecover={isJpycRecover}
        />
      }
    >
      <Field label={t('payModeLabel')}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['gasless', 'standard'] as PayMode[]).map((pm) => {
            const active = settings.payMode === pm;
            const isGasless = pm === 'gasless';
            const ModeIcon = isGasless ? Zap : Fuel;
            const iconColor = isGasless ? 'text-emerald-600' : 'text-amber-600';
            // gasless 非対応 chain (paymasterMode=unavailable) では gasless
            // button を disable。click は selectChain 側で防御済だが、UI
            // 上でも明示的に grey-out して standard 強制を視覚化する。
            const disabled = isGasless && !isGaslessSupported(deployment);
            return (
              <button
                key={pm}
                type="button"
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setSettings((s) => ({ ...s, payMode: pm }));
                }}
                className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                  disabled
                    ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-500'
                    : active
                    ? 'border-brand bg-brand/5 text-brand-dark'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <ModeIcon
                    className={`h-4 w-4 flex-none ${iconColor}`}
                    aria-hidden
                  />
                  <span>
                    {isGasless
                      ? t('payModeGaslessTitle')
                      : t('payModeStandardTitle')}
                  </span>
                  {isGasless && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                      {t('payModeGaslessBadge')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {isGasless
                    ? t('payModeGaslessDesc')
                    : settings.chain === 'arc' ? t('payModeArcDesc') : t('payModeStandardDesc')}
                </div>
              </button>
            );
          })}
        </div>
      </Field>

      {isStandard ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
          {settings.chain === 'arc' ? t('standardArcHint') : t('standardHint')}
        </div>
      ) : isJpycRecover ? (
        // JPYC recover は店舗が手数料を吸収する固定モデル (per-QR トグル撤去)。
        // 利用料の開示は直上 payModeGaslessDesc が担うため固定ヒントは出さない
        // (2026-07 user 指示で撤去)。gas トグルを出さない分岐だけ維持する。
        null
      ) : !hideGasMode ? (
        <Field label={t('gasLabel')}>
          <div className="grid grid-cols-2 gap-2">
            {(['customer', 'merchant'] as GasMode[]).map((g) => {
              const active = settings.gasMode === g;
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() =>
                    setSettings((s) => ({ ...s, gasMode: g }))
                  }
                  className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                    active
                      ? 'border-brand bg-brand/5 text-brand-dark'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <div className="font-semibold">
                    {g === 'customer'
                      ? t('gasCustomerTitle')
                      : t('gasMerchantTitle')}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {g === 'customer'
                      ? t('gasCustomerDesc')
                      : t('gasMerchantDesc')}
                  </div>
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      {!isStandard && (
        <SplitEditor
          splits={settings.splits}
          max={SPLIT_MAX_ENTRIES}
          sum={splitParsed.sum}
          error={splitParsed.error}
          summaryCount={splitsForUrl ? splitsForUrl.length : null}
          onUpdate={updateSplit}
          onAdd={addSplit}
          onRemove={removeSplit}
        />
      )}

      {/* Cross-chain 受信許可 toggle (USDC のみ意味あり、JPYC では disable)。
          Default ON。Off にすると PaymentForm が代替経路 hint を出さない
          (店主が「同一 chain で受け取りたい」と明示する用途)。 */}
      {settings.token === 'usdc' && crossChainAllowed(settings.chain) && (
        <AdvancedSection label={t('crossChainHeading')}>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={settings.crossChain}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  crossChain: e.target.checked,
                }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300"
            />
            <span className="text-xs">
              <span className="font-semibold text-slate-700">
                {t('crossChainToggleLabel')}
              </span>
              <span className="block text-slate-500">
                {t('crossChainToggleDescription')}
              </span>
            </span>
          </label>
        </AdvancedSection>
      )}

      {/* fee=0 のため徴収先 section は撤去 (Phase 1 alpha)。 */}
    </SettingsAccordion>
  );
}

function SettingsAccordion({
  open,
  onToggle,
  summary,
  summaryLabel,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  summaryLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white shadow-card ring-1 ring-slate-200/70">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex flex-1 flex-col">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {summaryLabel}
          </span>
          {!open && (
            <span className="mt-0.5 text-xs text-slate-600">{summary}</span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 flex-none text-slate-500 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-200 px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

function AdvancedSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-dashed border-slate-200 pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      {children}
    </div>
  );
}
