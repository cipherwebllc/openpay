
// /guide/agent の追加 presentational ヘルパ (PosGuidePieces の Section/BulletList/StepList/GuideFigure
// を再利用しつつ、この面固有の 2 部品だけを最小追加する)。
//
// hooks/context を使わない純 presentational なので Server/Client どちらでも描画でき、jsdom で
// 実描画テストできる (tests/components/AgentGuidePieces.test.tsx)。CodeBlock の「コピー」だけは client の小部品。

import { TriangleAlert } from 'lucide-react';
import { CopyCodeButton } from '@/components/guide/CopyCodeButton';

// ページ冒頭のヒーロー画像 (実 UI 3 画面の合成: AI 会話→事前充填→決済手前)。装飾 SVG でなく実 UI
// 撮影ゆえ public/guide-agent/ に置く (public/guide/ は posGuide の孤児検査対象なので分離)。width/height
// を明示して CLS を防ぎ、ring+shadow-card で他の面と統一。言語非依存の画像で alt のみ locale 別。
export function GuideHero({
  image,
}: {
  image: { src: string; alt: string; width: number; height: number };
}) {
  return (
    <figure className="mt-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.src}
        alt={image.alt}
        width={image.width}
        height={image.height}
        className="h-auto w-full rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
      />
    </figure>
  );
}

// MCP 設定 JSON 等のコードブロック。長い行は overflow-x-auto で内側スクロールさせ、ページ本文を
// 横にはみ出させない (掟: grid_cols1_mobile_overflow の水平あふれ回避)。
// これより長い行を含むコードは折り返さずに横スクロールにする (390px の画面で 12px の等幅が 1 行に入る目安)。
const CODE_WRAP_MAX = 44;

export function CodeBlock({
  label,
  code,
}: {
  label?: string;
  code: string;
}) {
  // 短い行だけのブロック (env・JSON・1 行のコマンド) は折り返して全部見せる。長い行を含むコード (プログラム) は
  // 横にスクロールさせ、右端をぼかして「続きがある」と分かるようにする (以前は 390px で行が黙って切れていた)。
  const scrolls = code.split('\n').some((line) => line.length > CODE_WRAP_MAX);
  return (
    <div className="mt-4">
      {/* 名前の行の右に「コピー」(貼るためのコードを全文写せる)。 */}
      <div className="mb-2 flex items-end justify-between gap-3">
        {label ? <p className="text-xs font-medium text-slate-500">{label}</p> : <span />}
        <CopyCodeButton code={code} />
      </div>
      <div
        className={
          scrolls
            ? 'relative after:pointer-events-none after:absolute after:inset-y-px after:right-px after:w-8 after:rounded-r-xl after:bg-gradient-to-l after:from-slate-900 after:content-[""]'
            : undefined
        }
      >
        <pre
          className={`rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100 ring-1 ring-slate-700 ${
            scrolls ? 'overflow-x-auto [scrollbar-width:thin]' : 'whitespace-pre-wrap break-all'
          }`}
        >
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

// JPYC コントラクトアドレスを、コピペ確認しやすいモノスペースで目立たせて表示する。42 文字の hex は
// break-all でモバイルでも折り返し、水平あふれを起こさない。旧 v1 誤スワップ注意を隣に併記する。
export function AddressCallout({
  label,
  address,
  chainNote,
  legacyWarning,
}: {
  label: string;
  address: string;
  chainNote: string;
  legacyWarning: string;
}) {
  return (
    <div className="mt-4 rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 break-all font-mono text-sm font-semibold text-slate-900">
        {address}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{chainNote}</p>
      {/* カードの中に箱を重ねず、警告のアイコン付きの 1 行にする。 */}
      <p className="mt-2 flex gap-1.5 text-xs leading-relaxed text-amber-800">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{legacyWarning}</span>
      </p>
    </div>
  );
}
