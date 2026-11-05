'use client';

// /checkout (CheckoutForm) のウォレットの欄: 残高の行と、残高が足りないときの案内 (払う額と取引所で買う導線)。
// CheckoutForm から切り出した表示だけの部品 (第 9 回レビュー F-04・Q11)。出すかどうか・額 (残高と払う額) の計算と表記は
// CheckoutForm が決めて、表示用の文字列で渡す。null なら出さない。残高を読む hook (useErc20BalanceAndChain) の呼び出しと、
// 残高不足の判定・払う額 (breakdown.customerPays) も CheckoutForm に残す (掟 12・15)。
// 描画は tests/components/WalletBalance.test.tsx が状態ごとに固定する。

import { useTranslations } from 'next-intl';
import { OnrampCta } from '../OnrampCta';
import type { TokenSymbol } from '@/lib/tokens';

type Props = {
  /** 残高の表記 (例 "1000 JPYC")。null なら残高の行を出さない (未接続・違うチェーン・残高を読めていない)。 */
  balanceText: string | null;
  /** 残高不足のときの、お客様が払う額の表記 (例 "3000 JPYC")。null なら残高不足の案内を出さない。 */
  requiredAmountText: string | null;
  /** 会計のトークン (取引所で買う導線の出し分け)。 */
  token: TokenSymbol;
};

export function WalletBalance({ balanceText, requiredAmountText, token }: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <>
      {balanceText !== null && (
        <p className="text-xs text-slate-500">
          {t('balanceLabel')}{' '}
          <span className="font-mono">{balanceText}</span>
        </p>
      )}

      {requiredAmountText !== null && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <p>
            {t('insufficientBalance', {
              amount: requiredAmountText,
            })}
          </p>
          <OnrampCta token={token} namespace="CheckoutForm" />
        </div>
      )}
    </>
  );
}
