'use client';

// 顧客の初回決済 (/pay) 向けの「3ステップ」視覚ガイド。文章説明より先に
// 「接続 → 金額確認 → 署名で完了」をアイコンで一目に示し、初めてクリプト決済する
// 人の不安を下げる。未接続時のみ表示する想定 (接続後は不要)。
// 「アプリDL・登録不要」を添えてハードルの低さを明示する。

import { Wallet, Eye, PenLine } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function PayStepStrip() {
  const t = useTranslations('PaymentForm');
  const steps = [
    { icon: Wallet, label: t('step1') },
    { icon: Eye, label: t('step2') },
    { icon: PenLine, label: t('step3') },
  ];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <ol className="flex items-stretch justify-between gap-1">
        {steps.map((s, i) => (
          <li
            key={i}
            className="flex flex-1 flex-col items-center gap-1.5 text-center"
          >
            <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-brand/10 text-brand">
              <s.icon className="h-5 w-5" aria-hidden />
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">
                {i + 1}
              </span>
            </span>
            <span className="text-[11px] font-medium leading-tight text-slate-600">
              {s.label}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-center text-[11px] text-slate-500">
        {t('stepNote')}
      </p>
    </div>
  );
}
