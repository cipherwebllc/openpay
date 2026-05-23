// Circle Gateway adapter — BurnIntent EIP-712 sign + attestation API + GatewayMinter
// 呼び出しを 1 module に集約。
//
// Flow (buyer 側):
//   1. buildBurnIntent(...) で BurnIntent struct を構築
//   2. getBurnIntentTypedData(intent) を viem.signTypedData に渡し EOA で署名
//   3. requestAttestation({burnIntent, signature}) で Circle API から attestation 取得
//   4. encodeGatewayMintCalldata(attestation, signature) で destination chain の
//      GatewayMinter.gatewayMint への calldata を生成
//   5. wallet で sendTransaction (or UserOp) → destination chain で着金
//
// EIP-712 domain の特殊性:
//   GatewayCommon.sol は意図的に chainId / verifyingContract を omit して
//   cross-chain で signature を流用可能にしている。viem の signTypedData は
//   domain object に chainId / verifyingContract を含めなければ、それらを
//   入れない domain separator hash を生成する。on-chain validation が
//   `keccak256("EIP712Domain(string name,string version)")` を typehash と
//   して使うため、ここで余計なフィールドを追加すると signature が reject される。
//
// セキュリティ:
//   - salt はリプレイ防止のため毎回 crypto.getRandomValues で生成
//   - destinationCaller=0 で permissionless mint (operator や任意の relayer が呼べる)
//     → buyer 自身が呼ぶ前提なら問題ない、relayer pattern 時は specific address を設定
//   - maxFee は default 10 bps (Circle の early access fee 0.5 bps の 20 倍上限)
//   - maxBlockHeight は default 500 blocks (source chain で attestation 有効期間)

