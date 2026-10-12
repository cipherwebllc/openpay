'use client';

// 料金ページの計算機。金額を 1 つ入れると、4 つの場面の分け方を同時に出す。
// 式は lib/pricingMath.ts (計算例の表・本物の分配の関数と同じ式・tests/lib/pricingExamples.test.ts が照合)。
// 料率は server (page) が lib/legal.ts の DISCLOSED_* から組み立てて props で渡す (client は lib/legal を読まない)。
//
// 見せ方: お店が払う場面は「引き算」(支払い − 利用料 = お店の受け取り)・買い手が払う場面は「足し算」
// (価格 + x402 利用料 = 買い手の支払い)。料金の数字は払う人の色 (LP の負担者ピルと同じ)。
// 演算子は文字のまま読ませる (「1,000 − 10 = 990」と読み上げられる)。aria-label は付けない (掟 8)。

import { useId, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import type { PricingCalcCopy, PricingCalcMode } from '@/lib/pricing';
import {
  digitalWith,
  formatJpycWei,
  gaslessUnavailableUpToWeiWith,
  gaslessWith,
  jpycToWei,
  mobileFeeWith,
  type PricingExample,
  type PricingRates,
} from '@/lib/pricingMath';
import { PAYER_TONE, PayerPill } from '@/components/pricing/PayerPill';

// 8 桁 (99,999,999 JPYC) まで。スマホの幅で式の 3 つの数字が 1 行に収まる上限。
const MAX_DIGITS = 8;

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function onlyDigits(text: string): string {
  return text.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, MAX_DIGITS);
}

type Result =
  | { kind: 'equation'; example: PricingExample; op: '−' | '+'; left: bigint; right: bigint; alt?: PricingExample }
  | { kind: 'unavailable' };

function resultFor(mode: PricingCalcMode, rates: PricingRates, amountWei: bigint): Result {
  switch (mode.id) {
    case 'gasless': {
      if (amountWei <= gaslessUnavailableUpToWeiWith(rates)) return { kind: 'unavailable' };
      const e = gaslessWith(rates, amountWei);
      return { kind: 'equation', example: e, op: '−', left: e.payerPaysWei, right: e.receiverGetsWei };
    }
    case 'storefront': {
      const e = mobileFeeWith(amountWei, rates.storefrontBps, 'shop');
      return { kind: 'equation', example: e, op: '−', left: e.amountWei, right: e.receiverGetsWei };
    }
    case 'preorder': {
      const e = mobileFeeWith(amountWei, rates.preorderBps, 'shop');
      const alt = mobileFeeWith(amountWei, rates.preorderBps, 'customer');
      return { kind: 'equation', example: e, op: '−', left: e.amountWei, right: e.receiverGetsWei, alt };
    }
    case 'digital': {
      const e = digitalWith(rates, amountWei);
      return { kind: 'equation', example: e, op: '+', left: e.amountWei, right: e.payerPaysWei };
    }
    default: {
      const unknown: never = mode.id;
      return unknown;
    }
  }
}

