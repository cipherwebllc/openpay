'use client';

// スマホで上に貼り付くミニプレビュー (lg 未満)。見せる値はすべて親 (HandleProfileBuilder) が下書きから
// 組み立てて渡す。持つ状態は外部画像の読込失敗だけ (画像は URL を key にして作り直す)。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalImage } from '@/components/ExternalImage';
import { handleFontClass } from '@/components/handleFonts';
import type { HandleFont } from '@/lib/handle';

function MiniPreviewAvatar({ url, initial }: { url?: string; initial: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    // 外部画像の読込失敗がプレビューの壊れ画像表示に波及しないよう頭文字へ戻す。
    <ExternalImage
      src={url}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      loading={undefined}
      decoding="async"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  ) : <span aria-hidden>{initial}</span>;
}

function MiniPreviewCover({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  // 外部画像の読込失敗がプレビューの壊れ画像表示に波及しないよう非表示にする。
  return failed ? null : (
    <ExternalImage
      src={url}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      loading={undefined}
      decoding="async"
      className="absolute inset-0 h-full w-full opacity-25 object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export function HandleMiniPreview({
  draftName,
  editingHandle,
  font,
  previewBg,
  previewDark,
  pickerAccent,
  cover,
  avatar,
}: {
  /** 下書きの表示名 (trim 前)。 */
  draftName: string;
  editingHandle: string | null;
  font: HandleFont;
  previewBg: string | undefined;
  previewDark: boolean;
  pickerAccent: string;
  /** 公開に載る形 (https のみ) に整えたカバー画像・アバター画像の URL。 */
  cover: string | undefined;
  avatar: string | undefined;
}) {
  const t = useTranslations('HandleProfile');
  const miniName = draftName.trim() || `@${editingHandle ?? 'handle'}`;
  const miniInitial = Array.from(draftName.trim() || editingHandle || 'handle')[0].toUpperCase();
  return (
    // AppShell → AppHeader: h-8 + py-3 × 2 + border-b = 57px。
    // 外側は不透明の地 (白/濃紺) にして、半透明グラデーションのテーマ地色でも本文が透けないようにする。
    <div
      data-testid="handle-mini-preview"
      className={`sticky top-[57px] z-20 overflow-hidden rounded-xl shadow-sm ring-1 ring-black/10 lg:hidden ${
        previewDark ? 'bg-slate-900 text-slate-50' : 'bg-white text-slate-900'
      }`}
    >
      <div
        className={['relative flex h-14 items-center gap-3 px-3', handleFontClass(font)].filter(Boolean).join(' ')}
        style={{ background: previewBg }}
      >
        {cover && <MiniPreviewCover key={cover} url={cover} />}
        <div
          className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white ring-2 ring-white/30"
          style={{ backgroundColor: pickerAccent }}
        >
          <MiniPreviewAvatar key={avatar ?? ''} url={avatar} initial={miniInitial} />
        </div>
        <div className="relative z-10 min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{miniName}</p>
          {/* 表示名が空のときは 1 行目が @handle になるので、同じ文字列を 2 行目に重ねない。 */}
          {draftName.trim() !== '' && (
            <p className={`truncate text-xs ${previewDark ? 'text-slate-300' : 'text-slate-600'}`}>
              @{editingHandle ?? 'handle'}
            </p>
          )}
        </div>
        <a
          href="#step-4-heading"
          className="relative z-10 flex min-h-11 shrink-0 items-center rounded text-xs font-semibold underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t('miniPreviewJump')}
        </a>
      </div>
    </div>
  );
}
