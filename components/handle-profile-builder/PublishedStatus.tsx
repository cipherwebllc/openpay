'use client';

// 「あなたのページ」の見出しの下に出す、編集中の @handle の公開状態 (公開中・最終更新・未公開の変更・
// 編集をやめる)。状態は持たない (編集対象・公開の基準・やめる処理は親の HandleProfileBuilder が持つ)。

import { useTranslations } from 'next-intl';
import type { RelativePublishedTime } from '@/lib/handlePublish';

export function PublishedStatus({
  handle,
  relativeUpdatedAt,
  isDirty,
  onStopEditing,
}: {
  handle: string;
  relativeUpdatedAt: RelativePublishedTime | null;
  isDirty: boolean;
  onStopEditing: () => void;
}) {
  const tc = useTranslations('HandleClaim');
  return (
    <div className="mb-3">
      <span
        data-testid="published-status"
        className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200"
      >
        <span>{tc('publishedStatus', { handle })}</span>
        <span aria-hidden>・</span>
        {relativeUpdatedAt ? (
          <span>
            {tc('lastUpdated')}{' '}
            <time dateTime={relativeUpdatedAt.dateTime}>
              {relativeUpdatedAt.label}
            </time>
          </span>
        ) : (
          <span>{tc('lastUpdatedUnknown')}</span>
        )}
        {isDirty && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 ring-1 ring-amber-200">
            {tc('unpublishedChanges')}
          </span>
        )}
        <button
          type="button"
          onClick={onStopEditing}
          className="text-emerald-700 underline hover:text-emerald-950"
        >
          {tc('stopEditing')}
        </button>
      </span>
    </div>
  );
}