import {
  encodeFunctionData,
  getAddress,
  pad,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import {
  CIRCLE_GATEWAY_API_BASE_URL,
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
  chainIdForDomain,
} from './config';
import {
  BURN_INTENT_TYPED_DATA,
  GATEWAY_EIP712_DOMAIN,
  TRANSFER_SPEC_TYPED_DATA,
  type AttestationResponse,
  type BurnIntent,
  type CircleDomain,
  type SignedBurnIntentRequest,
  type TransferSpec,
} from './types';
import type { FetchLike } from './balance';

// TransferSpec.version は Circle が将来 schema 変更する余地のための field、
// 現状の Gateway は 1 を要求 (TransferSpec.sol の VERSION constant)。
const TRANSFER_SPEC_VERSION = 1;

// 既定 maxFee 比率 (10 bps = 0.1%)。Circle early access fee の実勢は 0.5 bps
// なので、これは 20 倍までの fee を許容する safety margin。fee が想定外に
// 高い場合は attestation API 側で reject される (operator が maxFee を超過した
// fee を要求した場合)。caller は overrides.maxFee で上書き可能。
const DEFAULT_MAX_FEE_BPS = 10n;

// 最低 maxFee (atomic USDC = 6 decimals)。1000 atomic = $0.001。微少額 transfer で
// `value × 10 bps` が 0 や 1 atomic になって fee で reject されないようにする
// 下限。caller は overrides.maxFee で上書き可能。
const MIN_MAX_FEE_ATOMIC = 1000n;

// 既定 maxBlockHeight buffer。source chain で attestation 取得 ～ mint まで
// に有効な block 数。500 blocks = Polygon (~2s/block) で 1000 秒 ≈ 16 分、
// Base (~2s/block) で同等。caller は overrides.maxBlockHeightOffset で上書き可。
const DEFAULT_MAX_BLOCK_HEIGHT_OFFSET = 500n;

// destinationCaller=0x0 → permissionless mint。buyer 自身が destination chain
// で mint する想定なら 0 で OK。Relayer pattern で 3rd-party に mint を委譲
// するときは relayer の address を入れる。
const PERMISSIONLESS_DESTINATION_CALLER: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// gatewayMint(bytes,bytes) の最小 ABI fragment。viem.encodeFunctionData で
// destination chain への calldata 生成に使う。
export const GATEWAY_MINTER_ABI = [
  {
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    name: 'gatewayMint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// GatewayWallet.deposit(address,uint256) の ABI。phase 1 demo で buyer が
// 事前 deposit するときに使う。erc20Abi の approve も別途必要 (USDC を
// GatewayWallet に approve してから deposit を呼ぶ)。
export const GATEWAY_WALLET_ABI = [
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    name: 'availableBalance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * EVM address を bytes32 (左 0-pad) に変換。Circle Gateway の TransferSpec は
 * address を bytes32 として持つ (将来の non-EVM chain 対応のため)。
 */
export function addressToBytes32(addr: Address): Hex {
  return pad(getAddress(addr), { size: 32 });
}

/**
 * crypto-grade random 32 bytes を hex で生成。BurnIntent.spec.salt 用。
 * browser / Node 20+ どちらでも `globalThis.crypto.getRandomValues` が利用可能。
 */
export function randomSalt(): Hex {
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  // toHex に頼らず inline 変換 (依存最小化、test での確定値注入もしやすい)
  let s = '0x';
  for (const byte of buf) {
    s += byte.toString(16).padStart(2, '0');
  }
  return s as Hex;
}

export interface BuildBurnIntentArgs {
  /** Source domain (e.g. CIRCLE_DOMAIN_BASE = 6) — buyer が Gateway に deposit している chain */
  sourceDomain: CircleDomain;
  /** Destination domain (e.g. CIRCLE_DOMAIN_POLYGON = 7) — merchant 着金 chain */
  destinationDomain: CircleDomain;
  /** Source chain の USDC token address (lib/tokens.ts から resolve) */
  sourceToken: Address;
  /** Destination chain の USDC token address */
  destinationToken: Address;
  /** Buyer の Gateway depositor address (= signer = `account` in wallet) */
  depositor: Address;
  /** Merchant の destination chain wallet (mint 先) */
  recipient: Address;
  /** Transfer する atomic USDC value (6 decimals) */
  value: bigint;
  /** 現在の source chain block number (publicClient.getBlockNumber で取得) */
  currentBlockHeight: bigint;
  /** Optional overrides — caller の policy をこの level で上書きする */
  overrides?: BuildBurnIntentOverrides;
}

export interface BuildBurnIntentOverrides {
  /** maxFee atomic value 直指定 (overrides bps 計算と min) */
  maxFee?: bigint;
  /** maxFee を value から bps で計算する比率 (default 10 bps) */
  maxFeeBps?: bigint;
  /** maxBlockHeight = currentBlockHeight + offset (default 500) */
  maxBlockHeightOffset?: bigint;
  /** randomSalt の override (test 用、本番では undefined で random) */
  salt?: Hex;
  /** destinationCaller (default permissionless = 0x0) */
  destinationCaller?: Hex;
  /** sourceSigner (default depositor 自身) */
  sourceSigner?: Address;
}

/**
 * BurnIntent struct を組み立てる。pure function (signing は呼び側で別途)。
 *
 * 注意:
 *   - sourceContract / destinationContract は Gateway の wallet/minter address
 *     を bytes32 化したもの (lib/crossChain/config.ts の hard-code を参照)
 *   - mainnet / testnet どちらでも同じ build logic、config 経由で address が
 *     切り替わる
 */
export function buildBurnIntent(args: BuildBurnIntentArgs): BurnIntent {
  const ov = args.overrides ?? {};
  const maxFee = computeMaxFee(args.value, ov);
  const offset = ov.maxBlockHeightOffset ?? DEFAULT_MAX_BLOCK_HEIGHT_OFFSET;
  const maxBlockHeight = args.currentBlockHeight + offset;
  const salt = ov.salt ?? randomSalt();
  const sourceSigner = ov.sourceSigner ?? args.depositor;
  const destinationCaller =
    ov.destinationCaller ?? PERMISSIONLESS_DESTINATION_CALLER;

  const spec: TransferSpec = {
    version: TRANSFER_SPEC_VERSION,
    sourceDomain: args.sourceDomain,
    destinationDomain: args.destinationDomain,
    sourceContract: addressToBytes32(GATEWAY_WALLET_ADDRESS),
    destinationContract: addressToBytes32(GATEWAY_MINTER_ADDRESS),
    sourceToken: addressToBytes32(args.sourceToken),
    destinationToken: addressToBytes32(args.destinationToken),
    sourceDepositor: addressToBytes32(args.depositor),
    destinationRecipient: addressToBytes32(args.recipient),
    sourceSigner: addressToBytes32(sourceSigner),
    destinationCaller,
    value: args.value,
    salt,
    hookData: '0x',
  };

  return { maxBlockHeight, maxFee, spec };
}

function computeMaxFee(value: bigint, ov: BuildBurnIntentOverrides): bigint {
  if (ov.maxFee !== undefined) return ov.maxFee;
  const bps = ov.maxFeeBps ?? DEFAULT_MAX_FEE_BPS;
  // bps 計算: value * bps / 10000。10000 で割って 0 や 1 にならないよう、
  // MIN_MAX_FEE_ATOMIC を下限とする。
  const computed = (value * bps) / 10000n;
  return computed < MIN_MAX_FEE_ATOMIC ? MIN_MAX_FEE_ATOMIC : computed;
}

/**
 * viem.signTypedData に渡す TypedData。`types` には EIP712Domain を含めない
 * (viem が domain object から自動推論する)。primaryType は 'BurnIntent' 固定。
 */
export function getBurnIntentTypedData(
  intent: BurnIntent,
): TypedDataDefinition {
  return {
    domain: GATEWAY_EIP712_DOMAIN,
    types: {
      TransferSpec: TRANSFER_SPEC_TYPED_DATA,
      BurnIntent: BURN_INTENT_TYPED_DATA,
    },
    primaryType: 'BurnIntent',
    message: intent as unknown as Record<string, unknown>,
  } satisfies TypedDataDefinition;
}

/**
 * Circle attestation API POST /v1/transfer を叩いて attestation を取得。
 *
 * Request body は **配列** (バッチ可、phase 1 では 1 件の transfer のみ送る)。
 * BigInt フィールドは JSON.stringify の replacer で toString に落とす
 * (BigInt は JSON.stringify が throw するため必須の処理)。
 */
export async function requestAttestation(
  signed: SignedBurnIntentRequest,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<AttestationResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CIRCLE_GATEWAY_API_BASE_URL;

  // バッチ可なので array でラップ。BigInt → string シリアライズ。
  const body = JSON.stringify([signed], (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

  const res = await fetchImpl(`${baseUrl}/v1/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Circle attestation API /v1/transfer HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  // attestation API は {attestation, signature} を返す (単一 transfer の場合)。
  // バッチ時の response shape は未確定だが phase 1 では 1 件ずつ送るので
  // 単一 object として parse する。array で返ってきた場合は先頭を取る
  // (defensive ではなく Circle SDK の挙動準拠)。
  const json = (await res.json()) as
    | AttestationResponse
    | AttestationResponse[];
  return Array.isArray(json) ? json[0] : json;
}

/**
 * GatewayMinter.gatewayMint(attestation, signature) の calldata を viem で encode。
 * 戻り値は wallet.sendTransaction({ to: GATEWAY_MINTER_ADDRESS, data }) に使える。
 */
export function encodeGatewayMintCalldata(
  attestation: Hex,
  signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: GATEWAY_MINTER_ABI,
    functionName: 'gatewayMint',
    args: [attestation, signature],
  });
}

/**
 * GatewayWallet.deposit(token, value) の calldata を encode。
 * 事前に erc20.approve(GATEWAY_WALLET_ADDRESS, value) が必要。
 */
export function encodeGatewayDepositCalldata(
  tokenAddress: Address,
  value: bigint,
): Hex {
  return encodeFunctionData({
    abi: GATEWAY_WALLET_ABI,
    functionName: 'deposit',
    args: [getAddress(tokenAddress), value],
  });
}

/**
 * destination chain の chain id を Circle domain から導出する convenience
 * (mainnet/testnet env 込み)。PaymentForm 側で「mint tx を送る chain」を決める
 * のに使う。
 */
export function destinationChainIdForDomain(domain: CircleDomain): number {
  return chainIdForDomain(domain);
}
