// 3-step フォーム構造の card wrapper。番号 badge + lucide icon + heading を
// 統一フォーマットで描画する。
//
// variant='qr-prominent' は Step 3 (QR 表示) を他より目立たせる brand border。
// review (2026-05-23) §2「QR コードエリアを主役にする」対応。
//
// print: variants は親 layout (app/[locale]/page.tsx の outer card) で既に
// `print:rounded-none print:border-0 print:p-0` を扱うが、StepCard 単体でも
// 印刷時は border/shadow を消す。Step 見出し (heading) 自体は print:hidden で
// 完全に消し、QR ポスター印刷に Step 番号が混ざらないようにする。

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type StepNumber = 1 | 2 | 3;
type StepVariant = 'default' | 'qr-prominent';

interface StepCardProps {
  step: StepNumber;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  variant?: StepVariant;
}

export function StepCard({
  step,
  icon: Icon,
  title,
  children,
  variant = 'default',
}: StepCardProps) {
  const borderClass =
    variant === 'qr-prominent'
      ? 'border-brand/40 ring-1 ring-brand/15 shadow-sm'
      : 'border-slate-200';
  return (
    <section
      aria-labelledby={`step-${step}-heading`}
      className={`rounded-2xl border bg-white p-5 sm:p-6 print:rounded-none print:border-0 print:p-0 print:shadow-none ${borderClass}`}
    >
      <h2
        id={`step-${step}-heading`}
        className="mb-4 flex items-center gap-2.5 text-base font-semibold text-slate-800 print:hidden"
      >
        <span
          aria-hidden
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand text-xs font-bold text-white"
        >
          {step}
        </span>
        <Icon className="h-4 w-4 flex-none text-brand" aria-hidden />
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}
