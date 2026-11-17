'use client';

import { useTranslations } from 'next-intl';

// JPYC ガスレス relay が API レベルで失敗したとき (rate_limited / relay_not_configured /
// insufficient_balance / fee_required / generic) に、ガス代を自己負担する「通常決済」へ
// 1 タップで切り替える導線を出す banner。on-chain revert (relay.data.success===false) は
// 別経路 (revertedNoFeedback) で扱うため、ここでは扱わない。
//
// SmartAccountFallbackBanner と同じ amber box スタイル。`message` は呼び出し側が
// t(relayErrorKey(relay.error)) で既に翻訳した friendly な error 文言を渡す (重複表示を
// 避けるため、relay error 時はこの banner の中で 1 度だけ表示する)。banner 自身の固定文言
// (title / switchButton / gasHint) は RelayFallback namespace から取る。
//
// unsupportedWallet: このウォレット (7702 でない contract の口座) はガスレスで払えない
// (hooks/useGaslessUnsupportedWallet.ts・relay の signature_invalid)。「一時的」の title と gasHint を出さず、
// 払えない旨の title・通常決済で払える旨の本文・切り替えのボタンだけを出す。`message` はこの title と同じ中身なので出さない。
type Props = {
  // 既に翻訳済みの relay error 文言 (relayErrorKey → t())。
  message: string;
  // 「通常決済」へ切り替えるハンドラ (= setModeOverride('standard'))。
  onSwitchToStandard: () => void;
  // 切り替え後に自己負担するガスのネイティブトークン symbol (POL / KAIA / ETH 等)。
  nativeToken: string;
  unsupportedWallet?: boolean;
};

export function RelayFallbackBanner({
  message,
  onSwitchToStandard,
  nativeToken,
  unsupportedWallet,
}: Props) {
  const t = useTranslations('RelayFallback');

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">{t(unsupportedWallet ? 'unsupportedTitle' : 'title')}</p>
      {unsupportedWallet ? (
        <p className="mt-1 text-xs">{t('unsupportedBody')}</p>
      ) : (
        <>
          <p className="mt-1 text-xs">{message}</p>
          <p className="mt-1 text-xs">{t('gasHint', { nativeToken })}</p>
        </>
      )}
      <button
        type="button"
        onClick={onSwitchToStandard}
        className="mt-3 w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
      >
        {t(unsupportedWallet ? 'unsupportedSwitchButton' : 'switchButton')}
      </button>
    </div>
  );
}
