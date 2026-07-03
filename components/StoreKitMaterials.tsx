// 店頭告知キットの印刷素材 (A6 POP 4面付け + ドア用ステッカー)。
// ⚠️ app/[locale]/kit/page.tsx から分離している理由: Next.js の Page ファイルは
// default/generateMetadata 等の規定 export 以外の **value export を許さず**、
// StoreKitMaterials を page から export すると `next build` が
// "not a valid Page export field" で落ちる (typecheck/vitest では検出されない)。

import NextImage from 'next/image';
import { TokenLogo } from '@/components/AssetLogo';

export type StoreKitLabels = {
  pageTitle: string;
  pageDescription: string;
  printAll: string;
  a6Title: string;
  a6Description: string;
  doorTitle: string;
  doorDescription: string;
  cashOpenPayAccepted: string;
  openPayAccepted: string;
  cashLabel: string;
  jpycAccepted: string;
  siteUrl: string;
};

function A6Pop({ labels }: { labels: StoreKitLabels }) {
  return (
    <article className="box-border flex h-full flex-col justify-between border border-dashed border-slate-400 bg-white p-5 text-center [print-color-adjust:exact] print:h-[148.5mm] print:w-[105mm] print:p-[7mm] print:[print-color-adjust:exact]">
      <div>
        <NextImage
          src="/logo.svg"
          alt="OpenPay"
          width={205}
          height={48}
          className="mx-auto h-6 w-auto print:h-[9mm]"
        />
        <p className="mt-6 break-keep text-3xl font-black leading-tight text-slate-950 print:mt-[14mm] print:text-[25pt]">
          {labels.cashOpenPayAccepted}
        </p>
      </div>

      <div className="mx-auto mt-5 flex w-full max-w-[13rem] items-center justify-center gap-3 border-y border-slate-900/15 py-3 print:mt-[12mm] print:max-w-none print:gap-[5mm] print:py-[5mm]">
        <span className="text-sm font-black uppercase text-slate-950 print:text-[13pt]">
          {labels.cashLabel}
        </span>
        <span className="h-8 w-px bg-slate-300 print:h-[12mm]" aria-hidden />
        <span className="inline-flex items-center gap-2 text-sm font-black text-slate-950 print:gap-[3mm] print:text-[13pt]">
          <TokenLogo
            symbol="jpyc"
            size={32}
            alt=""
            className="h-8 w-8 shrink-0 print:h-[11mm] print:w-[11mm]"
          />
          JPYC
        </span>
      </div>

      <p className="mt-5 font-mono text-xs font-bold text-slate-700 print:mt-[10mm] print:text-[11pt]">
        {labels.siteUrl}
      </p>
    </article>
  );
}

function A6PopSheet({ labels }: { labels: StoreKitLabels }) {
  return (
    <section
      aria-labelledby="store-kit-a6-title"
      className="rounded-2xl border border-slate-200 bg-slate-100 p-4 shadow-card print:h-[297mm] print:w-[210mm] print:break-after-page print:rounded-none print:border-0 print:bg-white print:p-0 print:shadow-none print:[break-after:page]"
    >
      <div className="mb-3 print:hidden">
        <h2
          id="store-kit-a6-title"
          className="text-base font-bold text-slate-900"
        >
          {labels.a6Title}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{labels.a6Description}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 print:h-full print:w-full print:grid-cols-2 print:grid-rows-2 print:gap-0">
        {[0, 1, 2, 3].map((n) => (
          <A6Pop key={n} labels={labels} />
        ))}
      </div>
    </section>
  );
}

function DoorStickerSheet({ labels }: { labels: StoreKitLabels }) {
  return (
    <section
      aria-labelledby="store-kit-door-title"
      className="rounded-2xl border border-slate-200 bg-slate-100 p-4 shadow-card print:flex print:h-[297mm] print:w-[210mm] print:items-center print:justify-center print:rounded-none print:border-0 print:bg-white print:p-0 print:shadow-none"
    >
      <div className="mb-3 print:hidden">
        <h2
          id="store-kit-door-title"
          className="text-base font-bold text-slate-900"
        >
          {labels.doorTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {labels.doorDescription}
        </p>
      </div>

      <article className="mx-auto box-border flex aspect-square w-full max-w-[34rem] flex-col items-center justify-between rounded-[2rem] border-4 border-dashed border-slate-950 bg-white p-8 text-center [print-color-adjust:exact] print:h-[170mm] print:w-[170mm] print:rounded-[14mm] print:border-[1.4mm] print:p-[14mm] print:[print-color-adjust:exact]">
        <NextImage
          src="/logo.svg"
          alt="OpenPay"
          width={205}
          height={48}
          className="h-8 w-auto print:h-[13mm]"
        />

        <div>
          <p className="break-keep text-5xl font-black leading-tight text-slate-950 print:text-[42pt]">
            {labels.openPayAccepted}
          </p>
          <div className="mx-auto mt-6 inline-flex items-center gap-3 rounded-full border-2 border-slate-950 px-5 py-2 text-base font-black text-slate-950 print:mt-[14mm] print:gap-[5mm] print:border-[0.8mm] print:px-[8mm] print:py-[3mm] print:text-[18pt]">
            <TokenLogo
              symbol="jpyc"
              size={36}
              alt=""
              className="h-9 w-9 shrink-0 print:h-[13mm] print:w-[13mm]"
            />
            {labels.jpycAccepted}
          </div>
        </div>

        <p className="font-mono text-sm font-bold text-slate-700 print:text-[15pt]">
          {labels.siteUrl}
        </p>
      </article>
    </section>
  );
}

export function StoreKitMaterials({ labels }: { labels: StoreKitLabels }) {
  return (
    <div className="space-y-8 print:space-y-0">
      <A6PopSheet labels={labels} />
      <DoorStickerSheet labels={labels} />
    </div>
  );
}
