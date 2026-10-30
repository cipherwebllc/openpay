'use client';

// 受取先が未設定のときだけ会計画面に出す受取先の欄 (QR を出す唯一の前提・設定済みなら「お店の設定」シートの中)。
// 状態は持たない — 出すかどうか (receiverInline)・受取先の解決と自動補完は親の QrGenerator が持つ。

import { useTranslations } from 'next-intl';
import type { Address, Chain } from 'viem';
import { QrReceiverFields } from '@/components/qr/QrReceiverSection';
import type { QrSettings } from '@/hooks/useQrSettings';
import type { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import type { TokenDeployment } from '@/lib/tokens';

export function ReceiverInlineSection({
  settings,
  deployment,
  chain,
  effectiveReceiver,
  receiverValid,
  autofill,
  handleResolved,
}: {
  settings: QrSettings;
  deployment: TokenDeployment;
  chain: Chain;
  effectiveReceiver: Address | null;
  receiverValid: boolean;
  autofill: ReturnType<typeof useReceiverAutofill>;
  handleResolved: (addr: Address | null) => void;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <section
      aria-labelledby="qr-receiver-inline-heading"
      className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70"
    >
      <h2 id="qr-receiver-inline-heading" className="text-sm font-semibold text-slate-800">
        {t('receiverInline.title')}
      </h2>
      <p className="mb-3 mt-0.5 text-xs text-slate-500">{t('receiverInline.hint')}</p>
      <QrReceiverFields
        settings={settings}
        deployment={deployment}
        chain={chain}
        effectiveReceiver={effectiveReceiver}
        receiverValid={receiverValid}
        autofill={autofill}
        handleResolved={handleResolved}
        bare
      />
    </section>
  );
}
