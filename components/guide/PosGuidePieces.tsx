// /guide/pos の純 presentational ヘルパ。
//
// page.tsx (Server Component) から使うが、AppShell など重い依存 (wagmi/ConnectButton)
// を持たないので jsdom で実描画テストできる (tests/components/PosGuidePieces.test.tsx)。
// hooks/context を使わないため Server/Client どちらでも描画可。

import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight } from 'lucide-react';
import { keepNumbersTogether } from '@/lib/guideText';
import type { GuideImage, GuideStep } from '@/lib/posGuide';

// public/guide/<file> の SVG 図版の intrinsic 寸法 (CLS 防止の width/height 用)。
// POS_GUIDE が参照する全 file がここに entry を持つことを test で強制する
// (未登録だと下の ?? フォールバックで誤比率描画になるため・黙殺防止)。
export const FIGURE_DIMS: Record<string, { w: number; h: number }> = {
  'pos-add-method.svg': { w: 760, h: 480 },
  'history-reconcile.svg': { w: 1000, h: 420 },
  'refund-not-reversal.svg': { w: 1000, h: 500 },
};

// 標準セクション (mt-10 + 見出し)。カード型の できること/cannot・CTA は独自スタイルなので使わない。
/**
 * ガイドの節。`badge` を渡すと見出しの左に番号のバッジを出す (見出しの文字に「1.」を入れない)。
 * `toc={false}` は「このページの内容」(GuideToc) に載せない節 (動画・関連ガイドなど)。
 * GuideToc は data-toc-label (バッジを除いた見出し) を読む。
 */
/**
 * 見出しの id。題名から作り、server の HTML に出す (#id で開いた・再読み込みしたときも飛べる)。
 * 以前は描画後に JS で section-<番号> を振っていて、直接開くと先頭で止まり、節を足すと番号がずれた
 * (plans/guide-ux-polish-2.md P4)。空白は '-'、区切りの記号は除く。題名を変えると id も変わる。
 */
export function guideHeadingId(title: string): string {
  return title
    .trim()
    .replace(/[()（）「」『』【】、。・:：,.?？!！"'“”‘’]/g, '')
    .replace(/\s+/g, '-');
}

export function Section({
  title,
  children,
  badge,
  toc = true,
  id,
}: {
  title: string;
  children: ReactNode;
  badge?: number | string;
  toc?: boolean;
  /** ほかのページから #id で飛んでくる節だけに付ける (無い h2 は GuideToc が section-<番号> を振る)。 */
  id?: string;
}) {
  return (
    <section className="mt-12">
      <h2
        id={id ?? guideHeadingId(title)}
        data-toc={toc ? undefined : 'skip'}
        data-toc-label={title}
        className="flex items-start gap-3 text-xl font-bold tracking-tight text-slate-900 [word-break:auto-phrase] sm:text-2xl"
      >
        {badge !== undefined ? <span className={`${STEP_BADGE} mt-0.5 sm:mt-1`}>{badge}</span> : null}
        <span className="min-w-0">{keepNumbersTogether(title)}</span>
      </h2>
      {children}
    </section>
  );
}

// 箇条書き (できること・確かめること = ✓ (緑) / 事実の列挙 = • (灰))。マーカーの色は記号で決め、ページごとに変えない
// (以前は • が緑・灰・琥珀でページごとに違った・plans/guide-ux-polish-2.md P5)。
export function BulletList({ items, marker }: { items: readonly string[]; marker: '✓' | '•' }) {
  const markerClassName = marker === '✓' ? 'text-emerald-600' : 'text-slate-400';
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

/**
 * 題のない 1 行ずつの手順 (決済QR の流れ・レジの手順・ストアの始め方など)。li に text-sm を付けて、GuideFrame の本文の
 * 拡大 (15px / sm 以上 16px・行間 28px) を効かせる (以前は span の text-sm で、手順だけ本文より小さい 14px だった・P6)。
 * お客様の手順は badgeClassName={STEP_BADGE_CUSTOMER}。
 */
export function StepLines({ steps, badgeClassName = STEP_BADGE }: { steps: readonly string[]; badgeClassName?: string }) {
  return (
    <ol className="mt-4 space-y-3">
      {steps.map((step, i) => (
        <li key={step} className="flex items-start gap-3 text-sm leading-relaxed text-slate-700">
          <span className={badgeClassName}>{i + 1}</span>
          <span className="min-w-0 break-words">{step}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 「A → B → C」の流れのチップ (start の償還・image-url の手順)。スマホは縦に積んで下向きの矢印にし、
 * 折り返しで矢印だけが行頭に取り残されるのを避ける (plans/guide-ux-polish-2.md P4)。sm 以上は横に並べる。
 */
export function GuideFlow({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="mt-4 flex flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2 sm:gap-y-2">
      {steps.map((step, i) => (
        <li key={step} className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
          {i > 0 ? (
            <span aria-hidden className="pl-4 text-slate-400 sm:pl-0">
              <ArrowDown className="h-3.5 w-3.5 sm:hidden" />
              <ArrowRight className="hidden h-3.5 w-3.5 sm:block" />
            </span>
          ) : null}
          <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700">{step}</span>
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
