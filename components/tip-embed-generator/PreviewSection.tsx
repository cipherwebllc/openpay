'use client';

// 「プレビュー」のカード: 実 TipForm をスマホ枠で描く。状態は持たない (params は親の TipEmbedGenerator が作る)。

import dynamic from 'next/dynamic';
import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SectionCard } from '@/components/SectionCard';
import type { ChainSlug } from '@/lib/chains';
import type { TokenSymbol } from '@/lib/tokens';
import type { TipParams } from '@/lib/url';

const TipFormPreview = dynamic(
  () => import('@/components/TipForm').then((mod) => mod.TipForm),
  { ssr: false },
);

export function PreviewSection({
  params,
  token,
  chain,
  activePresets,
}: {
  params: TipParams | null;
  token: TokenSymbol;
  chain: ChainSlug;
  activePresets: string[];
}) {
  const t = useTranslations('TipEmbedGenerator');
  return (
    <SectionCard title={t('previewTitle')} headingId="tip-preview-heading" icon={Eye}>
      <div
        data-testid="tip-preview-frame"
        className="mx-auto max-w-[360px] overflow-hidden rounded-[2rem] border-[6px] border-slate-900 bg-white shadow-xl ring-1 ring-black/5"
      >
        {/* 高さは控えめにして (max-h-[46vh]・プロフ/モバイル注文と同じ契約)、
            サイド列自身のスクロールバーと内側バーが隣り合って二重に見えるのを避ける
            (2026-07-29 実機報告: 56vh では右カラムが視界を超え二重スクロール化)。 */}
        <div
          data-testid="tip-preview-scroll"
          className="max-h-[46vh] overflow-y-auto bg-slate-50 p-3"
        >
          {params && <TipFormPreview
            key={`${token}:${chain}:${activePresets.join(',')}`}
            params={params}
            preview
          />}
        </div>
      </div>
    </SectionCard>
  );
}
