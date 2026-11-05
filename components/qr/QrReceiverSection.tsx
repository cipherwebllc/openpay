'use client';

import { useId, type Dispatch, type SetStateAction } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
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
  'h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm';

// 受取先の欄 (アドレス / 接続中のウォレット / 形式の誤り / Explorer)。受取先の解決と自動補完は QrGenerator が持ち、
// ここは描画と入力の反映だけ。「お店の設定」シートと、受取先が未設定のときの会計画面の欄の両方で使う
// (決済QR とレジの両方)。欄が空の間だけ「ウォレットをお持ちでない方へ」を出し、ガイド「ウォレットを選ぶ」の
// お店の受け取り用の節 (/guide/wallet#store-wallet) へ送る (2026-11-06 user)。外のウォレットのサイトへ直接は飛ばさない
// (受け取るチェーンや売上の移し方の注意を読んでから選んでもらうため)。
export function QrReceiverFields({
  settings,
  deployment,
  chain,
  effectiveReceiver,
  receiverValid,
  autofill,
  handleResolved,
  bare = false,
  labelledBy,
}: {
  settings: QrSettings;
  deployment: TokenDeployment;
  chain: Chain;
  effectiveReceiver: Address | null;
  receiverValid: boolean;
  autofill: ReturnType<typeof useReceiverAutofill>;
  handleResolved: (addr: Address | null) => void;
  /** 欄の見出しを出さない (会計画面の「受け取るウォレット」の節は見出しが既にある)。 */
  bare?: boolean;
  /** bare のとき、欄の名前にする節の見出しの id (読み上げで欄の名前が placeholder だけにならないように)。 */
  labelledBy?: string;
}) {
  const t = useTranslations('QrGenerator');
  const tFee = useTranslations('UsageFee');
  const locale = useLocale();
  const inputId = useId();
  // 中身は同じ要素の並びのまま、外枠だけ切り替える (描画のたびに部品を作り直さない = 入力中の focus を失わない)。
  const content = (
    <>
      <AddressInput
        id={bare ? undefined : inputId}
        labelledBy={bare ? labelledBy : undefined}
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
      {/* 入力したら消える (空白だけは空とみなす)。リンクの名前は可視の文字だけ (掟 8)。 */}
      {!settings.receiver.trim() && (
        <p className="mt-0.5">
          <Link
            href={`/${locale}/guide/wallet#store-wallet`}
            prefetch={false}
            className="inline-flex min-h-11 items-center text-xs font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
          >
            {t('noWalletGuideLink')}
          </Link>
        </p>
      )}
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
          className="mt-0.5 flex min-h-11 items-center text-xs text-brand underline underline-offset-2 hover:opacity-80"
        >
          {t('merchantExplorerLink', { chainName: chain.name })}
        </a>
      )}
    </>
  );
  return bare ? <div>{content}</div> : <Field label={t('receiverLabel')} htmlFor={inputId}>{content}</Field>;
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
  const inputId = useId();
  return (
    <Field label={t('storeNameLabel')} htmlFor={inputId}>
      <input
        id={inputId}
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
  const posterNoteId = useId();
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

      <Field label={t('posterNoteLabel')} htmlFor={posterNoteId}>
        <input
          id={posterNoteId}
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
