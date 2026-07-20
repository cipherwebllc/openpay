// /guide/mobile-order 専用の描画部品。手順 = 番号バッジ + 短文 + 実機スクショ (縦長スマホ画面)。
// PosGuidePieces の GuideFigure は横長 SVG 図版前提 (寸法 fallback 1200x675) のため、
// 縦長スクショ用に実寸 width/height を受けて CLS を防ぐ専用 figure を持つ。

import type { MobileOrderGuideStep } from '@/lib/mobileOrderGuide';

export function StepShot({ step }: { step: MobileOrderGuideStep }) {
  return (
    <li className="grid gap-4 sm:grid-cols-[1fr_240px] sm:items-start sm:gap-6">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-emerald-600 text-base font-bold text-white">
          {step.n}
        </span>
        <div>
          <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{step.body}</p>
        </div>
      </div>
      <figure className="mx-auto w-full max-w-[240px] sm:mx-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/guide/mobile-order/${step.image.file}`}
          alt={step.image.alt}
          width={step.image.width}
          height={step.image.height}
          loading="lazy"
          className="h-auto w-full rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70"
        />
      </figure>
    </li>
  );
}
