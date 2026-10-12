// /guide/pos の純 presentational ヘルパ。
//
// page.tsx (Server Component) から使うが、AppShell など重い依存 (wagmi/ConnectButton)
// を持たないので jsdom で実描画テストできる (tests/components/PosGuidePieces.test.tsx)。
// hooks/context を使わないため Server/Client どちらでも描画可。

import type { ReactNode } from 'react';
import type { GuideImage, GuideStep } from '@/lib/posGuide';

// public/guide/<file> の SVG 図版の intrinsic 寸法 (CLS 防止の width/height 用)。
// POS_GUIDE が参照する全 file がここに entry を持つことを test で強制する
// (未登録だと下の ?? フォールバックで誤比率描画になるため・黙殺防止)。
export const FIGURE_DIMS: Record<string, { w: number; h: number }> = {
  'hero.webp': { w: 1280, h: 640 },
  'overview-flow.svg': { w: 1000, h: 320 },
  'pos-add-method.svg': { w: 760, h: 480 },
  'four-steps.svg': { w: 1100, h: 280 },
  'payment-success.svg': { w: 420, h: 720 },
  'history-reconcile.svg': { w: 1000, h: 420 },
  'cost-compare.svg': { w: 900, h: 360 },
  'refund-not-reversal.svg': { w: 1000, h: 500 },
};

// 標準セクション (mt-10 + 見出し)。カード型の できること/cannot・CTA は独自スタイルなので使わない。
/**
 * ガイドの節。`badge` を渡すと見出しの左に番号のバッジを出す (見出しの文字に「1.」を入れない)。
 * `toc={false}` は「このページの内容」(GuideToc) に載せない節 (動画・関連ガイドなど)。
 * GuideToc は data-toc-label (バッジを除いた見出し) を読む。
 */
export function Section({
  title,
  children,
  badge,
  toc = true,
}: {
  title: string;
  children: ReactNode;
  badge?: number | string;
  toc?: boolean;
}) {
  return (
    <section className="mt-12">
      <h2
        data-toc={toc ? undefined : 'skip'}
        data-toc-label={title}
        className="flex items-start gap-3 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl"
      >
        {badge !== undefined ? <span className={`${STEP_BADGE} mt-0.5 sm:mt-1`}>{badge}</span> : null}
        <span className="min-w-0">{title}</span>
      </h2>
      {children}
    </section>
  );
}

// 箇条書き (できること=✓ / その他=•・マーカー色のみ可変)。
export function BulletList({
  items,
  marker,
  markerClassName,
}: {
  items: readonly string[];
  marker: string;
  markerClassName: string;
}) {
  return (
    <ul className="mt-3 space-y-2">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
        >
          <span aria-hidden className={`mt-0.5 ${markerClassName}`}>
            {marker}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// 番号付きステップ (準備=淡色バッジ / 会計フロー=濃色バッジ・バッジ配色のみ可変)。
// 手順の番号のバッジ (全ガイドで 1 つの型・plans/guide-ux-polish.md フェーズ 1)。以前は濃淡 2 色と大きさ 3 種が混ざっていた。
export const STEP_BADGE =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white';
/** お客様 (支払う側) の手順の番号。色だけ blue (お店 = emerald / お客様 = blue の配色)。 */
export const STEP_BADGE_CUSTOMER =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white';

/** `badgeClassName` にお客様の手順は STEP_BADGE_CUSTOMER を渡す (既定はお店の STEP_BADGE)。 */
export function StepList({
  steps,
  badgeClassName = STEP_BADGE,
}: {
  steps: readonly GuideStep[];
  badgeClassName?: string;
}) {
  return (
    <ol className="mt-4 space-y-4">
      {steps.map((step) => (
        <li key={step.n} className="flex items-start gap-3">
          <span className={badgeClassName}>
            {step.n}
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-900">{step.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">
              {step.body}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// 静的 SVG 図版を描画 (最適化不要なので素の <img>・既存 HandleProfile 等と同方針)。
export function GuideFigure({
  image,
  className,
  caption,
}: {
  image: GuideImage;
  className?: string;
  caption?: string;
}) {
  const dims = FIGURE_DIMS[image.file] ?? { w: 1200, h: 675 };
  return (
    <figure className={className ?? 'my-6'}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/guide/${image.file}`}
        alt={image.alt}
        width={dims.w}
        height={dims.h}
        loading="lazy"
        className="h-auto w-full rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
      />
      {caption ? (
        <figcaption className="mt-2 text-center text-xs leading-relaxed text-slate-500">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