// 式の 1 項。スマホは明細のように縦に積み (演算子・名前・右寄せの数字)、md 以上は 3 列の横の式にする
// (名前の下に数字)。DOM は 1 つで並びだけを変える (大きな額でも数字が欄からはみ出さない)。
function Term({
  op,
  label,
  value,
  mark,
  emphasis,
  tone,
}: {
  op: string | null;
  label: string;
  value: string;
  mark?: string | null;
  emphasis?: boolean;
  tone?: string;
}) {
  return (
    <div
      className={`grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-1 md:grid-cols-[1rem_auto] md:grid-rows-[auto_auto] md:gap-y-1 md:py-0 ${
        emphasis ? 'mt-1 border-t border-slate-200 pt-2 md:mt-0 md:border-0 md:pl-2 md:pt-0' : ''
      }`}
    >
      <span className="text-base text-slate-500 md:row-span-2 md:self-end md:pb-0.5 md:text-lg">{op}</span>
      <span className="min-w-0 text-xs text-slate-500 md:col-start-2 md:whitespace-nowrap">
        {label}
        {mark ? (
          <span className="ml-1.5 inline-block rounded bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-600">
            {mark}
          </span>
        ) : null}
      </span>
      <span
        className={`whitespace-nowrap text-right tabular-nums leading-none md:col-start-2 md:text-left ${
          emphasis
            ? 'text-lg font-bold text-slate-900 md:text-xl'
            : `text-base font-semibold md:text-lg ${tone ?? 'text-slate-700'}`
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function PricingCalculator({
  copy,
  rates,
  presets,
  defaultAmount,
}: {
  copy: PricingCalcCopy;
  rates: PricingRates;
  presets: readonly number[];
  defaultAmount: number;
}) {
  const inputId = useId();
  const resultsId = useId();
  const [digits, setDigits] = useState(String(defaultAmount));
  const inputRef = useRef<HTMLInputElement>(null);
  // 桁区切りを入れ直してもカーソルが末尾へ飛ばないよう、カーソルより前の数字の数を覚えて戻す。
  const caretDigitsRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const want = caretDigitsRef.current;
    if (!input || want === null) return;
    caretDigitsRef.current = null;
    let seen = 0;
    let pos = 0;
    while (pos < input.value.length && seen < want) {
      if (/\d/.test(input.value[pos])) seen += 1;
      pos += 1;
    }
    input.setSelectionRange(pos, pos);
  }, [digits]);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { value, selectionStart } = event.target;
    caretDigitsRef.current = onlyDigits(value.slice(0, selectionStart ?? value.length)).length;
    setDigits(onlyDigits(value));
  };

  const amountWei = digits === '' ? null : jpycToWei(Number(digits));
  // 読み上げは 1 文だけ (4 つの式を毎回すべて読ませない): 「1,000 JPYC: ガスレス決済… お店の受け取り 990 / …」。
  const spoken =
    amountWei === null
      ? copy.emptyHint
      : `${groupDigits(digits)} ${copy.unit}: ${copy.modes
          .map((mode) => {
            const result = resultFor(mode, rates, amountWei);
            return result.kind === 'unavailable'
              ? `${mode.name} ${copy.unavailable}`
              : `${mode.name} ${mode.labels[2]} ${formatJpycWei(result.right)}`;
          })
          .join(' / ')}`;

  return (
    <div className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[auto_1fr] md:gap-x-8 md:gap-y-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-x-10">
        <div>
          <label htmlFor={inputId} className="text-sm font-semibold text-slate-900">
            {copy.amountLabel}
          </label>
          <div className="mt-2 flex items-center rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200 transition focus-within:bg-white focus-within:ring-2 focus-within:ring-brand">
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="done"
              aria-describedby={resultsId}
              placeholder={groupDigits(String(defaultAmount))}
              value={groupDigits(digits)}
              onChange={onChange}
              className="min-w-0 flex-1 bg-transparent py-3 pl-4 text-2xl font-bold tabular-nums text-slate-900 outline-none"
            />
            <span className="pr-4 text-sm font-semibold text-slate-500">{copy.unit}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 md:gap-1.5 lg:gap-2">
            <span className="text-xs text-slate-500">{copy.presetsLabel}</span>
            {presets.map((preset) => {
              const active = digits === String(preset);
              return (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDigits(String(preset))}
                  // hover はマウスのある端末だけ (タッチでは押した後に色が残るため)。
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold tabular-nums ring-1 ring-inset md:px-3 lg:px-4 ${
                    active
                      ? 'bg-brand text-white ring-brand'
                      : 'bg-white text-slate-700 ring-slate-200 [@media(hover:hover)]:hover:bg-slate-50'
                  }`}
                >
                  {groupDigits(String(preset))}
                </button>
              );
            })}
          </div>
        </div>

        <p id={resultsId} aria-live="polite" className="sr-only">
          {spoken}
        </p>
        <div className="md:col-start-2 md:row-span-2 md:row-start-1">
          {amountWei === null ? (
            <p className="flex min-h-32 items-center justify-center rounded-xl bg-slate-50 px-4 text-center text-sm text-slate-500">
              {copy.emptyHint}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {copy.modes.map((mode) => {
                const result = resultFor(mode, rates, amountWei);
                return (
                  <li key={mode.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="min-w-0 text-sm font-semibold text-slate-900">{mode.name}</h3>
                      <PayerPill payer={mode.payer} />
                    </div>
                    {result.kind === 'unavailable' ? (
                      <p className="mt-2 text-sm text-slate-500">{copy.unavailable}</p>
                    ) : (
                      <>
                        <div className="mt-2 md:mt-3 md:flex md:flex-wrap md:items-end md:gap-x-6 md:gap-y-2">
                          <Term op={null} label={mode.labels[0]} value={formatJpycWei(result.left)} />
                          <Term
                            op={result.op}
                            label={mode.labels[1]}
                            value={formatJpycWei(result.example.feeWei)}
                            mark={result.example.floorApplied ? copy.floorMark : null}
                            tone={PAYER_TONE[mode.payer.tone].focal}
                          />
                          <Term op="=" label={mode.labels[2]} value={formatJpycWei(result.right)} emphasis />
                        </div>
                        {result.alt ? (
                          <p className="mt-2 text-xs leading-relaxed text-slate-500">
                            {copy.preorderAltLead} {copy.preorderAltPayer}{' '}
                            <span className="font-semibold tabular-nums text-slate-700">
                              {formatJpycWei(result.alt.payerPaysWei)}
                            </span>
                            {copy.preorderAltSep}
                            {copy.preorderAltReceiver}{' '}
                            <span className="font-semibold tabular-nums text-slate-700">
                              {formatJpycWei(result.alt.receiverGetsWei)}
                            </span>
                          </p>
                        ) : null}
                        {mode.note ? <p className="mt-2 text-xs leading-relaxed text-slate-500">{mode.note}</p> : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {/* 最低額の説明。md 以上は入力の列の下 (空いている左の列)・スマホは結果の後ろ。 */}
        <p className="text-xs leading-relaxed text-slate-500 md:col-start-1 md:row-start-2">{copy.floorNote}</p>
      </div>
    </div>
  );
}
