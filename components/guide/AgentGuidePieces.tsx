// /guide/agent の追加 presentational ヘルパ (PosGuidePieces の Section/BulletList/StepList/GuideFigure
// を再利用しつつ、この面固有の 2 部品だけを最小追加する)。
//
// hooks/context を使わない純 presentational なので Server/Client どちらでも描画でき、jsdom で
// 実描画テストできる (tests/components/AgentGuidePieces.test.tsx)。

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
export function CodeBlock({
  label,
  code,
}: {
  label?: string;
  code: string;
}) {
  return (
    <div className="mt-4">
      {label ? (
        <p className="mb-2 text-xs font-medium text-slate-500">{label}</p>
      ) : null}
      <pre className="overflow-x-auto rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100 ring-1 ring-slate-700">
        <code>{code}</code>
      </pre>
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
      <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
        {legacyWarning}
      </p>
    </div>
  );
}
