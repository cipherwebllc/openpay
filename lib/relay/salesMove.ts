// 「売上をほかのウォレットへ移す」(plans/store-sales-move.md) の server / client 共有の定数 (軽量・client バンドル可)。
// route (app/api/relay/jpyc/move) が強制し、画面 (P2) が同じ値で事前に案内する。開示 (P2 の DISCLOSED_SALES_MOVE) の
// フェンスは、ここのチェーンの一覧と route が強制する利用料 (relayGasFeeValue) を突き合わせる。

import { polygon, polygonAmoy } from 'viem/chains';

/** 売上の移動を受け付けるチェーン。Polygon (本番) と Amoy (testnet) の JPYC だけ (user 裁定 2026-11-07)。 */
export const SALES_MOVE_CHAIN_IDS: readonly number[] = Object.freeze([
  polygon.id,
  polygonAmoy.id,
]);

export function isSalesMoveChain(chainId: number): boolean {
  return SALES_MOVE_CHAIN_IDS.includes(chainId);
}

/** 移す額 (送り先に届く額・利用料を含まない) の下限 = 1 JPYC (18 decimals・Q2)。上限は relay 共通の MAX_VALUE。 */
export const SALES_MOVE_MIN_VALUE_WEI = 10n ** 18n;
