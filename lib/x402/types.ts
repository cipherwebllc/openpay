// x402 paid route の型を 1 箇所に集約。x402-next 内部型は深い構造を持つので、
// route 側 caller には override 用の軽い shape のみ公開する。

import type { RouteConfig } from 'x402-next';

// Phase 1 サポート: USDC on Base / Base Sepolia のみ。
// JPYC on Polygon は EIP-3009 (transferWithAuthorization) 対応が JPYC v3 で
// 未検証のため Phase 2。x402-next の Network 型は Polygon も含むが、本プロジェクト
// では本 alias で意図的に絞り込む。
export type X402Network = 'base' | 'base-sepolia';

export const SUPPORTED_NETWORKS: readonly X402Network[] = [
  'base',
  'base-sepolia',
] as const;

// 各 paid route で個別に上書きできる項目だけを公開する。price / network /
// facilitator は config の default を上書き、description などは PaymentMiddlewareConfig
// のサブセットだけ通す。
export type PaidRouteOverrides = {
  price?: RouteConfig['price'];
  network?: X402Network;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
};
