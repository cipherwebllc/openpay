'use client';

// /checkout (CheckoutForm) のお支払い額の欄の後半: 合計の内訳の表 (小計・値引き・手数料・ネットワーク手数料・区切り線・
// お支払い額) と、その下の説明・承認の確認のリンク。CheckoutForm から切り出した表示だけの部品 (第 9 回レビュー F-04・Q11)。
// 額の計算 (breakdown・利用料・ガス相当額・お支払い額) と表記 (fmt)、どの行・文言を出すかの経路の判定 (isStandard・isMobileFee・
// useRecover・useRelay・isJpyc・isMerchantGas・isCircle・isErc20Paymaster) は CheckoutForm に残し、行のモデル (BreakdownRowModel) と
// 説明の文字列にして渡す (掟 12・15)。この部品は受け取った行を並びどおりに描くだけ。
// 描画は tests/components/CheckoutAmountBreakdown.test.tsx が経路と状態ごとに固定する。

import { useTranslations } from 'next-intl';
import { breakdownRow, type BreakdownRowModel } from '../PaymentBreakdownRows';

type Props = {
  /** 表の先頭の行: 小計 (値引きがあれば 小計 → 値引き の 2 行)。並びどおりに出す。 */
  subtotalRows: ReadonlyArray<BreakdownRowModel>;
  /** OpenPay 利用手数料の行。null なら出さない。 */
  feeRow: BreakdownRowModel | null;
  /** ネットワーク手数料の行。null なら出さない。 */
  gasRow: BreakdownRowModel | null;
  /** 区切り線の下のお支払い額の行。 */
  totalRow: BreakdownRowModel;
  /** 表の下の説明。 */
  hint: string;
  /** ガス代の承認の状況を確かめるリンク先 (Explorer)。無いときはリンクを出さない。 */
  approvalCheckUrl: string | undefined;
};

export function CheckoutAmountBreakdown({
  subtotalRows,
  feeRow,
  gasRow,
  totalRow,
  hint,
  approvalCheckUrl,
}: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <>
      <div className="mt-3 border-t border-slate-200 pt-3">
        <dl className="space-y-1.5">
          {subtotalRows.map((row, i) => breakdownRow(row, i))}
          {feeRow && breakdownRow(feeRow)}
          {gasRow && breakdownRow(gasRow)}
          <div className="my-1 border-t border-slate-200" />
          {breakdownRow(totalRow)}
        </dl>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {hint}
      </p>
      {approvalCheckUrl && (
        <p className="mt-2 text-[11px]">
          <a
            href={approvalCheckUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-slate-500 underline hover:text-slate-700"
          >
            {t('approvalCheckLink')} ↗
          </a>
        </p>
      )}
    </>
  );
}
