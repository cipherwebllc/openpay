'use client';

// Store の商品の追加画像 (最大 4 枚) の欄。出品者の GET の imageUpload が true のときだけ ProductEditorSection が出す
// (false なら今の textarea のまま)。値の形は今と同じ「1 行に 1 つの URL」の文字列 (productForm.galleryUrls) で、
// 保存の API と形は変えない。
// - サムネと各「外す」・「画像を追加」(選んだ画像をアップロードして末尾に足す)・「URL で指定する ›」(開くと今の textarea)。
// - アップロード中は「画像を追加」を止め、busy を親へ知らせる (hooks/useImageUpload)。失敗しても今の画像は変えない。

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ImagePreview, ImageUploadStatus, imageButtonClass } from '@/components/ImageField';
import { useImageUpload } from '@/hooks/useImageUpload';
import { IMAGE_FIELD_ACCEPT } from '@/lib/images/purpose';
import { inputClass } from './shared';

/** 保存の上限 (lib/x402/hostedStore の MAX_HOSTED_GALLERY_IMAGES・server-only) と同じ。 */
export const GALLERY_MAX_IMAGES = 4;

const GALLERY_ID = 'creator-store-product-gallery';

/** 保存と同じ読み方 (CreatorStoreSellerPanel の saveProduct): 行に分け、前後の空白を除き、空の行を落とす。 */
export function galleryUrlsOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onBusyChange: (busy: boolean) => void;
  isLicense: boolean;
};

export function ProductGalleryField({ value, onChange, onBusyChange, isLicense }: Props) {
  const t = useTranslations('CreatorStoreSeller');
  const tImage = useTranslations('ImageField');
  const fileInput = useRef<HTMLInputElement>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const urls = galleryUrlsOf(value);
  const { busy, error, cancel, onFileChange } = useImageUpload({
    purpose: 'product',
    // 届いたときの欄の値の末尾に足す (送っている間に外した・書き換えた行を戻さない)。
    onUploaded: (url) => onChange([...galleryUrlsOf(value), url].join('\n')),
    onBusyChange,
  });

  return (
    <div role="group" aria-labelledby={`${GALLERY_ID}-label`} className="space-y-2 sm:col-span-2">
      <p id={`${GALLERY_ID}-label`} className="text-sm font-medium text-slate-700">
        {t('galleryLabel', { max: GALLERY_MAX_IMAGES })}
      </p>
      {urls.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {urls.map((url, index) => (
            <li key={`${index}:${url}`} className="space-y-1">
              <ImagePreview url={url} className="aspect-square w-full rounded-lg ring-1 ring-slate-200" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span id={`${GALLERY_ID}-item-${index}`} className="text-xs text-slate-500">
                  {t('galleryItem', { number: index + 1 })}
                </span>
                <button
                  type="button"
                  aria-describedby={`${GALLERY_ID}-item-${index}`}
                  onClick={() => onChange(urls.filter((_, other) => other !== index).join('\n'))}
                  className={imageButtonClass}
                >
                  {tImage('remove')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {urls.length < GALLERY_MAX_IMAGES ? (
        <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={imageButtonClass}>
          {t('galleryAdd')}
        </button>
      ) : (
        <p className="text-xs text-slate-500">{t('galleryFull', { max: GALLERY_MAX_IMAGES })}</p>
      )}
      {/* 見えない file の欄 (上の「画像を追加」が開く)。 */}
      <input ref={fileInput} type="file" accept={IMAGE_FIELD_ACCEPT} hidden onChange={onFileChange} />
      <ImageUploadStatus busy={busy} error={error} onCancel={cancel} />
      <div>
        <button
          type="button"
          aria-expanded={urlOpen}
          aria-controls={urlOpen ? `${GALLERY_ID}-url-panel` : undefined}
          onClick={() => setUrlOpen((open) => !open)}
          className="inline-flex min-h-11 items-center text-xs font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
        >
          {tImage('useUrl')}
        </button>
        {urlOpen ? (
          <div id={`${GALLERY_ID}-url-panel`}>
            {/* 開いた欄は今の textarea と同じ (id・見出し・1 行に 1 つの URL)。 */}
            <label htmlFor={`${GALLERY_ID}-urls`} className="block text-sm font-medium text-slate-700">
              {t('galleryUrlsLabel')}
              <textarea
                id={`${GALLERY_ID}-urls`}
                rows={4}
                value={value}
                onChange={(event) => {
                  // 手で書いた行が最後の意思: 送っている途中の画像はやめる (届いても足さない)。
                  cancel();
                  onChange(event.target.value);
                }}
                className={`${inputClass}${isLicense ? ' min-h-11' : ''}`}
              />
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}
