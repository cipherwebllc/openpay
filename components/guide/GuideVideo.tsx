'use client';

// ガイドページの使い方動画。最初はサムネイル (自前の画像) だけを出し、押したときに
// YouTube (youtube-nocookie) の iframe に差し替える。押すまで YouTube へ通信しないので、
// ページの読み込みが重くならず、見ない人の情報も YouTube に渡らない。

import { useState } from 'react';
import Image from 'next/image';
import { Play } from 'lucide-react';
import {
  HOWTO_VIDEO_UI,
  howtoVideoEmbedUrl,
  howtoVideoWatchUrl,
  type HowtoVideo,
} from '@/lib/howtoVideos';

export function GuideVideo({ video }: { video: HowtoVideo }) {
  const [playing, setPlaying] = useState(false);
  return (
    <figure className="mt-4">
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-900 shadow-lift ring-1 ring-slate-200/60">
        {playing ? (
          <iframe
            src={howtoVideoEmbedUrl(video)}
            title={video.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            // components/HandleProfile.tsx の YouTube 埋め込みと同じ制限。
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            // YouTube embed は Referer (origin) が無いと「エラー 153」で再生を拒否する
            // (2026-08-01 実機で確認・HandleProfile と同じ)。origin だけを送る。
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 block h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400"
          >
            <Image
              src={video.thumbnail}
              alt={video.title}
              fill
              sizes="(min-width: 768px) 768px, calc(100vw - 2rem)"
              className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            />
            {/* サムネイルの文字 (タイトル・左寄せ) に重ならないよう右下に置く。 */}
            <span className="absolute inset-0 flex items-end justify-end p-3 sm:p-5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3.5 py-2 text-xs font-semibold text-white shadow-lg transition-colors group-hover:bg-red-700 sm:gap-2 sm:px-5 sm:py-2.5 sm:text-sm">
                <Play aria-hidden className="h-3.5 w-3.5 fill-current sm:h-4 sm:w-4" />
                {HOWTO_VIDEO_UI.play}（{video.duration}）
              </span>
            </span>
          </button>
        )}
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-slate-600">
        <span>{video.title}</span>
        <a
          href={howtoVideoWatchUrl(video)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
        >
          {HOWTO_VIDEO_UI.openOnYouTube}
        </a>
      </figcaption>
    </figure>
  );
}
