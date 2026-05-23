// Circle Gateway / cross-chain USDC 関連の共通型を 1 箇所に集約。
// 実装 module (balance.ts, gateway.ts) と test 双方で reference する。
//
// 型はすべて Circle 公式 contract source (github.com/circlefin/evm-gateway-contracts)
// と attestation API の OpenAPI spec を 1:1 で写したもの。命名は Solidity の
// camelCase をそのまま採用し、bytes32 は viem の Hex 型を使う。

import type { Address, Hex } from 'viem';

// Circle 公式が割り当てる「domain」識別子。EVM chain id とは独立で、
// CCTP / Gateway 共通で使われる operator-issued ID。
// (https://developers.circle.com/gateway/references/contract-addresses)
//
// OpenPay が対象とする 4 chain (Polygon/Base/Arb/OP) の domain:
//   ethereum=0 / avalanche=1 / optimism=2 / arbitrum=3 / base=6 / polygon=7
// mainnet / testnet で同一 domain ID を使う設計のため Set は env を跨いで共通。
export const CIRCLE_DOMAIN_OPTIMISM = 2 as const;
export const CIRCLE_DOMAIN_ARBITRUM = 3 as const;
export const CIRCLE_DOMAIN_BASE = 6 as const;
export const CIRCLE_DOMAIN_POLYGON = 7 as const;

export type CircleDomain =
  | typeof CIRCLE_DOMAIN_OPTIMISM
  | typeof CIRCLE_DOMAIN_ARBITRUM
  | typeof CIRCLE_DOMAIN_BASE
  | typeof CIRCLE_DOMAIN_POLYGON;

// TransferSpec — Circle Gateway の transfer 仕様を表す struct。Solidity の
// src/lib/TransferSpec.sol に対応。BurnIntent の `spec` フィールドに埋め込み、
// EIP-712 typed-data として署名される。
//
// bytes32 フィールドは address を左 0-pad して 32 bytes にしたもの (`viem.pad`
// で生成)。salt はリプレイ防止のため呼び出しごとに ランダム bytes32 を生成する。
// hookData は post-mint hook を使わないので空 bytes (`0x`)。
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

// BurnIntent — Circle Gateway の burn 指示 struct。Solidity の
// src/lib/BurnIntents.sol に対応。`spec` の TransferSpec が core payload で、
// maxBlockHeight / maxFee は operator 側の制限値。
export interface BurnIntent {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: TransferSpec;
}

// viem signTypedData に渡す TypedData の `types` 部 (EIP712Domain は viem が
// domain object から自動生成するため、ここでは BurnIntent / TransferSpec のみ
// 定義)。フィールド順は Solidity の typehash 計算順 (上記 struct 順) と完全一致
// していなければならない。順序を変えると hash が変わって on-chain validation
// が落ちる。
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

// Circle Gateway の EIP-712 domain。
// GatewayCommon.sol (src/lib/EIP712Domain.sol) は **意図的に** chainId と
// verifyingContract を omit していることに注意 — cross-chain で同一 signature
// を有効化するためのデザイン。標準的な EIP-712 domain と異なる点は contract
// 側の source code コメントで明示されており、viem の signTypedData も domain
// object から欠落フィールドを許容する。ここに chainId/verifyingContract を
// 追加すると署名が attestation API で reject される。
export const GATEWAY_EIP712_DOMAIN = {
  name: 'GatewayWallet',
  version: '1',
} as const;

// attestation API POST /v1/transfer の request 1 件あたりの形。BigInt は JSON
// 化のときに toString() で文字列に落とす慣習 (Circle quickstart に従う)。
export interface SignedBurnIntentRequest {
  burnIntent: BurnIntent;
  signature: Hex;
}

// attestation API POST /v1/transfer のレスポンス。
//   - attestation: GatewayMinter.gatewayMint の第 1 引数に渡す byte-encoded payload
//   - signature: Circle attestation signer の signature。第 2 引数に渡す
// Hex (0x-prefixed) で返ってくる。
export interface AttestationResponse {
  attestation: Hex;
  signature: Hex;
}

// attestation API POST /v1/balances のリクエスト/レスポンス。
//   - token は今のところ "USDC" 固定
//   - sources は (domain, depositor) のリスト、複数 chain を一度に問い合わせ可能
//   - balance はリテラル数値文字列 (BigInt 不可避なので string で扱う)
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

// PaymentForm 側で参照する domain×chain mapping。phase 2 の router decision
// tree で「buyer wallet の chain → Gateway destination domain」変換に使う。
// phase 1 では gateway.ts と balance.ts の内部で利用。
export interface CrossChainTarget {
  /** Circle 公式 domain ID (CCTP/Gateway 共通) */
  domain: CircleDomain;
  /** viem chain id (EVM-native) */
  chainId: number;
  /** Circle 公式 domain ID は mainnet/testnet で同じだが chainId は異なるため両方持つ */
  isTestnet: boolean;
}

// fetch DI のための signature。test は mock fetch を渡せる。production は
// global fetch (Node 20+ / browser native)。balance / gateway / cctp の全
// module で共通利用するため types.ts に集約 (循環 import 回避)。
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
