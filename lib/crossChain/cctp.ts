// CCTP V2 Fast Transfer adapter — pre-deposit 不要、per-tx burn-and-mint。
//
// Flow:
//   1. source chain: USDC.approve(TokenMessengerV2, value) → depositForBurn
//   2. iris-api を polling して attestation + message を取得
//   3. destination chain: MessageTransmitterV2.receiveMessage(message, attestation)
//
// Gateway との対比:
//   - Gateway: 事前 deposit が必要、deposit 済 balance から <500ms で mint
//   - CCTP V2 Fast: pre-fund 不要、burn → 8-20 秒で attestation → mint
//   → Gateway は power user (pre-funded) 向け、CCTP V2 は walk-in 向け
//
// FinalityThreshold:
//   - 1000 (CONFIRMED) = Fast Transfer (CCTP V2 の新機能、Hard finality 待たず)
//   - 2000 (FINALIZED) = Standard Transfer (CCTP V1 互換、L1 finality 待ち)
//   本 adapter は default 1000 (Fast) を使用、env override 可能
//
// Contract addresses (公式 docs 確認済、全 EVM chain で同一):
//   mainnet TokenMessengerV2:    0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
//   mainnet MessageTransmitterV2: 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
//   testnet TokenMessengerV2:    0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
//   testnet MessageTransmitterV2: 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
//
// Attestation API (iris):
//   mainnet: https://iris-api.circle.com
//   testnet: https://iris-api-sandbox.circle.com
//   endpoint: GET /v2/messages/{sourceDomainId}?transactionHash={hash}

import {
  encodeFunctionData,
  getAddress,
  pad,
  type Address,
  type Hex,
} from 'viem';
import { isMainnet } from '../env';
import type { CircleDomain, FetchLike } from './types';

// 全 EVM chain で同一 deterministic address (mainnet / testnet で別)。
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

// iris (CCTP attestation) host。mainnet / testnet で 2 host。
// env override 可: NEXT_PUBLIC_CIRCLE_IRIS_API_URL
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

// FinalityThresholds.sol の定数。
// 500  = minimum allowed (TokenMessenger reject 値)
// 1000 = CONFIRMED (Fast Transfer)
// 2000 = FINALIZED (Standard Transfer)
export const CCTP_FINALITY_FAST = 1000;
export const CCTP_FINALITY_STANDARD = 2000;

// 既定 maxFee 比率 (10 bps、Gateway と同様)。CCTP V2 Fast Transfer の操作者
// fee は値段に比例 (Circle 公開 fee rate は変動)、buyer 視点では max を
// 抑える保護として bps 上限を渡す。
const DEFAULT_CCTP_MAX_FEE_BPS = 10n;
const MIN_CCTP_MAX_FEE_ATOMIC = 1000n;

// V2 depositForBurn ABI (full signature)。
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

// V2 receiveMessage ABI。
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

// iris API response shape (公式 OpenAPI ドキュメント由来)。
// 1 transaction が複数 message を含む可能性 (multi-message burn) を許容するため
// messages は array。
export interface CctpIrisMessage {
  /** "complete" | "pending_confirmations" — attestation 完成判定 */
  status: 'complete' | 'pending_confirmations' | string;
  /** message body (hex-encoded bytes、receiveMessage 第 1 引数) */
  message?: Hex;
  /** signed attestation (hex bytes、receiveMessage 第 2 引数) */
  attestation?: Hex;
  /** event nonce、debugging 用 */
  eventNonce?: string;
}

export interface CctpIrisResponse {
  messages: CctpIrisMessage[];
}

export interface BuildDepositForBurnArgs {
  /** transfer する USDC value (atomic, 6 decimals) */
  value: bigint;
  /** Circle domain (destination chain) */
  destinationDomain: CircleDomain;
  /** Mint recipient on destination chain (普通の address) */
  recipient: Address;
  /** Source chain の USDC token address */
  burnToken: Address;
  /** Optional overrides */
  overrides?: BuildDepositForBurnOverrides;
}

export interface BuildDepositForBurnOverrides {
  maxFee?: bigint;
  maxFeeBps?: bigint;
  minFinalityThreshold?: number;
  /** destinationCaller bytes32 (default 0x0 = permissionless) */
  destinationCaller?: Hex;
}

const PERMISSIONLESS_DESTINATION_CALLER: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * EVM address → bytes32 (Gateway adapter の addressToBytes32 と同じロジック、
 * CCTP も同じ pattern を要求するため module 内で再実装、循環 import 回避)。
 */
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

/**
 * TokenMessengerV2.depositForBurn(...) の calldata を encode。
 * 戻り値は wallet.sendTransaction({to: TOKEN_MESSENGER, data}) で使える。
 * 事前に erc20.approve(TOKEN_MESSENGER_ADDRESS, value) が必要。
 */
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

/**
 * MessageTransmitterV2.receiveMessage(message, attestation) の calldata を encode。
 * destination chain で実行する。
 */
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

/**
 * iris API から source tx の attestation + message を 1 度取得。
 * 通常は `pollIrisAttestation` を使う (polling 内包)、本関数は単発 fetch のみ。
 */
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
  /** 個別 fetch の DI */
  fetch?: FetchLike;
  /** iris host override */
  baseUrl?: string;
  /** poll interval (ms)、default 2000 */
  intervalMs?: number;
  /** timeout (ms)、default 90000 (= 1.5 分。Fast Transfer L2 typical 8-20s) */
  timeoutMs?: number;
  /** test 用に sleep 実装を差替できる (default は setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** test 用に Date.now を差替できる (default は Date.now) */
  now?: () => number;
}

/**
 * source tx 提出後、attestation が "complete" になるまで poll。
 * 戻り値は最初に complete になった message。multi-message burn は本 plan の
 * 範囲外 (single-recipient transfer のみ対応)。
 *
 * timeout 超過時は throw (caller は UI で「fast transfer 失敗 → 再試行 or
 * standard fallback」を提示する)。
 */
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
