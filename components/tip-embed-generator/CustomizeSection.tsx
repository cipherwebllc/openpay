'use client';

// 「表示をカスタマイズ」のカード (表示名・メッセージ・テーマ・色・金額プリセット・開発者向け設定)。状態は持たない —
// 設定は親の TipEmbedGenerator が持ち、ここは setSettings で書き換える。

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/Field';
import { HandleThemePicker } from '@/components/HandleThemePicker';
import { SectionCard } from '@/components/SectionCard';
import type { TokenDeployment } from '@/lib/tokens';
import { DevSettingsGroup } from './DevSettingsGroup';
import { PresetsField } from './PresetsField';
import {
  DEFAULT_PREVIEW_COLOR,
  TIP_INPUT_CLASS,
  TIP_TEXTAREA_CLASS,
  type SetTipSettings,
  type TipSettings,
} from './shared';

export function CustomizeSection({
  settings,
  setSettings,
  colorValid,
  deployment,
}: {
  settings: TipSettings;
  setSettings: SetTipSettings;
  colorValid: boolean;
  deployment: TokenDeployment;
}) {
  const t = useTranslations('TipEmbedGenerator');
  const tProfile = useTranslations('HandleProfile');
  return (
    <SectionCard title={t('step2Title')} headingId="tip-customize-heading" icon={Sparkles}>
      <div className="space-y-4">
        <Field label={t('nameLabel')} htmlFor="tip-name">
          <input
            id="tip-name"
            type="text"
            value={settings.name}
            onChange={(e) =>
              setSettings((s) => ({ ...s, name: e.target.value }))
            }
            placeholder={t('namePlaceholder')}
            maxLength={60}
            className={TIP_INPUT_CLASS}
          />
        </Field>

        <Field label={t('messageLabel')} htmlFor="tip-message">
          <textarea
            id="tip-message"
            value={settings.message}
            onChange={(e) =>
              setSettings((s) => ({ ...s, message: e.target.value }))
            }
            placeholder={t('messagePlaceholder')}
            maxLength={200}
            rows={2}
            className={TIP_TEXTAREA_CLASS}
          />
          <p className="mt-1 text-xs text-slate-500">
            {t('messageCounter', { count: settings.message.length })}
          </p>
        </Field>

        <HandleThemePicker
          accent={colorValid ? settings.color : DEFAULT_PREVIEW_COLOR}
          selected={settings.theme ?? 'clean'}
          onSelect={(theme) =>
            setSettings((current) => ({ ...current, theme }))
          }
          label={tProfile('themeLabel')}
          hint={tProfile('themeHint')}
        />

        <Field label={t('colorLabel')} htmlFor="tip-color">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={colorValid ? settings.color : DEFAULT_PREVIEW_COLOR}
              onChange={(e) =>
                setSettings((s) => ({ ...s, color: e.target.value }))
              }
              className="h-11 w-14 shrink-0 cursor-pointer rounded-md border border-slate-200 bg-white p-0.5"
            />
            <input
              id="tip-color"
              type="text"
              value={settings.color}
              onChange={(e) =>
                setSettings((s) => ({ ...s, color: e.target.value }))
              }
              placeholder={DEFAULT_PREVIEW_COLOR}
              className={`${TIP_INPUT_CLASS} min-w-0 flex-1 font-mono`}
            />
          </div>
          {settings.color && !colorValid && (
            <p className="mt-1 text-xs text-red-600">{t('colorInvalid')}</p>
          )}
        </Field>

        {/* チップ金額プリセット: token ごと独立のボタン編集 UI */}
        <PresetsField settings={settings} setSettings={setSettings} deployment={deployment} />
        {/* 開発者向け (成功画面の文・リンク) は任意なので閉じた折りたたみ。 */}
        <DevSettingsGroup settings={settings} setSettings={setSettings} />
      </div>
    </SectionCard>
  );
}
