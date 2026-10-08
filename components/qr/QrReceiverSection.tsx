'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import type { Address, Chain } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '../AddressInput';
import { ReceiverWalletChip } from '../ReceiverWalletChip';
import { Field } from '../Field';
import { InvoiceNumberInput } from '../InvoiceNumberInput';
import {
  POSTER_NOTE_MAX,
  STORE_NAME_MAX,
  type QrSettings,
} from '@/hooks/useQrSettings';
import type { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import type { TokenDeployment } from '@/lib/tokens';
import { addressExplorerUrl } from '@/lib/chains';
import { isLikelyName } from '@/lib/nameDetection';

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';

// 受取先の欄 (アドレス / 接続中のウォレット / 形式の誤り / Explorer)。受取先の解決と自動補完は QrGenerator が持ち、
// ここは描画と入力の反映だけ。「お店の設定」シートと、受取先が未設定のときの会計画面の欄の両方で使う。
export function QrReceiverFields({
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
  const tFee = useTranslations('UsageFee');
  return (
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
          className="mt-2 flex text-xs text-brand underline underline-offset-2 hover:opacity-80"
        >
          {t('merchantExplorerLink', { chainName: chain.name })}
        </a>
      )}
    </Field>
  );
}

// 店舗名 (お店の設定シート)。
export function QrStoreNameField({
  settings,
  setSettings,
}: {
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <Field label={t('storeNameLabel')}>
      <input
        type="text"
        value={settings.storeName}
        onChange={(e) =>
          setSettings((s) => ({ ...s, storeName: e.target.value }))
        }
        placeholder={t('storeNamePlaceholder')}
        className={INPUT_CLASS}
        maxLength={STORE_NAME_MAX}
      />
    </Field>
  );
}

// 控えとポスター (インボイス登録番号 / ポスターの補足文・お店の設定シート)。
export function QrReceiptPosterFields({
  settings,
  setSettings,
}: {
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <>
      <Field label={t('invoiceNoLabel')} htmlFor="qr-invoice-no">
        <InvoiceNumberInput
          id="qr-invoice-no"
          value={settings.invoiceNo}
          onChange={(next) => setSettings((s) => ({ ...s, invoiceNo: next }))}
          hasStoreName={settings.storeName.trim().length > 0}
          className={INPUT_CLASS}
          text={{
            invalid: t('invoiceNoInvalid'),
            lookup: t('invoiceNoLookup'),
            needsStoreName: t('invoiceNoNeedsStoreName'),
          }}
        />
        <p className="mt-1 text-xs text-slate-500">{t('invoiceNoHint')}</p>
      </Field>

      <Field label={t('posterNoteLabel')}>
        <input
          type="text"
          value={settings.posterNote}
          onChange={(e) =>
            setSettings((s) => ({ ...s, posterNote: e.target.value }))
          }
          placeholder={t('posterNotePlaceholder')}
          className={INPUT_CLASS}
          maxLength={POSTER_NOTE_MAX}
        />
      </Field>
    </>
  );
}
