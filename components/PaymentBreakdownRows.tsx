import type { Key } from 'react';
import { InfoTooltip } from './InfoTooltip';
import { Row } from './Row';

// 内訳 (明細) 1 行の明示的な row model (R14)。3 フォームで共有するのは描画だけで、金額の計算と
// 文言 (ラベル・tooltip 本文) は各フォームが自前の計算と t() で埋める。Pay の split/店主受取・
// Checkout の小計/店舗負担/モバイル注文での gas 行の非表示・Tip のクリエイター受取/Arc の gas 文言は
// 意図的に別物なので、共通のラベル集や手数料計算はここに置かない。
export type BreakdownRowModel = {
  label: string;
  value: string;
  // InfoTooltip の本文。無い行は tooltip を出さない。
  tooltip?: string;
  strong?: boolean;
};

// component ではなく関数として呼び、従来と同じ <Row> (+ labelExtra の InfoTooltip) を同じ位置に返す。
// 要素木に型を 1 段増やさないので、各行の React の同一性と描画 DOM は抽出前と変わらない。
export function breakdownRow(row: BreakdownRowModel, key?: Key) {
  return (
    <Row
      key={key}
      label={row.label}
      labelExtra={
        row.tooltip === undefined ? undefined : <InfoTooltip text={row.tooltip} />
      }
      value={row.value}
      strong={row.strong}
    />
  );
}
