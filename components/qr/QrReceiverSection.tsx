'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import type { Address, Chain } from 'viem';
import { Store } from 'lucide-react';
import { env } from '@/lib/env';
import { AddressInput } from '../AddressInput';
import { ReceiverWalletChip } from '../ReceiverWalletChip';
import { Field } from '../Field';
import { StepCard } from '../StepCard';
import { Step2Summary } from './QrSummaries';
import {
  POSTER_NOTE_MAX,
  STORE_NAME_MAX,
  type QrSettings,
} from '@/hooks/useQrSettings';
import type { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import type { TokenDeployment } from '@/lib/tokens';
import { addressExplorerUrl } from '@/lib/chains';
import { isLikelyName } from '@/lib/nameDetection';

// ② 受取先 (受取ウォレット / 店舗名 / ポスター補足文)。開閉状態・受取先の解決と
// 自動補完は QrGenerator が持ち、ここは描画と入力の反映だけを行う。
export function QrReceiverSection({
  settings,
  setSettings,
  deployment,
  chain,
  step2Open,
  setStep2Open,
  effectiveReceiver,
  receiverValid,
  autofill,
  handleResolved,
}: {
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  deployment: TokenDeployment;
  chain: Chain;
  step2Open: boolean;
  setStep2Open: Dispatch<SetStateAction<boolean>>;
  effectiveReceiver: Address | null;
  receiverValid: boolean;
  autofill: ReturnType<typeof useReceiverAutofill>;
  handleResolved: (addr: Address | null) => void;
}) {
  const t = useTranslations('QrGenerator');
  const tFee = useTranslations('UsageFee');
  return (
    <StepCard
      step={2}
      icon={Store}
      title={t('steps.receiver')}
      collapsible
      open={step2Open}
      onToggle={() => setStep2Open((o) => !o)}
      collapsedSummary={
        <Step2Summary
          storeName={settings.storeName}
          receiver={effectiveReceiver}
          fallback={t('steps.receiverNotSet')}
        />
      }
    >
      <div className="space-y-4">
        <Field label={t('receiverLabel')}>
          <AddressInput
            value={settings.receiver}
            onChange={autofill.handleManualChange}
            onResolved={handleResolved}
          />
          <ReceiverWalletChip
            canUse={autofill.canUseConnected}
            matches={autofill.matchesConnected}
            onUse={autofill.useConnectedWallet}
            useLabel={t('useConnectedWallet')}
            matchLabel={t('receiverMatchesWallet')}
          />
          {settings.receiver &&
            !receiverValid &&
            !isLikelyName(settings.receiver) && (
              <p className="mt-1 text-xs text-red-600">
                {t('addressInvalid')}
              </p>
            )}
          {/* a1 利用料の注記: 受取先が接続ウォレットと違うとき、ガスレス利用料の請求/支払いは
              その受取先アドレスでサインインする必要がある (請求は着金先に紐づくため)。a1 点灯時のみ。 */}
          {env.enableUsageFee &&
            autofill.canUseConnected &&
            effectiveReceiver && (
              <p className="mt-1 text-xs text-amber-700">
                {tFee('receiverMismatchNote')}
              </p>
            )}
          {/* 受取先確定後に Explorer の /address/ へ link (チェーン上が source of
              truth であることを店主に毎回視認させる)。 */}
          {effectiveReceiver && (
            <a
              href={addressExplorerUrl(deployment.chainId, effectiveReceiver)}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-flex text-xs text-brand underline underline-offset-2 hover:opacity-80"
            >
              {t('merchantExplorerLink', { chainName: chain.name })}
            </a>
          )}
        </Field>

        <Field label={t('storeNameLabel')}>
          <input
            type="text"
            value={settings.storeName}
            onChange={(e) =>
              setSettings((s) => ({ ...s, storeName: e.target.value }))
            }
            placeholder={t('storeNamePlaceholder')}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
            maxLength={STORE_NAME_MAX}
          />
        </Field>

        <Field label={t('posterNoteLabel')}>
          <input
            type="text"
            value={settings.posterNote}
            onChange={(e) =>
              setSettings((s) => ({ ...s, posterNote: e.target.value }))
            }
            placeholder={t('posterNotePlaceholder')}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
            maxLength={POSTER_NOTE_MAX}
          />
        </Field>
      </div>
    </StepCard>
  );
}
