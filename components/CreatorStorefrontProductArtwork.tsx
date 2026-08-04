'use client';

import { useState } from 'react';

// 商品ビジュアル。variant:
//   'thumb' (既定) = 40px の正方サムネイル (リスト行用・従来表示)
//   'cover' = カード上部いっぱいの大サムネイル (ショーケース調・
//             plans/store-showcase-polish.md P1)。hover で微ズーム (親に group 必須)
export function CreatorStorefrontProductArtwork({
  imageUrl,
  emoji,
  inverted,
  variant = 'thumb',
}: {
  imageUrl?: string;
  emoji?: string;
  inverted: boolean;
  variant?: 'thumb' | 'cover';
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  if (imageUrl && failedImageUrl !== imageUrl) {
    return (
      // 任意の第三者 https 画像。referrerPolicy で hotlink トラッキングを抑制する。
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        aria-hidden
        {...(variant === 'thumb' ? { width: 40, height: 40 } : {})}
        referrerPolicy="no-referrer"
        loading="lazy"
        className={
          variant === 'cover'
            ? 'aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]'
            : 'h-10 w-10 shrink-0 rounded-xl object-cover'
        }
        // 外部画像の読込失敗がカードの視認性へ波及しないよう、既存の絵文字表示へ戻す。
        onError={() => setFailedImageUrl(imageUrl)}
      />
    );
  }

  if (variant === 'cover') {
    return (
      <span
        aria-hidden
        className={`flex aspect-[4/3] w-full items-center justify-center text-4xl ${
          inverted
            ? 'bg-white/10'
            : 'bg-gradient-to-br from-slate-50 to-slate-200/70'
        }`}
      >
        {emoji ?? '✦'}
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl ${
        inverted ? 'bg-white/15' : 'bg-slate-100'
      }`}
    >
      {emoji ?? '✦'}
    </span>
  );
}
