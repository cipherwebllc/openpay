'use client';

// チップ金額プリセットの編集 (token ごと独立のボタン編集 UI)。状態は持たない — 設定は親の TipEmbedGenerator が
// 持ち、ここは setSettings で現 token のサブリストだけを書き換える (QR レジ金額と同型)。

import { useTranslations } from 'next-intl';
import { Field } from '@/components/Field';
import { truncateAmount } from '@/lib/amount';
import type { TokenDeployment } from '@/lib/tokens';
import {
  DEFAULT_TIP_PRESETS,
  sanitizeTipPresetLabel,
  TIP_PRESET_MAX,
} from '@/lib/url';
import { TIP_INPUT_CLASS, type SetTipSettings, type TipSettings } from './shared';

export function PresetsField({
  settings,
  setSettings,
  deployment,
}: {
  settings: TipSettings;
  setSettings: SetTipSettings;
  deployment: TokenDeployment;
}) {
  const t = useTranslations('TipEmbedGenerator');

  // 現在 token のプリセットリスト (token ごと独立)。エディタ・適用ともこのリストだけ操作。
  const tokenPresets = settings.presets[settings.token];
  const tokenPresetLabels = settings.presetLabels[settings.token];

  // プリセット編集は現 token のサブリストだけを操作 (QR レジ金額と同型)。
  function updatePreset(idx: number, value: string) {
    setSettings((s) => ({
      ...s,
      presets: {
        ...s.presets,
        [s.token]: s.presets[s.token].map((p, i) =>
          i === idx ? truncateAmount(value, deployment.decimals) : p,
        ),
      },
    }));
  }

  function updatePresetLabel(idx: number, value: string) {
    // live 入力時点から URL と同じ単一パーサを通し、制御文字・`|`・12 code point 上限を
    // 保つ。HTML maxLength は UTF-16 単位なので絵文字を誤って短く数えるため使わない。
    const label = sanitizeTipPresetLabel(value, { trim: false }) ?? '';
    setSettings((s) => ({
      ...s,
      presetLabels: {
        ...s.presetLabels,
        [s.token]: s.presetLabels[s.token].map((current, i) =>
          i === idx ? label : current,
        ),
      },
    }));
  }

  function addPreset() {
    setSettings((s) => ({
      ...s,
      presets: { ...s.presets, [s.token]: [...s.presets[s.token], ''] },
      presetLabels: {
        ...s.presetLabels,
        [s.token]: [...s.presetLabels[s.token], ''],
      },
    }));
  }

  function removePreset(idx: number) {
    setSettings((s) => {
      const next = s.presets[s.token].filter((_, i) => i !== idx);
      const nextLabels = s.presetLabels[s.token].filter((_, i) => i !== idx);
      return {
        ...s,
        presets: { ...s.presets, [s.token]: next.length > 0 ? next : [''] },
        presetLabels: {
          ...s.presetLabels,
          [s.token]: next.length > 0 ? nextLabels : [''],
        },
      };
    });
  }

  const defaultPresetsList = DEFAULT_TIP_PRESETS[settings.token].join(', ');

  return (
    <Field label={t('presetsLabelWithSymbol', { symbol: deployment.displaySymbol })}>
      <div className="space-y-2">
        {tokenPresets.map((p, i) => (
          // 1 行に「金額・ラベル・×」(2 段に分けると 3 件で縦に長い)。通貨は見出しに 1 回。
          <div key={i} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={p}
              onChange={(e) => updatePreset(i, e.target.value)}
              placeholder={t('presetAmountPlaceholder')}
              aria-label={t('presetAmountItem', { n: i + 1, symbol: deployment.displaySymbol })}
              className={`${TIP_INPUT_CLASS} min-w-0 text-right tabular-nums`}
            />
            <input
              type="text"
              value={tokenPresetLabels[i] ?? ''}
              onChange={(e) => updatePresetLabel(i, e.target.value)}
              placeholder={t('presetLabelPlaceholder')}
              aria-label={t('presetLabelItem', { n: i + 1 })}
              className={`${TIP_INPUT_CLASS} min-w-0`}
            />
            <button
              type="button"
              onClick={() => removePreset(i)}
              aria-label={t('presetRemoveLabel', { n: i + 1 })}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:border-red-300 hover:text-red-600"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {tokenPresets.length < TIP_PRESET_MAX && (
        // 見た目は小さいまま、押せる範囲だけを 44px 以上に広げる (after の透明な面・「設定」と同じ)。
        <button
          type="button"
          onClick={addPreset}
          className="relative mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark after:absolute after:-inset-x-1 after:-inset-y-2 after:content-['']"
        >
          {t('presetAddButton')}
        </button>
      )}
      <p className="mt-1.5 text-xs text-slate-500">
        {t('presetsHint', { defaults: defaultPresetsList })}
      </p>
    </Field>
  );
}
