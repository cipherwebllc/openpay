'use client';

import {
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { RecoverFeeNotice } from '../RecoverFeeNotice';
import { QuickAmountEditor } from './QuickAmountEditor';
import { ConvertPanel } from './ConvertPanel';
import { QUICK_AMOUNT_MAX, type QrSettings } from '@/hooks/useQrSettings';
import type { TokenDeployment } from '@/lib/tokens';
import type { GasMode } from '@/lib/fee';
import { groupAmountDigits, normalizeAmountList, truncateAmount } from '@/lib/amount';

export type Mode = 'amount' | 'static';

type ConvertPanelProps = ComponentProps<typeof ConvertPanel>;

// 会計のカード (2026-10 磨き上げ P2): 先頭にお店の設定の要約 (header)、その下に金額を主役に置く
// (金額 / よく使う金額 / 他の通貨建て / 手数料の開示)。通貨・チェーン・受取先・支払い方法は「お店の設定」シートへ。
// 金額・モード・FX・保存設定の状態は QrGenerator が持つ。ここは描画と、いまの通貨のよく使う金額の編集だけ。
export function QrAmountSection({
  header,
  settings,
  setSettings,
  deployment,
  mode,
  setMode,
  amount,
  setAmount,
  resetConvert,
  fiatHint,
  rateHint,
  canShowConvert,
  rateOk,
  convert,
  convertExpired,
  convertRemaining,
  convertTargetDisplay,
  convertAnchorDisplay,
  applyConvert,
  recalcConvert,
  revertConvert,
  fxWarning,
  acknowledgeFxWarning,
  recoverBillAmount,
  recoverGasMode,
}: {
  /** カードの先頭 (お店の設定の要約)。 */
  header: ReactNode;
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  deployment: TokenDeployment;
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  amount: string;
  setAmount: Dispatch<SetStateAction<string>>;
  resetConvert: () => void;
  fiatHint: string | null;
  /** USDC のときの参考レート (例「1 USDC ≈ ¥158.19 (参考)」)。null なら出さない。 */
  rateHint: string | null;
  canShowConvert: boolean;
  rateOk: boolean;
  convert: ConvertPanelProps['convert'];
  convertExpired: boolean;
  convertRemaining: number;
  convertTargetDisplay: string;
  convertAnchorDisplay: string;
  applyConvert: () => void;
  recalcConvert: () => void;
  revertConvert: () => void;
  fxWarning: ConvertPanelProps['fxWarning'];
  acknowledgeFxWarning: () => void;
  recoverBillAmount: bigint | null;
  recoverGasMode: GasMode;
}) {
  const t = useTranslations('QrGenerator');
  const amountInputRef = useRef<HTMLInputElement>(null);
  const [editingQuick, setEditingQuick] = useState(false);

  // クイック金額は token (JPYC=円 / USDC=ドル) ごとに独立。エディタ・適用とも
  // 現在の token のサブリストだけを操作する。
  const tokenQuickAmounts = settings.quickAmounts[settings.token];

  function updateQuickAmount(idx: number, value: string) {
    setSettings((s) => ({
      ...s,
      quickAmounts: {
        ...s.quickAmounts,
        [s.token]: s.quickAmounts[s.token].map((q, i) =>
          i === idx ? truncateAmount(value, deployment.decimals) : q,
        ),
      },
    }));
  }

  function addQuickAmount() {
    setSettings((s) => ({
      ...s,
      quickAmounts: {
        ...s.quickAmounts,
        [s.token]: [...s.quickAmounts[s.token], ''],
      },
    }));
  }

  function removeQuickAmount(idx: number) {
    setSettings((s) => {
      const next = s.quickAmounts[s.token].filter((_, i) => i !== idx);
      return {
        ...s,
        quickAmounts: {
          ...s.quickAmounts,
          [s.token]: next.length > 0 ? next : [''],
        },
      };
    });
  }

  // 現在の token decimals に合わせて truncate してから表示・適用する。truncate 後に
  // 重複した値は除外 (例: 0.1234567890123 と 0.1234567890124 を保存 → USDC では
  // どちらも 0.123456 に潰れるので片方のみ残す)。
  const activeQuickAmounts = useMemo(
    () => normalizeAmountList(tokenQuickAmounts, deployment.decimals),
    [tokenQuickAmounts, deployment.decimals],
  );

  return (
    <section
      aria-labelledby="qr-amount-heading"
      className="rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 print:hidden"
    >
      <div className="border-b border-slate-100 px-5 py-4">{header}</div>
      <div className="space-y-4 px-5 pb-5 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="qr-amount-heading" className="text-sm font-semibold text-slate-700">
            {t('amountLabel', { symbol: deployment.displaySymbol })}
          </h2>
          {/* 金額指定 / 据え置き (金額なし) の切替。金額が主役なので小さく右に置く。 */}
          <div className="inline-flex shrink-0 rounded-full bg-slate-100 p-0.5">
            {(
              [
                ['amount', t('modeAmount')],
                ['static', t('modeStatic')],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  if (m === 'amount' && mode === 'static') {
                    // iOS のキーボードを開けるよう、表示を反映してからタップ中に focus する。
                    flushSync(() => setMode('amount'));
                    amountInputRef.current?.focus();
                  } else {
                    setMode(m);
                  }
                  resetConvert();
                }}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  mode === m
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 非表示でも node を保持し、再表示で入力欄を作り直さない。 */}
        <div className="space-y-4" hidden={mode !== 'amount'}>
          {/* 金額ヒーロー: 入力欄を「表示器」化して数字を主役に。通貨記号は控えめな接尾、
              その下に参考円とレート (USDC のみ・JPYC は ¥ ペッグで冗長ゆえ非表示)。 */}
          <div className="rounded-2xl bg-slate-50 px-5 py-4 ring-1 ring-slate-200 transition focus-within:bg-white focus-within:ring-2 focus-within:ring-brand">
            <div className="flex items-baseline gap-2">
              <input
                ref={amountInputRef}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(
                    truncateAmount(e.target.value, deployment.decimals),
                  );
                  resetConvert();
                }}
                placeholder={settings.token === 'jpyc' ? '1000' : '10.00'}
                aria-label={t('amountLabel', {
                  symbol: deployment.displaySymbol,
                })}
                className="min-w-0 flex-1 bg-transparent text-right text-4xl font-bold tabular-nums tracking-tight text-slate-900 placeholder:text-slate-300 focus:outline-none sm:text-5xl"
                autoFocus
              />
              <span className="shrink-0 text-lg font-semibold text-slate-500">
                {deployment.displaySymbol}
              </span>
            </div>
            {fiatHint && (
              <div className="mt-1 text-right text-sm font-medium text-slate-500">
                {fiatHint}
              </div>
            )}
            {rateHint && (
              <div className="mt-0.5 text-right text-xs text-slate-500">{rateHint}</div>
            )}
          </div>

          {/* よく使う金額: 1 行のチップ (通貨記号は金額欄に 1 度だけ・読み上げには付ける)。編集は右の小さなボタンから。 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">{t('quickAmountsTitle')}</span>
              <button
                type="button"
                onClick={() => setEditingQuick((v) => !v)}
                aria-expanded={editingQuick}
                className="text-xs font-semibold text-brand hover:underline"
              >
                {editingQuick ? t('quickAmountsDone') : t('quickAmountsEdit')}
              </button>
            </div>
            {activeQuickAmounts.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {activeQuickAmounts.map((q) => {
                  const selected = amount === q;
                  return (
                    <button
                      key={q}
                      type="button"
                      onClick={() => {
                        setAmount(q);
                        resetConvert();
                      }}
                      className={`truncate rounded-full border px-2 py-2 text-sm font-semibold tabular-nums transition ${
                        selected
                          ? 'border-brand bg-brand/5 text-brand-dark'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-brand hover:text-brand-dark'
                      }`}
                    >
                      {groupAmountDigits(q)}
                      <span className="sr-only"> {deployment.displaySymbol}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {editingQuick && (
              <QuickAmountEditor
                items={tokenQuickAmounts}
                max={QUICK_AMOUNT_MAX}
                onUpdate={updateQuickAmount}
                onAdd={addQuickAmount}
                onRemove={removeQuickAmount}
              />
            )}
          </div>
        </div>
        {mode === 'static' && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
            {t('staticHint')}
          </p>
        )}

        <ConvertPanel
          canShowConvert={canShowConvert}
          rateOk={rateOk}
          convert={convert}
          convertExpired={convertExpired}
          convertRemaining={convertRemaining}
          convertTargetDisplay={convertTargetDisplay}
          convertAnchorDisplay={convertAnchorDisplay}
          amount={amount}
          displaySymbol={deployment.displaySymbol}
          isUsdc={settings.token === 'usdc'}
          onApply={applyConvert}
          onRecalc={recalcConvert}
          onRevert={revertConvert}
          fxWarning={fxWarning}
          onAcknowledgeFxWarning={acknowledgeFxWarning}
        />

        <RecoverFeeNotice
          billAmount={recoverBillAmount}
          chainId={deployment.chainId}
          gasMode={recoverGasMode}
          tone="neutral"
        />
      </div>
    </section>
  );
}
