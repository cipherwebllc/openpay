'use client';

// プロフィールの任意のまとまり「高度な設定」(メッセージ・お礼の文・チップ後に表示するリンク)。状態は持たない —
// 下書きとその更新、戻り先 URL の検証結果 (公開を止める理由にも使う) は親の HandleProfileBuilder が持つ。

import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { OptionalGroup } from '@/components/OptionalGroup';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import { Field, inputClass, type DraftUpdate } from './fields';

export function AdvancedGroup({
  draft,
  update,
  invalidThanksUrl,
  callbackUrlError,
  filledAdvanced,
  filledLabel,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  invalidThanksUrl: boolean;
  callbackUrlError: string | undefined;
  filledAdvanced: number;
  filledLabel: (count: number) => string;
}) {
  const tt = useTranslations('TipEmbedGenerator');
  return (
    <OptionalGroup icon={Settings2} title={tt('advancedTitle')} filled={filledAdvanced} filledLabel={filledLabel}>
      <div className="space-y-4">
        {(['message', 'thanks'] as const).map((field) => (
          <Field key={field} label={tt(`${field}Label`)}>
            <textarea
              value={draft[field] ?? ''}
              onChange={(e) => update({ [field]: e.target.value })}
              placeholder={tt(`${field}Placeholder`)}
              maxLength={200}
              rows={2}
              className={inputClass}
            />
          </Field>
        ))}
        <Field label={tt('thanksUrlLabel')} hint={tt('thanksUrlHint')}>
          <input
            type="url"
            value={draft.thanksUrl ?? ''}
            aria-invalid={invalidThanksUrl || undefined}
            aria-describedby={invalidThanksUrl ? 'handle-thanks-url-error' : undefined}
            onChange={(e) => update({ thanksUrl: e.target.value })}
            placeholder={tt('thanksUrlPlaceholder')}
            className={inputClass}
          />
          {invalidThanksUrl && (
            <p id="handle-thanks-url-error" className="mt-1 text-xs text-red-600">{callbackUrlError}</p>
          )}
        </Field>
      </div>
    </OptionalGroup>
  );
}
