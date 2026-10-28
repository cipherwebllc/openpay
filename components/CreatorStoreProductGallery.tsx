'use client';

import { useState, type ReactNode } from 'react';
import { ExternalImage } from '@/components/ExternalImage';

// 商品画像 (カバー 1 + ギャラリー最大 4) の主画像 + 番号付きサムネイル。
// variant:
//   'modal' (既定) = 購入モーダル最上部のフルブリード 16:9 (主画像は装飾・商品名は直下の見出し)
//   'focus' = 商品ページ (?product=) の主役の 4:3。ページの主画像なので alt に商品名を入れる
// 主画像は初回表示の画面内なので lazy にしない (LCP を遅らせない・SSR で最初の 1 枚が HTML に載る)。
export function CreatorStoreProductGallery({
  imageUrl,
  galleryUrls,
  labelledBy,
  variant = 'modal',
  alt = '',
  fallback = null,
}: {
  imageUrl?: string;
  galleryUrls?: readonly string[];
  labelledBy: string;
  variant?: 'modal' | 'focus';
  /** variant='focus' の主画像の代替テキスト (商品名)。 */
  alt?: string;
  /** 表示できる画像が 1 枚も無いときの代替 (絵文字のカバー等)。 */
  fallback?: ReactNode;
}) {
  const images = [
    ...(imageUrl ? [{ id: 'main', url: imageUrl }] : []),
    ...(galleryUrls ?? []).map((url, index) => ({
      id: `gallery-${index}`,
      url,
    })),
  ].map((image, position) => ({ ...image, position }));
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<readonly string[]>([]);
  const visibleImages = images.filter(
    (image) => !failedImageIds.includes(image.id),
  );
  const selectedImage =
    visibleImages.find((image) => image.id === selectedImageId) ??
    visibleImages[0] ??
    null;

  const hideFailedImage = (imageId: string) => {
    // 第三者画像 1 枚の障害を残りのギャラリー表示へ波及させない。
    setFailedImageIds((current) =>
      current.includes(imageId) ? current : [...current, imageId],
    );
  };

  if (!selectedImage) return <>{fallback}</>;

  const focus = variant === 'focus';

  return (
    <div>
      {/* 任意の第三者 https 画像。referrerPolicy で hotlink トラッキングを抑制する。 */}
      {focus ? (
        <ExternalImage
          src={selectedImage.url}
          alt={alt}
          width={800}
          height={600}
          referrerPolicy="no-referrer"
          loading={undefined}
          decoding="async"
          className="aspect-[4/3] w-full rounded-2xl bg-slate-100 object-cover"
          onError={() => hideFailedImage(selectedImage.id)}
        />
      ) : (
        <ExternalImage
          src={selectedImage.url}
          alt=""
          aria-hidden
          width={640}
          height={360}
          referrerPolicy="no-referrer"
          loading={undefined}
          decoding="async"
          className="aspect-[16/9] max-h-80 w-full bg-slate-100 object-cover"
          onError={() => hideFailedImage(selectedImage.id)}
        />
      )}
      {visibleImages.length >= 2 ? (
        <div
          role="group"
          aria-labelledby={labelledBy}
          className={
            focus
              ? 'mt-3 flex flex-wrap gap-2'
              : 'mt-3 flex flex-wrap justify-center gap-2 px-4'
          }
        >
          {visibleImages.map((image) => {
            const selected = image.id === selectedImage.id;
            return (
              <button
                key={image.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setSelectedImageId(image.id)}
                className={`rounded-xl border bg-white p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 ${
                  selected
                    ? 'border-brand text-brand-dark ring-2 ring-brand/30'
                    : 'border-slate-200 text-slate-500 hover:border-slate-300'
                }`}
              >
                <ExternalImage
                  src={image.url}
                  alt=""
                  aria-hidden
                  width={48}
                  height={48}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  className={`${focus ? 'h-14 w-14' : 'h-12 w-12'} rounded-lg object-cover`}
                  onError={() => hideFailedImage(image.id)}
                />
                {/* 掟 8: button の a11y 名は aria-label ではなく、この可視番号から導出する。 */}
                <span className="mt-0.5 block text-center text-[10px] font-bold">
                  {image.position + 1}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
