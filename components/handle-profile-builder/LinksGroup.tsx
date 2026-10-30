'use client';

// プロフィールの任意のまとまり「リンク」(並べ方・通常リンク/見出しの行・埋め込み・注目)。状態は持たない —
// 下書きとその更新、並べ替え (useDragReorderList) は親の HandleProfileBuilder が持つ。

import { Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { OptionalGroup } from '@/components/OptionalGroup';
import { ReorderableRow } from '@/components/ReorderableRow';
import {
  isHandleEmbedUrl,
  HANDLE_LINK_LAYOUTS,
  MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_EMBEDS,
  MAX_PROFILE_LINKS,
} from '@/lib/handle';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import {
  FieldGroup,
  inputClass,
  linkFieldLabelClass,
  type DraftUpdate,
  type ReorderLabels,
  type RowReorder,
} from './fields';

export function LinksGroup({
  draft,
  update,
  linksReorder,
  reorderLabels,
  filledLinks,
  filledLabel,
  hasInsecure,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  linksReorder: RowReorder;
  reorderLabels: ReorderLabels;
  filledLinks: number;
  filledLabel: (count: number) => string;
  /** 非 https の SNS・リンク・画像が公開から外れること (注意を出す)。 */
  hasInsecure: boolean;
}) {
  const t = useTranslations('HandleProfile');
  const tb = useTranslations('HandleProfileBuilder');

  const embedCount = draft.links.reduce(
    (count, link) =>
      link.kind !== 'heading' &&
      link.embed === true &&
      isHandleEmbedUrl(link.url.trim())
        ? count + 1
        : count,
    0,
  );

  // 「注目」は最大 1 本。ある行を ON にしたら他行は自動 OFF (単一 enforce)。同じ行の再クリックで OFF。
  const setFeatured = (index: number, on: boolean) => {
    if (draft.links[index]?.kind === 'heading') return;
    update({
      links: draft.links.map((l, j) =>
        l.kind === 'heading' ? l : { ...l, featured: on && j === index },
      ),
    });
  };

  return (
    <OptionalGroup icon={Link2} title={t('groupLinks')} filled={filledLinks} filledLabel={filledLabel}>
      <FieldGroup label={t('linksLabel')} hint={t('httpsOnlyHint')} hideLabel>
        <fieldset className="mb-3">
          <legend className="text-sm font-medium text-slate-700">{t('linkLayoutLabel')}</legend>
          <div className="mt-1 flex gap-2">
            {HANDLE_LINK_LAYOUTS.map((linkLayout) => (
              <label key={linkLayout} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs ${draft.linkLayout === linkLayout ? 'border-brand text-brand' : 'border-slate-200 text-slate-600'}`}>
                <input type="radio" name="profile-link-layout" value={linkLayout} checked={draft.linkLayout === linkLayout} onChange={() => update({ linkLayout })} />
                {t(`linkLayouts.${linkLayout}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-2">
          {draft.links.map((l, i) => (
            <ReorderableRow
              key={i}
              {...linksReorder.rowProps(i, draft.links.length)}
              labels={reorderLabels}
            >
              {l.kind === 'heading' ? (
                <div className="flex min-w-0 flex-1 items-end gap-2">
                  <label className="min-w-[6rem] flex-1">
                    <span className={linkFieldLabelClass}>
                      {tb('headingLabel')}
                    </span>
                    <input
                      type="text"
                      value={l.label}
                      placeholder={tb('headingLabelPlaceholder')}
                      maxLength={40}
                      onChange={(e) => {
                        const next = [...draft.links];
                        next[i] = { ...l, label: e.target.value };
                        update({ links: next });
                      }}
                      className={inputClass}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      update({
                        links: draft.links.filter((_, j) => j !== i),
                      })
                    }
                    className="shrink-0 rounded-md border border-slate-200 px-2 text-sm text-slate-500 hover:text-red-600"
                  >
                    {tb('removeHeading')}
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                  <label className="w-14 shrink-0">
                    <span className={linkFieldLabelClass}>
                      {t('emojiAria')}
                    </span>
                    <input
                      type="text"
                      value={l.emoji ?? ''}
                      placeholder="🌐"
                      maxLength={8}
                      onChange={(e) => {
                        const next = [...draft.links];
                        next[i] = { ...l, emoji: e.target.value };
                        update({ links: next });
                      }}
                      className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
                    />
                  </label>
                  <label className="min-w-[10rem] flex-[2]">
                    <span className={linkFieldLabelClass}>
                      {tb('imageUrlLabel')}
                    </span>
                    <input
                      type="url"
                      value={l.imageUrl ?? ''}
                      placeholder="https://"
                      maxLength={MAX_LINK_IMAGE_URL_LEN}
                      onChange={(e) => {
                        const next = [...draft.links];
                        next[i] = { ...l, imageUrl: e.target.value };
                        update({ links: next });
                      }}
                      className={inputClass}
                    />
                  </label>
                  <label className="min-w-[6rem] flex-[2]">
                    <span className={linkFieldLabelClass}>
                      {tb('linkLabel')}
                    </span>
                    <input
                      type="text"
                      value={l.label}
                      placeholder={t('linkLabelPlaceholder')}
                      maxLength={40}
                      onChange={(e) => {
                        const next = [...draft.links];
                        next[i] = { ...l, label: e.target.value };
                        update({ links: next });
                      }}
                      className={inputClass}
                    />
                  </label>
                  <label className="min-w-[8rem] flex-[3]">
                    <span className={linkFieldLabelClass}>
                      {tb('linkUrlLabel')}
                    </span>
                    <input
                      type="url"
                      value={l.url}
                      placeholder="https://"
                      onChange={(e) => {
                        const next = [...draft.links];
                        const nextLink = { ...l, url: e.target.value };
                        // URL が非対応になったら、画面から消えた toggle の stale true が
                        // publish を拒否する波及を断つためここで同時に外す。
                        if (!isHandleEmbedUrl(e.target.value.trim())) {
                          delete nextLink.embed;
                        }
                        next[i] = nextLink;
                        update({ links: next });
                      }}
                      className={inputClass}
                    />
                  </label>
                  {isHandleEmbedUrl(l.url.trim()) && (
                    <label className="inline-flex min-h-6 shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-600">
                      <input
                        type="checkbox"
                        checked={l.embed === true}
                        disabled={
                          l.embed !== true &&
                          embedCount >= MAX_PROFILE_EMBEDS
                        }
                        onChange={(e) => {
                          const next = [...draft.links];
                          const nextLink = { ...l };
                          if (e.target.checked) nextLink.embed = true;
                          else delete nextLink.embed;
                          next[i] = nextLink;
                          update({ links: next });
                        }}
                      />
                      <span>{tb('embedToggle')}</span>
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => setFeatured(i, !l.featured)}
                    aria-pressed={!!l.featured}
                    className={`shrink-0 rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
                      l.featured
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {l.featured ? '★' : '☆'} {t('featuredToggle')}
                  </button>
                  <button
                    type="button"
                    onClick={() => update({ links: draft.links.filter((_, j) => j !== i) })}
                    className="shrink-0 rounded-md border border-slate-200 px-2 text-sm text-slate-500 hover:text-red-600"
                    aria-label={t('removeLink')}
                  >
                    ×
                  </button>
                </div>
              )}
            </ReorderableRow>
          ))}
          {draft.links.length < MAX_PROFILE_LINKS && (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => update({ links: [...draft.links, { label: '', url: '' }] })}
                className="text-xs font-medium text-brand hover:underline"
              >
                ＋ {t('addLink')}
              </button>
              <button
                type="button"
                onClick={() =>
                  update({
                    links: [
                      ...draft.links,
                      { kind: 'heading', label: '' },
                    ],
                  })
                }
                className="text-xs font-medium text-brand hover:underline"
              >
                ＋ {tb('addHeading')}
              </button>
            </div>
          )}
        </div>
      </FieldGroup>
      {/* 埋め込み対応サービスの一覧は常時表示から畳む (引き算 P2)。hint「https:// のみ」の直下。 */}
      <details className="text-xs leading-relaxed text-slate-500">
        <summary className="cursor-pointer font-medium">
          {t('embedServicesSummary')}
        </summary>
        <p className="mt-2">{t('embedServicesHint')}</p>
      </details>
      {hasInsecure && (
        <p className="text-xs text-amber-700">{t('insecureDropped')}</p>
      )}
    </OptionalGroup>
  );
}
