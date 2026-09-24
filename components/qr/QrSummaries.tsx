'use client';

import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import type { GasMode, PayMode } from '@/lib/fee';
import { shortAddress } from '@/lib/format';

// ② 受取先を折りたたんだ時の 1 行サマリ。設定済なら「店舗名 · 0x1234…abcd」、
// 未設定なら fallback 文言。
export function Step2Summary({
  storeName,
  receiver,
  fallback,
}: {
  storeName: string;
  receiver: Address | null;
  fallback: string;
}) {
  if (!receiver) return <span>{fallback}</span>;
  const addr = shortAddress(receiver);
  const name = storeName.trim();
  return <span className="font-mono">{name ? `${name} · ${addr}` : addr}</span>;
}

export function SettingsSummary({
  gasMode,
  payMode,
  showGasMode,
  jpycRecover,
}: {
  gasMode: GasMode;
  payMode: PayMode;
  // 負担者 (顧客/店主) を summary にトグル選択として出すのは USDC recover 等のみ。
  // free (概念なし) / JPYC recover (merchant 固定) では選択トグルを出さない。
  showGasMode: boolean;
  // JPYC recover (確定モデルで店舗が手数料を吸収する固定) のとき true。固定であることを
  // 明示する専用ラベルを出す (USDC のトグル選択 merchant とは文言を分ける)。
  jpycRecover: boolean;
}) {
  // 高度な設定 accordion 内には payMode / gas / split のみ (quickAmount は Step ①、
  // 手数料徴収先は fee=0 のため撤去済)。summary では payMode (+ 負担者) を日本語/英語の
  // 自然文で表示する。token / chain は Step 1、receiver は Step 2 summary に出るので
  // ここでは重複させない。font-mono は外し、開発者向け内部値に見えないようにする。
  const t = useTranslations('QrGenerator');
  const label =
    payMode === 'standard'
      ? t('advancedSummary.standard')
      : jpycRecover
        ? t('advancedSummary.gaslessMerchantFixed')
        : !showGasMode
          ? t('advancedSummary.gaslessFree')
          : gasMode === 'customer'
            ? t('advancedSummary.gaslessCustomerGas')
            : t('advancedSummary.gaslessMerchantGas');
  return <span>{label}</span>;
}
