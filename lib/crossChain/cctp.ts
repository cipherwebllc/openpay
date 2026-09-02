// CCTP V2 Fast Transfer adapter — pre-deposit 不要、per-tx burn-and-mint。
// Gateway (pre-deposit 必須、<500ms) と対比される walk-in 向け path。
//
// Flow: source chain で approve + depositForBurn → iris-api polling →
//       destination chain で receiveMessage。
//
// minFinalityThreshold = 1000 (CONFIRMED) で Fast Transfer (~8-20 秒)、
// 2000 (FINALIZED) で V1 互換の Standard (~13-19 分)。default は Fast。

import {
  encodeFunctionData,
  getAddress,
  pad,
  type Address,
  type Hex,
} from 'viem';
import { isMainnet } from '../env';
import type { CircleDomain, FetchLike } from './types';

// 全 EVM chain で同一 deterministic address (Circle docs 確認済)。
export const CCTP_V2_TOKEN_MESSENGER_MAINNET: Address =
  '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_V2_MESSAGE_TRANSMITTER_MAINNET: Address =
  '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
export const CCTP_V2_TOKEN_MESSENGER_TESTNET: Address =
  '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
export const CCTP_V2_MESSAGE_TRANSMITTER_TESTNET: Address =
  '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';

export const CCTP_V2_TOKEN_MESSENGER_ADDRESS: Address = isMainnet
  ? CCTP_V2_TOKEN_MESSENGER_MAINNET
  : CCTP_V2_TOKEN_MESSENGER_TESTNET;
export const CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS: Address = isMainnet
  ? CCTP_V2_MESSAGE_TRANSMITTER_MAINNET
  : CCTP_V2_MESSAGE_TRANSMITTER_TESTNET;

// env override: NEXT_PUBLIC_CIRCLE_IRIS_API_URL
export const CCTP_IRIS_API_MAINNET = 'https://iris-api.circle.com';
export const CCTP_IRIS_API_TESTNET = 'https://iris-api-sandbox.circle.com';

const irisOverride = (
  process.env.NEXT_PUBLIC_CIRCLE_IRIS_API_URL ?? ''
).trim();
if (irisOverride.length > 0 && !irisOverride.includes('://')) {
  throw new Error(
    `NEXT_PUBLIC_CIRCLE_IRIS_API_URL must be a fully-qualified URL ` +
      `(got: "${irisOverride}")`,
  );
}

export const CCTP_IRIS_API_BASE_URL: string =
  irisOverride.length > 0
    ? irisOverride
    : isMainnet
      ? CCTP_IRIS_API_MAINNET
      : CCTP_IRIS_API_TESTNET;

// FinalityThresholds.sol: 500=min allowed / 1000=CONFIRMED (Fast) / 2000=FINALIZED.
export const CCTP_FINALITY_FAST = 1000;
export const CCTP_FINALITY_STANDARD = 2000;

// Gateway と同様の 10 bps cap (Circle 公開 fee rate は変動するため buyer 視点の
// max 保護として渡す)。
const DEFAULT_CCTP_MAX_FEE_BPS = 10n;
const MIN_CCTP_MAX_FEE_ATOMIC = 1000n;

