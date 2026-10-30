// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/seedBillingGuard.mjs (node native ESM)。tsc は declaration only として読む。

/** seed が積む行の chainId (Polygon Amoy = 80002)。 */
export const SEED_TESTNET_CHAIN_ID: number;

export type SeedMeterBlockingRow = {
  /** LRANGE の結果での位置 (0 始まり)。 */
  index: number;
  /** 行の c。数値として読めない行は null。 */
  chainId: number | null;
};

/** 空か全行が c === 80002 のときだけ ok (DEL して積み直してよい)。 */
export function checkSeedMeterReplaceable(rows: unknown): {
  ok: boolean;
  total: number;
  blocking: SeedMeterBlockingRow[];
};

/** blocking の行を「chainId 137 ×2・読めない行 ×1」の形にまとめる。 */
export function describeBlockingRows(blocking: SeedMeterBlockingRow[]): string;
