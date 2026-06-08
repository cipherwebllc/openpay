// OpenPay 利用料 (a1) の収益 (運営入金) を「収入があった事実がわかる生データ」CSV にする。
// 用途: 税理士へ渡して会計処理してもらう (当社で勘定科目/税区分/時価評価を推定しない方針)。freee 取込にも使える。
// 1 入金 = 1 行。金額は JPYC (=JPY 1:1)。lib/csv の RFC-4180/Injection 防御/UTF-8 BOM を流用。
// 設計: docs/plans/admin-billing-revenue.md。

import { formatUnits } from 'viem';
import { buildCsv } from './csv';
import { txExplorerUrl, chainNameForId } from './chains';
import type { FeeRevenueEvent } from './feeRevenue';

function jpyc(wei: string): string {
  const s = formatUnits(BigInt(wei), 18);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function dateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// 税区分は当社で推定しない (取込時に税理士/freee で設定) → 行には含めず、生の事実だけ出す。
const HEADER = [
  '入金日(UTC)',
  '金額(JPYC)',
  '円換算',
  '受取店主アドレス',
  '対象期間',
  'txHash',
  'チェーン',
  'Explorer',
];

export function toFeeRevenueCsv(events: FeeRevenueEvent[]): string {
  const rows: string[][] = [HEADER];
  for (const e of events) {
    const amount = jpyc(e.v); // JPYC = JPY 1:1
    rows.push([
      dateUtc(e.t),
      amount,
      amount,
      e.m,
      e.p,
      e.h,
      chainNameForId(e.c) ?? String(e.c),
      txExplorerUrl(e.c, e.h) ?? '',
    ]);
  }
  return buildCsv(rows); // UTF-8 BOM 付き
}