export const CCTP_V2_TOKEN_MESSENGER_ABI = [
  {
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    name: 'depositForBurn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// depositForBurn の成功時に TokenMessenger が出す event (CCTP v2)。broadcast したが
// tx hash を永続化できなかったケースで「本当に burn が出たか」を source chain の log から
// 事後確認するために使う (execute.ts の burn intent marker)。indexed は burnToken /
// depositor / minFinalityThreshold の 3 つ。
export const CCTP_V2_DEPOSIT_FOR_BURN_EVENT = {
  type: 'event',
  name: 'DepositForBurn',
  inputs: [
    { name: 'burnToken', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'depositor', type: 'address', indexed: true },
    { name: 'mintRecipient', type: 'bytes32', indexed: false },
    { name: 'destinationDomain', type: 'uint32', indexed: false },
    { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
    { name: 'destinationCaller', type: 'bytes32', indexed: false },
    { name: 'maxFee', type: 'uint256', indexed: false },
    { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
    { name: 'hookData', type: 'bytes', indexed: false },
  ],
} as const;

export const CCTP_V2_MESSAGE_TRANSMITTER_ABI = [
  {
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    name: 'receiveMessage',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// 1 tx で複数 message を burn しうるため messages は array (Circle iris OpenAPI 由来)。
export interface CctpIrisMessage {
  status: 'complete' | 'pending_confirmations' | string;
  message?: Hex;
  attestation?: Hex;
  eventNonce?: string;
}

export interface CctpIrisResponse {
  messages: CctpIrisMessage[];
}

export interface BuildDepositForBurnArgs {
  value: bigint;
  destinationDomain: CircleDomain;
  recipient: Address;
  burnToken: Address;
  overrides?: BuildDepositForBurnOverrides;
}

export interface BuildDepositForBurnOverrides {
  maxFee?: bigint;
  maxFeeBps?: bigint;
  minFinalityThreshold?: number;
  destinationCaller?: Hex;
}

const PERMISSIONLESS_DESTINATION_CALLER: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// gateway.ts と同じ実装を循環 import 回避のため module 内で再定義。
function addressToBytes32(addr: Address): Hex {
  return pad(getAddress(addr), { size: 32 });
}

function computeCctpMaxFee(
  value: bigint,
  ov: BuildDepositForBurnOverrides,
): bigint {
  if (ov.maxFee !== undefined) return ov.maxFee;
  const bps = ov.maxFeeBps ?? DEFAULT_CCTP_MAX_FEE_BPS;
  const computed = (value * bps) / 10000n;
  return computed < MIN_CCTP_MAX_FEE_ATOMIC
    ? MIN_CCTP_MAX_FEE_ATOMIC
    : computed;
}

// 会計ログ用の bridge fee **上限** 見積 (実 charge ではない・実 fee ≤ これ)。calldata と
// 同じ既定 (overrides 無し) で算出し、ログ値が calldata と drift しないようにする。記録は
// reported/unreconciled 扱い、実 charge は mint receipt 照合 (B-3) で確定する。
export function estimateCctpMaxFee(value: bigint): bigint {
  return computeCctpMaxFee(value, {});
}

// 事前に erc20.approve(TOKEN_MESSENGER_ADDRESS, value) が必要。
export function encodeDepositForBurnCalldata(
  args: BuildDepositForBurnArgs,
): Hex {
  const ov = args.overrides ?? {};
  const maxFee = computeCctpMaxFee(args.value, ov);
  const minFinalityThreshold = ov.minFinalityThreshold ?? CCTP_FINALITY_FAST;
  const destinationCaller =
    ov.destinationCaller ?? PERMISSIONLESS_DESTINATION_CALLER;
  const mintRecipient = addressToBytes32(args.recipient);

  return encodeFunctionData({
    abi: CCTP_V2_TOKEN_MESSENGER_ABI,
    functionName: 'depositForBurn',
    args: [
      args.value,
      args.destinationDomain,
      mintRecipient,
      getAddress(args.burnToken),
      destinationCaller,
      maxFee,
      minFinalityThreshold,
    ],
  });
}

export function encodeReceiveMessageCalldata(
  message: Hex,
  attestation: Hex,
): Hex {
  return encodeFunctionData({
    abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI,
    functionName: 'receiveMessage',
    args: [message, attestation],
  });
}

// 単発 fetch (通常は pollIrisAttestation を使う)。
export async function fetchIrisAttestation(
  sourceDomain: CircleDomain,
  sourceTxHash: Hex,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<CctpIrisResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CCTP_IRIS_API_BASE_URL;
  const url = `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`;
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `iris API GET /v2/messages HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as CctpIrisResponse;
}

export interface PollIrisAttestationOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** default 2000 (poll interval ms) */
  intervalMs?: number;
  /** default 90000 (Fast Transfer L2 typical 8-20s に対する余裕) */
  timeoutMs?: number;
  /** test 用 (default setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** test 用 (default Date.now) */
  now?: () => number;
}

// "complete" status の最初の message を返す (single-recipient transfer 想定)。
// timeout 超過時は throw (caller の UI で再試行 or standard fallback 提示)。
export async function pollIrisAttestation(
  sourceDomain: CircleDomain,
  sourceTxHash: Hex,
  opts: PollIrisAttestationOptions = {},
): Promise<CctpIrisMessage> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 90_000;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const startTime = now();

  while (true) {
    const response = await fetchIrisAttestation(sourceDomain, sourceTxHash, {
      fetch: opts.fetch,
      baseUrl: opts.baseUrl,
    });
    const ready = response.messages.find(
      (m) => m.status === 'complete' && m.message && m.attestation,
    );
    if (ready) return ready;

    if (now() - startTime > timeout) {
      throw new Error(
        `iris attestation polling timeout (${timeout}ms) for tx ${sourceTxHash} on domain ${sourceDomain}`,
      );
    }
    await sleep(interval);
  }
}
