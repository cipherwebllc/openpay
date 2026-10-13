'use client';

// トップ「使い方」の操作の短い動画 (無音・10 秒前後のループ・いまの画面で撮影)。
// - 画面に入っている間だけ動かす (下にあるうちは読み込まない・見ていない間は止める)。
// - 「動画を止める」で 3 本とも止められる (自動で動き続ける表示には止める手段が要る・WCAG 2.2.2)。
//   動きを減らす設定の端末では止めた状態 (ポスター) で始める。
// 撮り方 (2026-10-13): 決済QR・レジは本番の /ja/create を Playwright でスマホの大きさに録画、お客様の支払いは
// 開発サーバーでサンプルのウォレットを使って録画 (ウォレットの承認画面は Web では撮れないのでイメージを重ねた)。

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';

export type LandingDemo = { src: string; poster: string; label: string; description: string };

export function LandingDemoVideos({
  demos,
  caption,
  note,
  pauseLabel,
  playLabel,
}: {
  demos: LandingDemo[];
  caption: string;
  note: string;
  pauseLabel: string;
  playLabel: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    // matchMedia は既存どおり try-catch (使えない環境でも動画の表示は止めない)。
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPaused(true);
    } catch {}
    const row = rowRef.current;
    if (!row) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.25 });
    io.observe(row);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    for (const v of videoRefs.current) {
      if (!v) continue;
      if (visible && !paused) {
        // 自動再生を端末が断ったとき (省電力モードなど) は、ボタンを「再生」に戻して押せば動くようにする。
        v.play().catch(() => setPaused(true));
      } else {
        v.pause();
      }
    }
  }, [visible, paused]);

  return (
    <div className="mt-8">
      <p id="lp-how-demo-caption" className="text-center text-sm font-semibold text-slate-700">
        {caption}
      </p>
      {/* モバイルは横スクロール 1 行、sm 以上は 3 カラム。横スクロールはキーボードでも動かせるよう
          フォーカスできる region にし、名前は上の見出しから取る (掟 8)。 */}
      <div
        ref={rowRef}
        role="region"
        aria-labelledby="lp-how-demo-caption"
        tabIndex={0}
        className="-mx-4 mt-3 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-5 sm:overflow-visible sm:px-0 sm:pb-0"
      >
        {demos.map((d, i) => (
          // relative: 読み上げ用の説明 (sr-only = absolute) を横スクロールの中に閉じ込める。外に出るとページ全体の
          // 横幅 (scrollWidth) を広げてしまう (2026-10-13 実機で 390 → 540)。
          <figure key={d.src} className="relative flex shrink-0 snap-center flex-col items-center sm:shrink">
            {/* 動画は 390x720 (スマホの画面の上側)。3 本とも同じ大きさ。 */}
            <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
              <video
                ref={(el) => {
                  videoRefs.current[i] = el;
                }}
                className="block aspect-[390/720] h-auto w-[176px] sm:w-[208px]"
                muted
                loop
                playsInline
                preload="none"
                poster={d.poster}
                width={390}
                height={720}
              >
                <source src={d.src} type="video/mp4" />
              </video>
            </div>
            <figcaption className="mt-2 text-center text-[13px] font-medium text-slate-700">
              {d.label}
              <span className="sr-only">: {d.description}</span>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 text-center">
        <p className="text-xs text-slate-500">{note}</p>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {paused ? <Play aria-hidden className="h-4 w-4" /> : <Pause aria-hidden className="h-4 w-4" />}
          {paused ? playLabel : pauseLabel}
        </button>
      </div>
    </div>
  );
}
