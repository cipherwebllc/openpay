'use client';

// /checkout (CheckoutForm) のウォレットの欄: 要求のチェーンへの切り替えのボタンと、切り替えが失敗したときの知らせ。
// CheckoutForm から切り出した表示だけの部品 (第 9 回レビュー F-04・Q11)。出すかどうか (接続中で、ウォレットのチェーンが
// 要求と違う) と、ボタンで呼ぶ切り替え (switchChain({ chainId: requiredChain.id })) は CheckoutForm が決めて渡し、ここは
// 受け取って描くだけ。切り替えの hook (useSwitchChainWithFeedback) の呼び出しと状態も CheckoutForm に残す (掟 12・15)。
// 描画は tests/components/WrongChainSwitch.test.tsx が状態ごとに固定する。
//
// 下の払うボタンの「ネットワークを切替え」(btnSwitchChain) は払うボタンの文言の出し分けなので CheckoutForm に残す。

import { useTranslations } from 'next-intl';

type Props = {
  /** 切り替えの待ち (useSwitchChainWithFeedback の isPending)。待ちの間はボタンを押せない。 */
  isSwitching: boolean;
  /** 切り替えが失敗した (取り消しを除く・useSwitchChainWithFeedback の failed)。ボタンの下に知らせを出す。 */
  switchFailed: boolean;
  /** 要求のチェーンの名前 (ボタンと知らせの文言に入れる)。 */
  chainName: string;
  /** 要求のチェーンへの切り替え (CheckoutForm が switchChain({ chainId: requiredChain.id }) を作って渡す)。 */
  onSwitch: () => void;
};

export function WrongChainSwitch({ isSwitching, switchFailed, chainName, onSwitch }: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <>
      <button
        type="button"
        onClick={onSwitch}
        disabled={isSwitching}
        className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
      >
        {isSwitching
          ? t('switchingChain')
          : t('switchChain', { chainName })}
      </button>
      {switchFailed && (
        <p role="alert" className="text-xs leading-relaxed text-red-700">
          {t('switchChainFailed', { chainName })}
        </p>
      )}
    </>
  );
}
