'use client';

import { useState } from 'react';

export function CreatorStorefrontProductArtwork({
  imageUrl,
  emoji,
  inverted,
}: {
  imageUrl?: string;
  emoji?: string;
  inverted: boolean;
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
        width={40}
        height={40}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-10 w-10 shrink-0 rounded-xl object-cover"
        // 外部画像の読込失敗がカードの視認性へ波及しないよう、既存の絵文字表示へ戻す。
        onError={() => setFailedImageUrl(imageUrl)}
      />
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
