'use client';

// 受取ウォレットの入力。受取先が決まるまでは注文カードの先頭に、決まったら設定シートに出す。

import { useTranslations } from 'next-intl';
import { Settings2 } from 'lucide-react';
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
  onOpenSettings,
  inputId = 'order-link-receiver',
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
  /**
   * 注文カードの先頭に出ているとき、見出しの横に「設定」を出す (店名・チェーン・支払い方法へ行けるように)。
   * 受取先が決まって要約の行に畳むまで「設定」が見えず、初めての人が店名を設定できなかった (2026-11-03 本番で確認)。
   */
  onOpenSettings?: () => void;
  /** 欄の id。注文カードと設定シートの両方に出るときに重ならないよう、シート側は別の id にする。 */
  inputId?: string;
}) {
  const t = useTranslations('OrderLinkBuilder');
  return (
    <div>
      {onOpenSettings && !hideLabel ? (
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor={inputId} className="text-sm font-semibold text-slate-800">
            {t('receiverLabel')}
          </label>
          {/* 要約の行の「設定」と同じ形。押せる範囲だけを after の透明な面で 44px 以上に広げる。 */}
          <button
            type="button"
            onClick={onOpenSettings}
            className="relative inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand hover:text-brand-dark after:absolute after:-inset-x-1 after:-inset-y-2 after:content-['']"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            {t('settingsOpen')}
          </button>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          className={hideLabel ? 'sr-only' : 'mb-1.5 block text-sm font-semibold text-slate-800'}
        >
          {t('receiverLabel')}
        </label>
      )}
      <AddressInput
        id={inputId}
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
