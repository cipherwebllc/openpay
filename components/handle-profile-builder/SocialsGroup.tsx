'use client';

// プロフィールの任意のまとまり「SNS」(URL のみ・アイコンはドメイン自動判定)。状態は持たない — 下書きと
// その更新、並べ替え (useDragReorderList) は親の HandleProfileBuilder が持つ。

import { Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { OptionalGroup } from '@/components/OptionalGroup';
import { ReorderableRow } from '@/components/ReorderableRow';
import { SocialIcon } from '@/components/SocialIconLinks';
import { MAX_SOCIAL_LINKS } from '@/lib/handle';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import { inputClass, type DraftUpdate, type ReorderLabels, type RowReorder } from './fields';

export function SocialsGroup({
  draft,
  update,
  socialsReorder,
  reorderLabels,
  filledSocials,
  filledLabel,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  socialsReorder: RowReorder;
  reorderLabels: ReorderLabels;
  filledSocials: number;
  filledLabel: (count: number) => string;
}) {
  const t = useTranslations('HandleProfile');
  return (
    <OptionalGroup icon={Share2} title={t('groupSns')} filled={filledSocials} filledLabel={filledLabel} groupId="handle-group-socials">
      {/* SNS アイコンリンク (URL のみ・アイコンはドメイン自動判定) */}
      <div role="group" aria-labelledby="handle-group-socials">
        <div className="space-y-2">
          {draft.socials.map((s, i) => (
            <ReorderableRow
              key={i}
              {...socialsReorder.rowProps(i, draft.socials.length)}
              labels={reorderLabels}
            >
              <span className="shrink-0 text-slate-500">
                <SocialIcon url={s.trim()} className="h-5 w-5" />
              </span>
              <input
                type="url"
                value={s}
                placeholder="https://x.com/yourname"
                onChange={(e) => {
                  const next = [...draft.socials];
                  next[i] = e.target.value;
                  update({ socials: next });
                }}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() =>
                  update({ socials: draft.socials.filter((_, j) => j !== i) })
                }
                className="rounded-md border border-slate-200 px-2 text-sm text-slate-500 hover:text-red-600"
                aria-label={t('removeSocial')}
              >
                ×
              </button>
            </ReorderableRow>
          ))}
          {draft.socials.length < MAX_SOCIAL_LINKS && (
            <button
              type="button"
              onClick={() => update({ socials: [...draft.socials, ''] })}
              className="text-xs font-medium text-brand hover:underline"
            >
              ＋ {t('addSocial')}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-500">{t('socialsHint')}</p>
      </div>
    </OptionalGroup>
  );
}
