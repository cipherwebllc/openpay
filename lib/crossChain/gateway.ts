// Circle Gateway adapter — BurnIntent EIP-712 sign + attestation API + GatewayMinter。
//
// EIP-712 domain の特殊性: GatewayCommon.sol は意図的に chainId / verifyingContract を
// omit して cross-chain で signature を流用可能にしている。`keccak256("EIP712Domain
// (string name,string version)")` を typehash として使うため、ここで余計なフィールドを
// 追加すると signature が attestation API で reject される。

import {
  encodeFunctionData,
  getAddress,
  pad,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
  unichain,
  unichainSepolia,
} from 'viem/chains';
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
  type FetchLike,
  type SignedBurnIntentRequest,
  type TransferSpec,
} from './types';

// TransferSpec.version は Circle が将来 schema 変更する余地のための field、
// 現状の Gateway は 1 を要求 (TransferSpec.sol の VERSION constant)。
const TRANSFER_SPEC_VERSION = 1;

// maxFee 上限 (Circle early access fee 実勢 0.5 bps の 20 倍の safety margin)。
// env NEXT_PUBLIC_CROSS_CHAIN_MAX_FEE_BPS で再 deploy なし上書き可。
const DEFAULT_MAX_FEE_BPS: bigint = (() => {
  const raw = process.env.NEXT_PUBLIC_CROSS_CHAIN_MAX_FEE_BPS;
  if (!raw) return 10n;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 10000) return 10n;
  return BigInt(n);
})();

// 1000 atomic = $0.001。微少額 transfer で `value × 10 bps` が 0/1 atomic に
// 落ちて fee reject されないための下限。
const MIN_MAX_FEE_ATOMIC = 1000n;

// chain-aware maxBlockHeight buffer。Arbitrum (~0.25s/block) で固定 500 blocks
// では ~125 秒しか有効でなく user flow (sign + attest + switch + mint ≈ 1.5-2 min)
// で expire するリスクがあったため (2026-05-24 LARP audit)、chain ごとに ~20 分
// になる block 数を table で持つ:
//   Polygon/Base/Optimism (~2s/block):  600 blocks = 1200s
//   Arbitrum One         (~0.25s/block): 5000 blocks = 1250s
//   Ethereum L1          (~12s/block):  100 blocks = 1200s (phase 4a)
//   Avalanche C          (~2s/block):   600 blocks = 1200s (phase 4b-1 buyer-only)
//   Unichain             (~1s/block):   1200 blocks = 1200s (phase 4b-1 buyer-only)
const PER_CHAIN_BLOCK_OFFSET = new Map<number, bigint>([
  [polygon.id, 600n],
  [polygonAmoy.id, 600n],
  [base.id, 600n],
  [baseSepolia.id, 600n],
  [optimism.id, 600n],
  [optimismSepolia.id, 600n],
  [arbitrum.id, 5000n],
  [arbitrumSepolia.id, 5000n],
  [mainnet.id, 100n],
  [sepolia.id, 100n],
  [avalanche.id, 600n],
  [avalancheFuji.id, 600n],
  [unichain.id, 1200n],
  [unichainSepolia.id, 1200n],
]);

const FALLBACK_BLOCK_OFFSET = 600n;

// env global override (緊急 hot-fix 用、per-chain map より優先)。
const ENV_BLOCK_OFFSET_OVERRIDE: bigint | undefined = (() => {
  const raw = process.env.NEXT_PUBLIC_CROSS_CHAIN_BLOCK_OFFSET_DEFAULT;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return BigInt(n);
})();

// 優先順位: env override > per-chain map > fallback。
export function defaultBlockHeightOffset(sourceChainId: number): bigint {
  if (ENV_BLOCK_OFFSET_OVERRIDE !== undefined) return ENV_BLOCK_OFFSET_OVERRIDE;
  return PER_CHAIN_BLOCK_OFFSET.get(sourceChainId) ?? FALLBACK_BLOCK_OFFSET;
}

// destinationCaller=0x0 = permissionless mint。buyer 自身が呼ぶ前提なら問題
// なし、relayer pattern では specific address を入れる。
const PERMISSIONLESS_DESTINATION_CALLER: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

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

// 事前に erc20.approve(GATEWAY_WALLET_ADDRESS, value) が必要。
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

// TransferSpec は address を bytes32 で持つ (Circle の non-EVM chain 対応の余地)。
export function addressToBytes32(addr: Address): Hex {
  return pad(getAddress(addr), { size: 32 });
}

// BurnIntent.spec.salt はリプレイ防止のため crypto-grade random で毎回生成。
export function randomSalt(): Hex {
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
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

export function buildBurnIntent(args: BuildBurnIntentArgs): BurnIntent {
  const ov = args.overrides ?? {};
  const maxFee = computeMaxFee(args.value, ov);
  const sourceChainId = chainIdForDomain(args.sourceDomain);
  const offset =
    ov.maxBlockHeightOffset ?? defaultBlockHeightOffset(sourceChainId);
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
  const computed = (value * bps) / 10000n;
  return computed < MIN_MAX_FEE_ATOMIC ? MIN_MAX_FEE_ATOMIC : computed;
}

// EIP712Domain は viem が domain object から自動推論するため types には含めない。
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

// POST /v1/transfer: BurnIntent array (batch 可) → AttestationResponse。
// BigInt は JSON.stringify が throw するため replacer で string に落とす。
export async function requestAttestation(
  signed: SignedBurnIntentRequest,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<AttestationResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CIRCLE_GATEWAY_API_BASE_URL;

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

  return (await res.json()) as AttestationResponse;
}

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
