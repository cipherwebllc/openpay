'use client';

// 受取ウォレットの入力。受取先が決まるまでは注文カードの先頭に、決まったら設定シートに出す。

import { useTranslations } from 'next-intl';
import { AddressInput } from '@/components/AddressInput';
import { ReceiverWalletChip } from '@/components/ReceiverWalletChip';
import { ORDER_LINK_INPUT_CLASS } from './OrderLinkAmountField';

export function OrderLinkReceiverFields({
  value,
  onChange,
  connected,
  canUseConnected,
  matchesConnected,
  onUseConnected,
  hideLabel = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** ウォレットを接続しているか (空欄のときの案内を変える)。 */
  connected: boolean;
  canUseConnected: boolean;
  matchesConnected: boolean;
  onUseConnected: () => void;
  /** 見出しが外側にあるとき (設定シート) は読み上げ用だけにする。 */
  hideLabel?: boolean;
}) {
  const t = useTranslations('OrderLinkBuilder');
  return (
    <div>
      <label
        htmlFor="order-link-receiver"
        className={hideLabel ? 'sr-only' : 'mb-1.5 block text-sm font-semibold text-slate-800'}
      >
        {t('receiverLabel')}
      </label>
      <AddressInput
        id="order-link-receiver"
        value={value}
        onChange={onChange}
        placeholder={t('receiverPlaceholder')}
        inputClassName={`${ORDER_LINK_INPUT_CLASS} font-mono`}
      />
      <ReceiverWalletChip
        canUse={canUseConnected}
        matches={matchesConnected}
        onUse={onUseConnected}
        useLabel={t('useConnectedWallet')}
        matchLabel={t('receiverMatchesWallet')}
      />
      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
        {value.trim() === '' && !connected ? t('receiverConnectHint') : t('receiverHint')}
      </p>
    </div>
  );
}
