'use client';

// Recover モードの手数料開示を 1 箇所に集約した共有コンポーネント。
// QrGenerator / PaymentForm / CheckoutForm / TipForm の 4 経路から使われる。
//
// 役割:
//   1. buildRecoverFeeDisplay を呼んで数値ブロック (手数料/分担/tooSmall) を得る。
//      FREE モード (forwarder 未設定) または billAmount=0 では null → 何も描画しない
//      = 現行挙動 (free 経路に開示パネルは出ない) に一致。
//   2. RecoverFee 名前空間の i18n でラベル (手数料行 + 分担行 / 警告行) を組み立てる。
//      以前は QrGenerator と PaymentForm に同一ロジックが重複していたのをここへ一元化。
//   3. amber のパネルとして描画 (旧 RecoverFeeDisclosurePanel のマークアップを吸収)。
//
// bps=0 → 固定ガス開示、bps>0 → % 開示。gasMode=merchant かつ billAmount<=fee の
// ときは分担行 (受取がマイナスになる) ではなく「受付不可」の警告行を出す (F2)。

import { useTranslations } from 'next-intl';
import { buildRecoverFeeDisplay } from '@/lib/recoverFeeDisplay';

type Props = {
  /** 請求額 (wei・18 decimals)。null / 0 では何も描画しない。 */
  billAmount: bigint | null;
  /** 受取チェーン ID (forwarder 設定の有無を引くのに使う)。 */
  chainId: number;
  /** 手数料の負担者。customer=お客様上乗せ / merchant=店舗吸収。 */
  gasMode: 'customer' | 'merchant';
};

export function RecoverFeeNotice({ billAmount, chainId, gasMode }: Props) {
  const t = useTranslations('RecoverFee');

  if (billAmount === null || billAmount <= 0n) return null;
  const disclosure = buildRecoverFeeDisplay(billAmount, chainId, gasMode);
  if (disclosure === null) return null;

  const feeLabel =
    disclosure.bps === 0
      ? t('disclosureGasOnly', { feeHuman: disclosure.feeHuman })
      : t('disclosurePercent', {
          feeHuman: disclosure.feeHuman,
          pct: disclosure.bps / 100,
          floorHuman: disclosure.floorHuman,
        });

  // merchant 負担で金額が手数料以下 → 受取がマイナス。分担行ではなく受付不可の警告。
  if (disclosure.tooSmall) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
        <p className="font-semibold">{feeLabel}</p>
        <p className="mt-0.5 font-semibold text-amber-800">
          {t('tooSmall', { fee: disclosure.feeHuman })}
        </p>
      </div>
    );
  }

  // customer 負担はチップ (/tip・@handle) 専用 (確定モデルで決済は merchant 固定)。
  // 受取側はお店ではなくクリエイターになりうるため中立な「受取」+ 内訳 (チップ + 手数料)
  // を出す。merchant 負担は決済 (店舗が手数料を吸収) の分担行。
  const splitLabel =
    disclosure.gasMode === 'customer'
      ? t('splitCustomer', {
          customerPays: disclosure.customerPaysHuman,
          merchantReceives: disclosure.merchantReceivesHuman,
          fee: disclosure.feeHuman,
        })
      : t('splitMerchant', {
          customerPays: disclosure.customerPaysHuman,
          merchantReceives: disclosure.merchantReceivesHuman,
        });

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
      <p className="font-semibold">{feeLabel}</p>
      <p className="mt-0.5 text-amber-800">{splitLabel}</p>
    </div>
  );
}
