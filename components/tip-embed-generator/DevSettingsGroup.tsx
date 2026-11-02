'use client';

// 開発者向け設定 (成功画面の文・リンク)。任意なので閉じた折りたたみ。状態は持たない (設定は親の TipEmbedGenerator)。

import { Code2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/Field';
import { OptionalGroup } from '@/components/OptionalGroup';
import { TIP_INPUT_CLASS, TIP_TEXTAREA_CLASS, type SetTipSettings, type TipSettings } from './shared';

export function DevSettingsGroup({
  settings,
  setSettings,
}: {
  settings: TipSettings;
  setSettings: SetTipSettings;
}) {
  const t = useTranslations('TipEmbedGenerator');
  return (
    <OptionalGroup
      icon={Code2}
      title={t('devSettingsToggle')}
      filled={[settings.thanks, settings.thanksUrl].filter((v) => v.trim()).length}
      filledLabel={(count) => t('optionalFilled', { count })}
    >
      <Field label={t('thanksLabel')} htmlFor="tip-thanks">
        <textarea
          id="tip-thanks"
          value={settings.thanks}
          onChange={(e) =>
            setSettings((s) => ({ ...s, thanks: e.target.value }))
          }
          placeholder={t('thanksPlaceholder')}
          maxLength={200}
          rows={2}
          className={TIP_TEXTAREA_CLASS}
        />
        <p className="mt-1 text-xs text-slate-500">
          {t('messageCounter', { count: settings.thanks.length })}
        </p>
      </Field>

      <Field label={t('thanksUrlLabel')} htmlFor="tip-thanks-url">
        <input
          id="tip-thanks-url"
          type="text"
          value={settings.thanksUrl}
          onChange={(e) =>
            setSettings((s) => ({ ...s, thanksUrl: e.target.value }))
          }
          placeholder={t('thanksUrlPlaceholder')}
          className={`${TIP_INPUT_CLASS} font-mono`}
        />
        <p className="mt-1 text-xs text-slate-500">{t('thanksUrlHint')}</p>
      </Field>
    </OptionalGroup>
  );
}
