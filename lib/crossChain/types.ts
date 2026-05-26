// Cross-chain 共通型。Circle 公式 contract source + attestation API OpenAPI を
// 1:1 で写し、命名は Solidity の camelCase、bytes32 は viem.Hex を使う。

import type { Address, Hex } from 'viem';

// Circle 公式の operator-issued domain ID (EVM chain id とは独立、
// CCTP / Gateway 共通、mainnet/testnet 同一):
//   ethereum=0 / avalanche=1 / optimism=2 / arbitrum=3 / base=6 / polygon=7
//   unichain=10 (phase 4b-1 で追加、buyer-only)
//   sonic=13 / worldchain=14 / sei=16 / hyperevm=19 (phase 4b-3 で追加、buyer-only)
//   (phase 4b-2 で追加予定: solana=5)
export const CIRCLE_DOMAIN_ETHEREUM = 0 as const;
export const CIRCLE_DOMAIN_AVALANCHE = 1 as const;
export const CIRCLE_DOMAIN_OPTIMISM = 2 as const;
export const CIRCLE_DOMAIN_ARBITRUM = 3 as const;
export const CIRCLE_DOMAIN_BASE = 6 as const;
export const CIRCLE_DOMAIN_POLYGON = 7 as const;
export const CIRCLE_DOMAIN_UNICHAIN = 10 as const;
export const CIRCLE_DOMAIN_SONIC = 13 as const;
export const CIRCLE_DOMAIN_WORLDCHAIN = 14 as const;
export const CIRCLE_DOMAIN_SEI = 16 as const;
export const CIRCLE_DOMAIN_HYPEREVM = 19 as const;

export type CircleDomain =
  | typeof CIRCLE_DOMAIN_ETHEREUM
  | typeof CIRCLE_DOMAIN_AVALANCHE
  | typeof CIRCLE_DOMAIN_OPTIMISM
  | typeof CIRCLE_DOMAIN_ARBITRUM
  | typeof CIRCLE_DOMAIN_BASE
  | typeof CIRCLE_DOMAIN_POLYGON
  | typeof CIRCLE_DOMAIN_UNICHAIN
  | typeof CIRCLE_DOMAIN_SONIC
  | typeof CIRCLE_DOMAIN_WORLDCHAIN
  | typeof CIRCLE_DOMAIN_SEI
  | typeof CIRCLE_DOMAIN_HYPEREVM;

// Solidity src/lib/TransferSpec.sol 1:1。salt はリプレイ防止のため毎回 random、
// hookData は post-mint hook 不使用なので空 ("0x")。
export interface TransferSpec {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: Hex;
  destinationContract: Hex;
  sourceToken: Hex;
  destinationToken: Hex;
  sourceDepositor: Hex;
  destinationRecipient: Hex;
  sourceSigner: Hex;
  destinationCaller: Hex;
  value: bigint;
  salt: Hex;
  hookData: Hex;
}

// Solidity src/lib/BurnIntents.sol 1:1。maxBlockHeight / maxFee は operator 制限値。
export interface BurnIntent {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: TransferSpec;
}

// フィールド順は Solidity typehash 計算順と完全一致が必要 (順序変更 = hash 変更 =
// on-chain validation 失敗)。EIP712Domain は viem が domain object から自動生成。
// 規制 guard: eip712-regression.test.ts で Solidity 値との完全一致を検証。
export const TRANSFER_SPEC_TYPED_DATA = [
  { name: 'version', type: 'uint32' },
  { name: 'sourceDomain', type: 'uint32' },
  { name: 'destinationDomain', type: 'uint32' },
  { name: 'sourceContract', type: 'bytes32' },
  { name: 'destinationContract', type: 'bytes32' },
  { name: 'sourceToken', type: 'bytes32' },
  { name: 'destinationToken', type: 'bytes32' },
  { name: 'sourceDepositor', type: 'bytes32' },
  { name: 'destinationRecipient', type: 'bytes32' },
  { name: 'sourceSigner', type: 'bytes32' },
  { name: 'destinationCaller', type: 'bytes32' },
  { name: 'value', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
  { name: 'hookData', type: 'bytes' },
] as const;

export const BURN_INTENT_TYPED_DATA = [
  { name: 'maxBlockHeight', type: 'uint256' },
  { name: 'maxFee', type: 'uint256' },
  { name: 'spec', type: 'TransferSpec' },
] as const;

// GatewayCommon.sol は cross-chain signature 流用のため chainId/verifyingContract
// を意図的に omit。追加すると attestation API で reject される。
export const GATEWAY_EIP712_DOMAIN = {
  name: 'GatewayWallet',
  version: '1',
} as const;

// POST /v1/transfer: signed BurnIntent → AttestationResponse。
export interface SignedBurnIntentRequest {
  burnIntent: BurnIntent;
  signature: Hex;
}

// attestation = GatewayMinter.gatewayMint の第 1 引数、
// signature = Circle attestation signer の sig (第 2 引数)。
export interface AttestationResponse {
  attestation: Hex;
  signature: Hex;
}

// POST /v1/balances request/response。balance は uint256 max まで取り得るため string。
export interface BalanceQuerySource {
  domain: CircleDomain;
  depositor: Address;
}

export interface BalanceQueryRequest {
  token: 'USDC';
  sources: BalanceQuerySource[];
}

export interface BalanceQueryResponseEntry {
  domain: CircleDomain;
  balance: string;
}

export interface BalanceQueryResponse {
  balances: BalanceQueryResponseEntry[];
}

// role: 一部 chain (Unichain / World Chain 等) は buyer source として USDC balance を
// 見るのみで、merchant 受信 chain としては露出しない。
//   'merchant-and-buyer' = QR/Checkout の chain chooser に出る + buyer balance 経路も対象
//   'buyer-only'         = QR chooser には出ない + buyer balance / Gateway source の対象
//   'merchant-only'      = QR chooser には出る + buyer balance / Gateway source は skip
//                          (現状該当 chain なし = forward-compat。chain 固有の事情で
//                          merchant 受信は残しつつ buyer source から外したいケース用)
// merchant 受信は USDC_CHAINS (lib/chains.ts) 経由で UI 側が決定、本 type の role field は
// CrossChainTarget array filter で「buyer 用 source 候補」を取り出すのに使う。
export type CrossChainRole = 'merchant-and-buyer' | 'buyer-only' | 'merchant-only';

// domain は mainnet/testnet 共通だが chainId は env により異なるため両方持つ。
export interface CrossChainTarget {
  domain: CircleDomain;
  chainId: number;
  isTestnet: boolean;
  role: CrossChainRole;
}

// 循環 import 回避のため balance / gateway / cctp 共通の fetch DI 型を集約。
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
