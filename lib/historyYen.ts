// 取引履歴 entry の「円換算額」を求める単一情報源。集計サマリ (GMV) と会計 CSV
// (freee/弥生) の双方がこれを使う。React/env 非依存でユニットテスト容易 (lib/fx.ts と同様)。
//
// 換算ルール (整数円・freee/弥生 とも金額は円):
//   (a) JPYC                : 1:1 (raw/10^18) → exact。
//   (b) USDC + JPYC anchor  : anchorAmount (= 店主が建てた元の円価格) → exact・レート非依存。
//   (c) USDC・anchor 無し    : usdcAmount * usdcJpy → approx (現レート換算・tx 時点ではない) /
//                             レート無しなら unavailable。
//
// 丸めは Math.round (対称)。lib/fx.ts の ceil は「顧客が下回らない請求額」用途で、ここは
// 会計レポートの円換算なので対称丸めが正。

import { formatUnits } from 'viem';
import { HISTORY_ASSET_DECIMALS, type HistoryEntry } from './history';

export type YenValue =
  | { kind: 'exact'; yen: number }
  | { kind: 'approx'; yen: number; rate: number }
  | { kind: 'unavailable' };

// NaN/Infinity を 0 に潰し整数円へ丸める (round-half-up)。
export function roundYen(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

// raw wei 文字列 → number (decimal)。非数値は 0 (loadHistory が schema 検証済のため通常不達)。
function rawToNumber(raw: string, decimals: number): number {
  if (!/^\d+$/.test(raw)) return 0;
  return Number(formatUnits(BigInt(raw), decimals));
}

export function entryYenValue(
  entry: HistoryEntry,
  usdcJpy: number | undefined,
): YenValue {
  if (entry.asset === 'jpyc') {
    // (a) JPYC は円ペッグ 1:1。
    return {
      kind: 'exact',
      yen: roundYen(rawToNumber(entry.merchantAmount, HISTORY_ASSET_DECIMALS.jpyc)),
    };
  }
  // asset === 'usdc'
  if (entry.anchorAmount != null && entry.anchorSymbol === 'jpyc') {
    // (b) 元の価格建てが JPYC = 店主が意図した円価格そのもの (レート非依存・exact)。
    return { kind: 'exact', yen: roundYen(Number(entry.anchorAmount)) };
  }
  // (c) anchor 無し USDC は現レートで概算。レートが無ければ評価不能。
  if (typeof usdcJpy === 'number' && Number.isFinite(usdcJpy) && usdcJpy > 0) {
    const usdc = rawToNumber(entry.merchantAmount, HISTORY_ASSET_DECIMALS.usdc);
    return { kind: 'approx', yen: roundYen(usdc * usdcJpy), rate: usdcJpy };
  }
  return { kind: 'unavailable' };
}
