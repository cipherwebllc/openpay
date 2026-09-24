'use client';

import {
  useMemo,
  useRef,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Coins } from 'lucide-react';
import { RecoverFeeNotice } from '../RecoverFeeNotice';
import { ChainChooser } from '../ChainChooser';
import { TokenChooser } from '../TokenChooser';
import { Field } from '../Field';
import { StepCard } from '../StepCard';
import { QuickAmountEditor } from './QuickAmountEditor';
import { ConvertPanel } from './ConvertPanel';
import { QUICK_AMOUNT_MAX, type QrSettings } from '@/hooks/useQrSettings';
import type { TokenDeployment, TokenSymbol } from '@/lib/tokens';
import { JPYC_CHAINS, USDC_CHAINS, type ChainSlug } from '@/lib/chains';
import type { GasMode } from '@/lib/fee';
import { normalizeAmountList, truncateAmount } from '@/lib/amount';

export type Mode = 'amount' | 'static';

type ConvertPanelProps = ComponentProps<typeof ConvertPanel>;

// ① 金額 (通貨 / 受取チェーン / 請求金額 / クイック金額 / FX 換算 / recover 手数料開示)。
// 金額・モード・FX・保存設定の状態と token/chain 切替は QrGenerator が持つ。ここは描画と、
// 現在の token のクイック金額サブリストの編集だけを行う。
export function QrAmountSection({
  settings,
  setSettings,
  deployment,
  mode,
  setMode,
  amount,
  setAmount,
  resetConvert,
  fiatHint,
  selectToken,
  selectChain,
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
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  deployment: TokenDeployment;
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  amount: string;
  setAmount: Dispatch<SetStateAction<string>>;
  resetConvert: () => void;
  fiatHint: string | null;
  selectToken: (tok: TokenSymbol) => void;
  selectChain: (slug: ChainSlug) => void;
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
    <StepCard step={1} icon={Coins} title={t('steps.amount')}>
      <div className="space-y-4">
        {/* token + chain は金額のシンボル表示にも影響するので金額と同じ① に。 */}
        <Field label={t('tokenLabel')}>
          <TokenChooser selected={settings.token} onSelect={selectToken} />
        </Field>

        <Field label={t('chainLabel')}>
          <ChainChooser
            slugs={settings.token === 'usdc' ? USDC_CHAINS : JPYC_CHAINS}
            selected={settings.chain}
            onSelect={selectChain}
            gridClassName={
              settings.token === 'usdc'
                ? 'grid grid-cols-2 gap-2 sm:grid-cols-3'
                : 'grid grid-cols-2 gap-2'
            }
          />
        </Field>

        <Field label={t('amountLabel', { symbol: deployment.displaySymbol })}>
          <div className="flex flex-col gap-2">
            <div className="inline-flex w-full rounded-lg border border-slate-200 bg-slate-100 p-1">
              {(
                [
                  ['amount', t('modeAmount')],
                  ['static', t('modeStatic')],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
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
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    mode === m
                      ? 'bg-white text-brand-dark shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* 非表示でも node を保持し、再表示で入力欄を作り直さない。 */}
            <div className="space-y-3" hidden={mode !== 'amount'}>
              {/* 金額ヒーロー: 入力欄を「表示器」化して数字を主役に。通貨記号は控えめな
                  接尾、その真下に参考円 (USDC のみ・JPYC は ¥ ペッグで冗長ゆえ非表示)。
                  枠線は container 側に寄せ、focus で brand + 浮き影。 */}
              <div className="rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-white to-brand/[0.03] px-5 py-4 transition focus-within:border-brand focus-within:shadow-card">
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
                  <span className="shrink-0 text-xl font-semibold text-slate-500">
                    {deployment.displaySymbol}
                  </span>
                </div>
                {fiatHint && (
                  <div className="mt-1 text-right text-sm font-medium text-slate-500">
                    {fiatHint}
                  </div>
                )}
              </div>
              {activeQuickAmounts.length > 0 && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {activeQuickAmounts.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => {
                        setAmount(q);
                        resetConvert();
                      }}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:border-brand hover:text-brand-dark hover:shadow-card active:translate-y-0"
                    >
                      {q} {deployment.displaySymbol}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {mode === 'static' && (
              <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">
                {t('staticHint')}
              </p>
            )}
          </div>
        </Field>

        {/* クイック金額の編集 (任意・token ごと独立)。金額入力の近くで設定できる
            よう高度な設定から①へ移設。 */}
        <QuickAmountEditor
          hidden={mode !== 'amount'}
          items={tokenQuickAmounts}
          max={QUICK_AMOUNT_MAX}
          onUpdate={updateQuickAmount}
          onAdd={addQuickAmount}
          onRemove={removeQuickAmount}
        />

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
      </div>
      <RecoverFeeNotice
        billAmount={recoverBillAmount}
        chainId={deployment.chainId}
        gasMode={recoverGasMode}
      />
    </StepCard>
  );
}
