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
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-slate-900">{title}</h2>
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
export function StepList({
  steps,
  badgeClassName,
}: {
  steps: readonly GuideStep[];
  badgeClassName: string;
}) {
  return (
    <ol className="mt-4 space-y-4">
      {steps.map((step) => (
        <li key={step.n} className="flex items-start gap-3">
          <span
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${badgeClassName}`}
          >
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
