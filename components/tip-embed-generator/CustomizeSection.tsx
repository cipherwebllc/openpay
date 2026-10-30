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
import { DEFAULT_PREVIEW_COLOR, type SetTipSettings, type TipSettings } from './shared';

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
        <Field label={t('nameLabel')}>
          <input
            type="text"
            value={settings.name}
            onChange={(e) =>
              setSettings((s) => ({ ...s, name: e.target.value }))
            }
            placeholder={t('namePlaceholder')}
            maxLength={60}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </Field>

        <Field label={t('messageLabel')}>
          <textarea
            value={settings.message}
            onChange={(e) =>
              setSettings((s) => ({ ...s, message: e.target.value }))
            }
            placeholder={t('messagePlaceholder')}
            maxLength={200}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
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

        <Field label={t('colorLabel')}>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={colorValid ? settings.color : DEFAULT_PREVIEW_COLOR}
              onChange={(e) =>
                setSettings((s) => ({ ...s, color: e.target.value }))
              }
              className="h-10 w-14 cursor-pointer rounded-md border border-slate-200 bg-white p-0.5"
            />
            <input
              type="text"
              value={settings.color}
              onChange={(e) =>
                setSettings((s) => ({ ...s, color: e.target.value }))
              }
              placeholder={DEFAULT_PREVIEW_COLOR}
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
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
