// 3-step フォーム構造の card wrapper。番号 badge + lucide icon + heading を
// 統一フォーマットで描画する。
//
// variant='qr-prominent' は Step 3 (QR 表示) を他より目立たせる brand border。
// review (2026-05-23) §2「QR コードエリアを主役にする」対応。
//
// collapsible=true で heading が toggle button になり、open=false の間は children
// を mount しない (DOM 軽量化 + 折り畳み内 button の test ノイズ排除)。collapsedSummary
// を渡すと閉時に heading 横に preview として描画。
// review (2026-05-23) §後追い: Step 2 (受取先) は設定後変更頻度が低いので折り畳み可能に。
//
// print: variants は親 layout (app/[locale]/page.tsx の outer card) で既に
// `print:rounded-none print:border-0 print:p-0` を扱うが、StepCard 単体でも
// 印刷時は border/shadow を消す。Step 見出し (heading) 自体は print:hidden で
// 完全に消し、QR ポスター印刷に Step 番号が混ざらないようにする。

import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

type StepNumber = 1 | 2 | 3 | 4;
type StepVariant = 'default' | 'qr-prominent';

interface StepCardProps {
  step: StepNumber;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  variant?: StepVariant;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  collapsedSummary?: ReactNode;
}

export function StepCard({
  step,
  icon: Icon,
  title,
  children,
  variant = 'default',
  collapsible = false,
  open = true,
  onToggle,
  collapsedSummary,
}: StepCardProps) {
  // 面の浮き (shadow-card) で奥行きを出し、境界線への依存を減らす (tailwind の影トークン方針)。
  const borderClass =
    variant === 'qr-prominent'
      ? 'ring-1 ring-brand/25 shadow-card'
      : 'ring-1 ring-slate-200/70 shadow-card';
  // collapsible mode は onToggle が必要。onToggle を渡さずに collapsible=true
  // だけ立てると user が永遠に開けない broken state になるため、その場合は
  // 非 collapsible として扱い children を常時 mount で fall-through する
  // (defensive)。これによって caller のバグが silent UX 破綻にならない。
  const effectivelyCollapsible = collapsible && Boolean(onToggle);
  // 中身を mount する条件: 非 collapsible か、collapsible かつ open。
  // 閉じている間に Field 内の input / button を mount すると test の query が
  // 過剰一致するため、思い切って unmount で揃える (DOM 軽量化も兼ねる)。
  const showChildren = !effectivelyCollapsible || open;
  const headingId = `step-${step}-heading`;

  const innerHeading = (
    <span
      id={headingId}
      className="flex flex-1 items-center gap-2.5 text-base font-semibold text-slate-800"
    >
      <span
        aria-hidden
        className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand text-xs font-bold text-white shadow-[0_2px_8px_-2px_rgba(37,99,235,0.5)]"
      >
        {step}
      </span>
      <Icon className="h-4 w-4 flex-none text-brand" aria-hidden />
      <span>{title}</span>
      {effectivelyCollapsible && !open && collapsedSummary && (
        <span className="ml-2 truncate text-xs font-normal text-slate-500">
          {collapsedSummary}
        </span>
      )}
    </span>
  );

  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-2xl bg-white p-5 sm:p-6 print:rounded-none print:p-0 print:shadow-none print:ring-0 ${borderClass}`}
    >
      {/* heading は h2 (semantic) で囲む。collapsible のときは h2 の中に button
          を置き、その button が aria-expanded を expose する形式 (W3C ARIA
          Authoring Practices "Disclosure" pattern)。h2 自体を button にすると
          内側に span(badge)/Icon/span(title) を入れた時に accessible name が
          冗長になる + ChevronDown が title に混ざるため分離する。 */}
      <h2 className="flex items-center print:hidden">
        {effectivelyCollapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`step-${step}-body`}
            className="-m-1 flex w-full items-center gap-2 rounded-md p-1 text-left hover:bg-slate-50"
          >
            {innerHeading}
            <ChevronDown
              className={`h-4 w-4 flex-none text-slate-400 transition-transform ${
                open ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>
        ) : (
          innerHeading
        )}
      </h2>
      {showChildren && (
        <div id={`step-${step}-body`} className="mt-4">
          {children}
        </div>
      )}
    </section>
  );
}
