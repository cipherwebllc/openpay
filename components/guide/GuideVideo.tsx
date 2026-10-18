'use client';

// ガイドページの使い方動画。最初は小さなカード (自前のサムネイル画像) だけを出し、押したときに
// YouTube (youtube-nocookie) の iframe に差し替える。押すまで YouTube へ通信しないので、
// ページの読み込みが重くならず、見ない人の情報も YouTube に渡らない。

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Play } from 'lucide-react';
import { GUIDE_INLINE_LINK } from '@/components/guide/GuideLink';
import {
  HOWTO_VIDEO_UI,
  howtoVideoEmbedUrl,
  howtoVideoWatchUrl,
  type HowtoVideo,
} from '@/lib/howtoVideos';

export function GuideVideo({ video }: { video: HowtoVideo }) {
  const [playing, setPlaying] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 押したボタンは iframe に置き換わって消えるので、focus を動画へ移す (D6)。移さないと focus が body に落ち、
  // キーボードでは動画の操作 (一時停止など) までページの先頭から辿り直しになる。
  useEffect(() => {
    if (playing) iframeRef.current?.focus();
  }, [playing]);
  if (playing) {
    return (
      <figure className="mt-4">
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-900 shadow-lift ring-1 ring-slate-200/60">
          <iframe
            ref={iframeRef}
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
        </div>
        <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-slate-600">
          <span>{video.title}</span>
          <YouTubeLink video={video} />
        </figcaption>
      </figure>
    );
  }
  // 押す前は 1 行の小さなカード (小さなサムネイル + 題名 + 再生の文字)。本文の流れを大きな画像で切らない
  // (plans/guide-ux-polish-2.md P4)。カード全体を押せるよう、ボタンの ::after をカードいっぱいに広げる。
  // サムネイルは飾り (alt="")・ボタンの名前は可視の題名と再生の文字から決まる (aria-label は使わない・掟 8)。
  return (
    <figure className="group relative mt-4 flex items-center gap-4 rounded-2xl bg-white p-2.5 pr-4 ring-1 ring-slate-200/80 transition-colors has-[button:focus-visible]:ring-4 has-[button:focus-visible]:ring-emerald-400 [@media(hover:hover)]:hover:bg-slate-50 [@media(hover:hover)]:hover:ring-slate-300">
      <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-slate-900 sm:w-36">
        <Image src={video.thumbnail} alt="" fill sizes="144px" className="object-cover" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/95 shadow-md transition-transform group-hover:scale-105">
            <Play aria-hidden className="ml-0.5 h-3.5 w-3.5 fill-slate-900 text-slate-900" />
          </span>
        </span>
      </span>
      <figcaption className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="block w-full cursor-pointer text-left after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none"
        >
          <span className="block text-sm font-semibold leading-snug text-slate-900 [word-break:auto-phrase]">
            {video.title}
          </span>
          <span className="mt-1 block text-xs font-medium text-emerald-700">
            {HOWTO_VIDEO_UI.play}（{video.duration}）
          </span>
        </button>
        {/* カードの上に重ねて押せるようにする (ボタンの ::after より上)。 */}
        <span className="relative z-10 mt-1 block text-xs">
          <YouTubeLink video={video} />
        </span>
      </figcaption>
    </figure>
  );
}

function YouTubeLink({ video }: { video: HowtoVideo }) {
  return (
    <a
      href={howtoVideoWatchUrl(video)}
      target="_blank"
      rel="noopener noreferrer"
      className={GUIDE_INLINE_LINK}
    >
      {HOWTO_VIDEO_UI.openOnYouTube}
    </a>
  );
}
