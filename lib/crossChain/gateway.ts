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
  type PublicClient,
  type TypedDataDefinition,
} from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import {
  CIRCLE_GATEWAY_API_BASE_URL,
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
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
// '0x32'→50 のような hex / '1e2'→100 のような指数表記を誤採用しないよう
// 10 進整数 (/^[0-9]+$/) のみ受理し、不合格は fallback (10n) に倒す。
const DEFAULT_MAX_FEE_BPS: bigint = (() => {
  const raw = process.env.NEXT_PUBLIC_CROSS_CHAIN_MAX_FEE_BPS;
  if (!raw) return 10n;
  if (!/^[0-9]+$/.test(raw)) return 10n;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 10000) return 10n;
  return BigInt(n);
})();

// 1000 atomic = $0.001。微少額 transfer で `value × 10 bps` が 0/1 atomic に
// 落ちて fee reject されないための下限。
const MIN_MAX_FEE_ATOMIC = 1000n;

// Circle requires at least withdrawalDelay beyond the source head at API submission.
// Add 10% (rounded up) to absorb blocks mined during wallet approval + API latency;
// measured ~7-day delays leave ~17 hours of headroom, in L1 units on Arbitrum too.
const WITHDRAWAL_DELAY_MARGIN_DIVISOR = 10n;
const ENV_BLOCK_OFFSET_LIMIT = 1n << 255n;

// Optional total offset override; buildBurnIntent clamps it to the live delay + margin.
const ENV_BLOCK_OFFSET_OVERRIDE: bigint | undefined = (() => {
  const raw = process.env.NEXT_PUBLIC_CROSS_CHAIN_BLOCK_OFFSET_DEFAULT;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const offset = BigInt(n);
  // Ignore oversized operator overrides so they cannot cause uint256 encoding
  // failures in an otherwise valid payment; reserve room for the source head.
  if (offset >= ENV_BLOCK_OFFSET_LIMIT) return undefined;
  return offset;
})();

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
    inputs: [],
    name: 'withdrawalDelay',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
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

// Source-scoped reads only. Read errors propagate so an unavailable Gateway cannot
// produce an invalid signed authorization; callers may still offer CCTP/direct paths.
export async function readGatewayBurnIntentContext(
  client: PublicClient,
  sourceChainId: number,
): Promise<{ currentBlockHeight: bigint; withdrawalDelay: bigint }> {
  const withdrawalDelay = await client.readContract({
    address: GATEWAY_WALLET_ADDRESS,
    abi: GATEWAY_WALLET_ABI,
    functionName: 'withdrawalDelay',
  });
  let currentBlockHeight: bigint;
  if (sourceChainId === arbitrum.id || sourceChainId === arbitrumSepolia.id) {
    // Circle uses Ethereum L1 heights here. viem's getBlockNumber returns L2;
    // its generic block type omits Arbitrum's documented l1BlockNumber extension.
    // Read the raw RPC field instead: https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/rpc-methods
    const block = await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    const l1BlockNumber = (block as (typeof block & { l1BlockNumber?: unknown }))?.l1BlockNumber;
    // Missing/malformed L1 data must not spill into an L2-based burn authorization.
    if (typeof l1BlockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(l1BlockNumber)) {
      throw new Error('Gateway source RPC did not return a valid Arbitrum L1 block number');
    }
    currentBlockHeight = BigInt(l1BlockNumber);
  } else {
    currentBlockHeight = await client.getBlockNumber({ cacheTime: 0 });
  }
  return { currentBlockHeight, withdrawalDelay };
}

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
  /** Source contract-visible height (Ethereum L1 height for Arbitrum). */
  currentBlockHeight: bigint;
  /** Live source GatewayWallet.withdrawalDelay(), in the same block units. */
  withdrawalDelay: bigint;
  /** Optional overrides — caller の policy をこの level で上書きする */
  overrides?: BuildBurnIntentOverrides;
}

export interface BuildBurnIntentOverrides {
  /** maxFee atomic value 直指定 (overrides bps 計算と min) */
  maxFee?: bigint;
  /** maxFee を value から bps で計算する比率 (default 10 bps) */
  maxFeeBps?: bigint;
  /** Total offset from source head; clamped to live withdrawalDelay + 10% margin. */
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
  const margin = (args.withdrawalDelay + WITHDRAWAL_DELAY_MARGIN_DIVISOR - 1n) /
    WITHDRAWAL_DELAY_MARGIN_DIVISOR;
  const minimumOffset = args.withdrawalDelay + margin;
  const requestedOffset = ov.maxBlockHeightOffset ?? ENV_BLOCK_OFFSET_OVERRIDE ?? minimumOffset;
  // A stale env/per-call override must not turn a valid delay read into a rejected intent.
  const offset = requestedOffset < minimumOffset ? minimumOffset : requestedOffset;
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

// 会計ログ用の bridge fee **上限** 見積 (実 charge ではない・実 fee ≤ これ)。burn intent と
// 同じ既定 (overrides 無し) で算出し、ログ値が calldata と drift しないようにする。記録は
// reported/unreconciled 扱い、実 charge は mint receipt 照合 (B-3) で確定する。
export function estimateGatewayMaxFee(value: bigint): bigint {
  return computeMaxFee(value, {});
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
