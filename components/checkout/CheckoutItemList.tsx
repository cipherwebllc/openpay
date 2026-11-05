'use client';

// /checkout (CheckoutForm) のお支払い額の欄の前半: 見出し「商品」と、品目の行 (品名・「×数量」・行の額) の並び。
// CheckoutForm から切り出した表示だけの部品 (第 9 回レビュー F-04・Q11)。行の額 (品目ごとの小計 = 単価 × 数量) の計算と
// 表記は CheckoutForm が決めて、表示用の文字列で渡す。欄の後半 (小計・値引き・手数料・お支払い額の表と説明) は CheckoutForm に
// 残す (掟 12・15)。描画は tests/components/CheckoutItemList.test.tsx が状態ごとに固定する。

import { useTranslations } from 'next-intl';

export type CheckoutItemLine = {
  /** 品名 (URL の品目の名前をそのまま)。 */
  name: string;
  /** 数量 (「×数量」で出す)。 */
  qty: number;
  /** 行の額の表記 (例 "3000 JPYC"・単価 × 数量)。 */
  amountText: string;
};

type Props = {
  /** 品目の行 (URL の並びどおり)。 */
  lines: ReadonlyArray<CheckoutItemLine>;
};

export function CheckoutItemList({ lines }: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t('itemsTitle')}
      </p>
      <ul className="mt-3 divide-y divide-slate-100">
        {lines.map((line, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 py-2">
            <span className="min-w-0 flex-1 break-words font-medium text-slate-700">
              {line.name}
            </span>
            <span className="shrink-0 font-mono text-xs text-slate-500">
              ×{line.qty}
            </span>
            <span className="shrink-0 font-mono text-sm text-slate-800">
              {line.amountText}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
