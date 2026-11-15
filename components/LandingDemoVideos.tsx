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
          フォーカスできる region にし、名前は上の見出しから取る (掟 8)。
          モバイルも grid (列の幅 = 動画の幅) にして、2 行目に ③ の注 (③ の列) と「動画を止める」(①② の列) を置く。 */}
      <div
        ref={rowRef}
        role="region"
        aria-labelledby="lp-how-demo-caption"
        tabIndex={0}
        className="-mx-4 mt-3 grid snap-x snap-mandatory grid-cols-[repeat(3,max-content)] gap-x-4 overflow-x-auto px-4 pb-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:mx-0 sm:grid-cols-3 sm:gap-x-5 sm:overflow-visible sm:px-0 sm:pb-0"
      >
        {demos.map((d, i) => (
          // relative: 読み上げ用の説明 (sr-only = absolute) を横スクロールの中に閉じ込める。外に出るとページ全体の
          // 横幅 (scrollWidth) を広げてしまう (2026-10-13 実機で 390 → 540)。
          // モバイルの幅は画面の 40% (上限 176px): 2 本と、3 本目の端が見えて「横に続く」と分かる。幅を figure に持たせるので、
          // 長い見出し (en) は図の幅で折り返す (図を押し広げない)。sm 以上は列の幅いっぱい (動画は 208px)。
          <figure key={d.src} className="relative flex w-[40vw] max-w-[176px] snap-center flex-col items-center sm:w-auto sm:max-w-none">
            {/* 動画は 390x720 (スマホの画面の上側)。3 本とも同じ大きさ。 */}
            <div className="w-full overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 sm:w-auto">
              <video
                ref={(el) => {
                  videoRefs.current[i] = el;
                }}
                className="block aspect-[390/720] h-auto w-full sm:w-[208px]"
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
            {/* 図の幅で折り返すときは、行の長さをそろえる (1 字・1 語だけの行を出さない)。 */}
            <figcaption className="mt-2 text-balance text-center text-[13px] font-medium text-slate-700 [word-break:auto-phrase]">
              {d.label}
              <span className="sr-only">: {d.description}</span>
            </figcaption>
          </figure>
        ))}
        {/* 注と「動画を止める」。sm 以上は 3 本の並びの下に、注とボタンを 1 行で中央に置く。
            モバイルはこの枠を無くして (display:contents)、2 つを grid の 2 行目に直接置く:
            - 注は ③ (最後の動画) の話なので ③ の列に置き、③ と一緒に横へ流れる (並びの外に置くと、③ が画面の外のときにも出る)。
              w-0 + min-w-full = 列の幅を広げずに、列の幅で折り返す。
            - ボタンは ①② の列の下。横に送っても画面の左に残る (sticky) ので、③ を見ているときも止められる。 */}
        <div className="contents sm:col-span-3 sm:mt-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-4 sm:text-center">
          <p className="col-start-3 row-start-2 mt-1.5 w-0 min-w-full text-balance text-center text-xs text-slate-500 [word-break:auto-phrase] sm:mt-0 sm:w-auto sm:min-w-0">
            {note}
          </p>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="sticky left-0 col-span-2 col-start-1 row-start-2 inline-flex min-h-11 items-center gap-1.5 self-start justify-self-center rounded-xl px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand sm:static sm:self-auto"
          >
            {paused ? <Play aria-hidden className="h-4 w-4" /> : <Pause aria-hidden className="h-4 w-4" />}
            {paused ? playLabel : pauseLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
