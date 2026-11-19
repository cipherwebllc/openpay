'use client';

// プロフィールの任意のまとまり「見た目」(テーマ・テーマ色・フォント・カバー画像)。状態は持たない
// (下書きとその更新は親の HandleProfileBuilder が持つ)。

import { Palette } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { handleFontClass } from '@/components/handleFonts';
import { HandleThemePicker } from '@/components/HandleThemePicker';
import { ImageField } from '@/components/ImageField';
import { OptionalGroup } from '@/components/OptionalGroup';
import { nextImageOperation } from '@/hooks/useImageUpload';
import { HANDLE_FONTS, MAX_COVER_URL_LEN } from '@/lib/handle';
import { IMAGE_MAX_EDGE } from '@/lib/images/purpose';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import { Field, inputClass, type DraftUpdate } from './fields';
import type { ProfileImageUploads } from './imageUploads';

export function LookGroup({
  draft,
  update,
  colorValid,
  pickerAccent,
  filledLook,
  filledLabel,
  images,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  colorValid: boolean;
  /** テーマピッカーのミニプレビュー用アクセント (無効色は既定ブルー)。 */
  pickerAccent: string;
  filledLook: number;
  filledLabel: (count: number) => string;
  /** 画像の欄 (アップロード) の状態。enabled が false なら今の URL の欄のまま。 */
  images: ProfileImageUploads;
}) {
  const t = useTranslations('HandleProfile');
  const tImage = useTranslations('ImageField');
  const locale = useLocale();
  return (
    <OptionalGroup icon={Palette} title={t('groupLook')} filled={filledLook} filledLabel={filledLabel}>
      {/* interactive なタイル群なので Field (=<label>) では包まない。 */}
      <HandleThemePicker
        accent={pickerAccent}
        selected={draft.theme}
        onSelect={(theme) => update({ theme })}
        label={t('themeLabel')}
        hint={t('themeHint')}
      />
      <Field label={t('colorLabel')}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={colorValid ? draft.color : '#2563eb'}
            onChange={(e) => update({ color: e.target.value })}
            className="h-9 w-12 rounded border border-slate-300"
          />
          <input
            type="text"
            value={draft.color}
            onChange={(e) => update({ color: e.target.value })}
            placeholder="#2563eb"
            className={inputClass}
          />
        </div>
      </Field>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">{t('fontLabel')}</legend>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {HANDLE_FONTS.map((font) => (
            <label key={font} className={`relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-1.5 transition ${draft.font === font ? 'border-brand ring-2 ring-brand/40' : 'border-slate-200 hover:border-slate-300'}`}>
              <input type="radio" name="profile-font" value={font} checked={draft.font === font} onChange={() => update({ font })} className="peer sr-only" />
              <span aria-hidden className={['flex h-9 w-full items-center justify-center rounded-md bg-slate-50 peer-focus-visible:ring-2 peer-focus-visible:ring-brand', handleFontClass(font)].filter(Boolean).join(' ')}>あア Aa</span>
              <span className={`text-xs font-medium ${draft.font === font ? 'text-brand' : 'text-slate-600'}`}>{t(`fonts.${font}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {images.enabled ? (
        // 画像の欄 (横長)。下書きが丸ごと入れ替わったら作り直す。ガイドへの導線は「URL で指定する ›」を開いたときに出す。
        <ImageField
          key={images.session}
          id="handle-profile-cover"
          label={t('coverImageLabel')}
          urlLabel={t('coverLabel')}
          value={draft.cover}
          onChange={(cover) => update({ cover })}
          purpose="cover"
          onBusyChange={images.cover.onBusyChange}
          operation={images.cover.operation}
          urlMaxLength={MAX_COVER_URL_LEN}
          hint={
            <p className="text-xs leading-relaxed text-slate-500">
              {t('coverImageHint')} {tImage('hint', { max: IMAGE_MAX_EDGE.cover })}
            </p>
          }
          urlHint={
            <p className="mt-1 text-xs text-slate-500">
              {t('coverHint')}{' '}
              <Link
                href={`/${locale}/guide/image-url`}
                prefetch={false}
                className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
              >
                {t('imageGuideLink')}
              </Link>
            </p>
          }
          previewClassName="h-16 w-48 rounded-lg"
        />
      ) : (
      <>
      {/* images.enabled が false の画面は今のまま (DOM は変えない)。手入力はカバーの操作の番号を進める (画像の欄から
          URL の欄へ切り替わる前に始まったアップロードの結果で、手で入れた値を上書きしない)。 */}
      <Field label={t('coverLabel')} hint={t('coverHint')}>
        <input
          type="url"
          value={draft.cover}
          placeholder="https://"
          onChange={(e) => {
            nextImageOperation(images.cover.operation);
            update({ cover: e.target.value });
          }}
          className={inputClass}
        />
      </Field>
      {/* 画像 URL の用意ガイドへの導線。Field の hint は label 内に描画されるため、
          リンクは label の外に置く (label 内の <a> はクリック挙動が入力と衝突する)。 */}
      <p className="-mt-3 text-xs">
        <Link
          href={`/${locale}/guide/image-url`}
          prefetch={false}
          className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
        >
          {t('imageGuideLink')}
        </Link>
      </p>
      </>
      )}
    </OptionalGroup>
  );
}
