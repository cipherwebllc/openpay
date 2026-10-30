'use client';

// 「プロフィール」のカード: 表示名・ひとこと・アバターは常に出し、見た目・SNS・リンク・高度な設定は任意なので
// 畳む (各まとまりは同じフォルダの *Group)。状態は持たない — 下書きとその更新、並べ替え、検証の結果は
// 親の HandleProfileBuilder が持ち、ここは入れた数の集計と各まとまりへの受け渡しだけを行う。

import { UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SectionCard } from '@/components/SectionCard';
import { MAX_BIO_LEN } from '@/lib/handle';
import { DEFAULT_PROFILE_DRAFT, type HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import { AdvancedGroup } from './AdvancedGroup';
import { Field, inputClass, type DraftUpdate, type RowReorder } from './fields';
import { LinksGroup } from './LinksGroup';
import { LookGroup } from './LookGroup';
import { SocialsGroup } from './SocialsGroup';

export function ProfileSection({
  draft,
  update,
  colorValid,
  pickerAccent,
  socialsReorder,
  linksReorder,
  hasInsecure,
  invalidThanksUrl,
  callbackUrlError,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  colorValid: boolean;
  pickerAccent: string;
  socialsReorder: RowReorder;
  linksReorder: RowReorder;
  hasInsecure: boolean;
  invalidThanksUrl: boolean;
  callbackUrlError: string | undefined;
}) {
  const t = useTranslations('HandleProfile');

  // 任意のまとまりに入っている項目の数 (見出しの右に出す)。見た目は既定から変えたものを数える。
  const filledLook = [
    draft.theme !== DEFAULT_PROFILE_DRAFT.theme,
    draft.color !== DEFAULT_PROFILE_DRAFT.color,
    draft.font !== DEFAULT_PROFILE_DRAFT.font,
    draft.cover.trim() !== '',
  ].filter(Boolean).length;
  const filledSocials = draft.socials.filter((v) => v.trim()).length;
  const filledLinks = draft.links.filter((l) => l.kind !== 'heading' && l.url.trim()).length;
  const filledAdvanced = [draft.message, draft.thanks, draft.thanksUrl].filter((v) => v?.trim()).length;
  const filledLabel = (count: number) => t('optionalFilled', { count });

  // 並べ替えハンドル/▲▼ の i18n ラベル (socials/links 共通・既存キーを流用)。
  const reorderLabels = {
    dragToReorder: t('dragToReorder'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
  };

  return (
    <SectionCard title={t('stepProfileTitle')} headingId="handle-profile-heading" icon={UserRound}>
      <div className="space-y-4">
        <Field label={t('nameLabel')}>
          <input
            type="text"
            value={draft.name}
            maxLength={60}
            onChange={(e) => update({ name: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field
          label={t('bioLabel')}
          hint={`${draft.bio.trim().length}/${MAX_BIO_LEN}`}
        >
          <textarea
            value={draft.bio}
            maxLength={MAX_BIO_LEN}
            rows={2}
            onChange={(e) => update({ bio: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label={t('avatarLabel')} hint={t('avatarHint')}>
          <input
            type="url"
            value={draft.avatar}
            placeholder="https://"
            onChange={(e) => update({ avatar: e.target.value })}
            className={inputClass}
          />
        </Field>
        <LookGroup
          draft={draft}
          update={update}
          colorValid={colorValid}
          pickerAccent={pickerAccent}
          filledLook={filledLook}
          filledLabel={filledLabel}
        />
        <SocialsGroup
          draft={draft}
          update={update}
          socialsReorder={socialsReorder}
          reorderLabels={reorderLabels}
          filledSocials={filledSocials}
          filledLabel={filledLabel}
        />
        <LinksGroup
          draft={draft}
          update={update}
          linksReorder={linksReorder}
          reorderLabels={reorderLabels}
          filledLinks={filledLinks}
          filledLabel={filledLabel}
          hasInsecure={hasInsecure}
        />
        <AdvancedGroup
          draft={draft}
          update={update}
          invalidThanksUrl={invalidThanksUrl}
          callbackUrlError={callbackUrlError}
          filledAdvanced={filledAdvanced}
          filledLabel={filledLabel}
        />
      </div>
    </SectionCard>
  );
}
