// EIP-3009 (transferWithAuthorization) の純ロジック。client (署名) と server (relay endpoint)
// の両方が使う共有コア。**外部依存・ネットワーク I/O なし**の純関数群なので unit test で完全に
// 担保でき、OOM で動かない form の render とは独立に検証できる。
//
// 背景・検証は memory:jpyc-eip3009。JPYC v3 (全 chain 同一 address) は EIP-3009 を実装し、
// EIP-712 domain は {name:"JPY Coin", version:"1"} (署名 dry-run で Polygon/Kaia とも確認済)。
//
// relay flow:
//   client: buildTransferWithAuthorizationTypedData → wallet.signTypedData → POST
//   server: recoverTransferAuthorizationSigner == from を検証 + validateAuthorization →
//           encodeTransferWithAuthorizationCalldata → Gelato sponsoredCall(target=JPYC, data)

import {
  encodeFunctionData,
  parseAbi,
  recoverTypedDataAddress,
  toHex,
  isAddress,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { JPYC_V3_ASSET } from './x402/types';

// JPYC v3 の EIP-712 domain。name/version は JPYC_V3_ASSET と単一情報源で共有 (x402 と一致)。
export function jpycEip712Domain(
  chainId: number,
  verifyingContract: Address,
): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
} {
  return {
    name: JPYC_V3_ASSET.eip712.name,
    version: JPYC_V3_ASSET.eip712.version,
    chainId,
    verifyingContract: getAddress(verifyingContract),
  };
}

// EIP-3009 TransferWithAuthorization の EIP-712 型 (USDC / JPYC v3 共通の標準形)。
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type Eip3009Authorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

// wallet.signTypedData に渡す typed-data。client が署名する唯一の真実点。
export function buildTransferWithAuthorizationTypedData(
  auth: Eip3009Authorization,
  chainId: number,
  verifyingContract: Address,
) {
  return {
    domain: jpycEip712Domain(chainId, verifyingContract),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  };
}

const TRANSFER_WITH_AUTHORIZATION_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);

// 65-byte signature (r||s||v) を v/r/s に分解。それ以外の長さ (EIP-2098 compact 64B 等) は
// 想定外として弾く (wallet の eth_signTypedData_v4 は 65-byte を返す)。
function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const hex = signature.slice(2);
  if (hex.length === 130) {
    const r = `0x${hex.slice(0, 64)}` as Hex;
    const s = `0x${hex.slice(64, 128)}` as Hex;
    let v = parseInt(hex.slice(128, 130), 16);
    if (v < 27) v += 27; // 0/1 → 27/28 正規化
    return { v, r, s };
  }
  throw new Error(`unexpected signature length: ${hex.length / 2} bytes`);
}

// relay (Gelato sponsoredCall の data) 用に transferWithAuthorization の calldata を組む。
export function encodeTransferWithAuthorizationCalldata(
  auth: Eip3009Authorization,
  signature: Hex,
): Hex {
  const { v, r, s } = splitSignature(signature);
  return encodeFunctionData({
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: 'transferWithAuthorization',
    args: [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      v,
      r,
      s,
    ],
  });
}

// server 側で「署名者 == from」を検証する (無効署名で relay 枠を浪費しない)。
export async function recoverTransferAuthorizationSigner(
  auth: Eip3009Authorization,
  chainId: number,
  verifyingContract: Address,
  signature: Hex,
): Promise<Address> {
  const typed = buildTransferWithAuthorizationTypedData(
    auth,
    chainId,
    verifyingContract,
  );
  return recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature,
  });
}

// ランダム 32-byte nonce (EIP-3009 は sequential でなくランダム nonce で replay 防止)。
export function randomAuthorizationNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// authorization 窓の既定 (署名から有効な秒数)。短く保ち replay/stale window を抑える。
export const AUTHORIZATION_VALIDITY_WINDOW_SEC = 5 * 60; // 5 分

export type AuthorizationValidation =
  | { ok: true }
  | { ok: false; reason: string };

// server 側の shape / 範囲検証 (I/O なし・nowSec を渡して testable に)。署名検証 (recover==from)
// と残高確認 (balanceOf) は I/O が要るので endpoint 側で別途行う。
export function validateAuthorization(
  auth: Eip3009Authorization,
  nowSec: number,
  opts: { maxValue?: bigint } = {},
): AuthorizationValidation {
  if (!isAddress(auth.from)) return { ok: false, reason: 'from が不正です' };
  if (!isAddress(auth.to)) return { ok: false, reason: 'to が不正です' };
  if (getAddress(auth.from) === getAddress(auth.to)) {
    return { ok: false, reason: 'from と to が同一です' };
  }
  if (auth.value <= 0n) return { ok: false, reason: 'value は 0 より大きく必要です' };
  if (opts.maxValue !== undefined && auth.value > opts.maxValue) {
    return { ok: false, reason: 'value が上限を超えています' };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
    return { ok: false, reason: 'nonce は 32-byte hex が必要です' };
  }
  const now = BigInt(Math.floor(nowSec));
  if (auth.validAfter > now) {
    return { ok: false, reason: 'authorization がまだ有効化されていません (validAfter)' };
  }
  if (auth.validBefore <= now) {
    return { ok: false, reason: 'authorization の有効期限が切れています (validBefore)' };
  }
  // validBefore が now から過度に先だと replay 可能期間が長くなる (validAfter は 0 が一般的
  // なので validBefore-validAfter ではなく validBefore-now で制限する)。
  if (auth.validBefore - now > BigInt(AUTHORIZATION_VALIDITY_WINDOW_SEC * 4)) {
    return { ok: false, reason: 'authorization の有効期限が先すぎます' };
  }
  return { ok: true };
}
