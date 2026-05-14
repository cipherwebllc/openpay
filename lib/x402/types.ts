// x402 paid route の型を 1 箇所に集約。x402-next 内部型は深い構造を持つので、
// route 側 caller には override 用の軽い shape のみ公開する。

import type { RouteConfig } from 'x402-next';

// Phase 1 (USDC): base / base-sepolia
// Phase 2 (JPYC): polygon / polygon-amoy
//   JPYC v3 が EIP-3009 (transferWithAuthorization / authorizationState /
//   cancelAuthorization / receiveWithAuthorization) を実装していることを
//   Polygon mainnet 実 RPC で 2026-05-14 に verify 済 (implementation
//   0xafAc17fc3936A29CA2d2787CEd3C5d1c52007D2E)。
//   EIP-712 domain は name="JPY Coin" / version="1" を仮定 (DOMAIN_SEPARATOR /
//   eip712Domain は publicly 未公開、OpenZeppelin の default に従う)。
//   実 signature 通過は alpha のユーザー試用で確認。
export type X402Network = 'base' | 'base-sepolia' | 'polygon' | 'polygon-amoy';

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

// JPYC v3 (Polygon mainnet / Amoy 共通アドレス、cross-chain deterministic)。
// 既定 asset として polygon / polygon-amoy 上で使う。
export const JPYC_V3_ASSET = {
  address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as const,
  decimals: 18,
  eip712: {
    name: 'JPY Coin',
    version: '1',
  },
} as const;
