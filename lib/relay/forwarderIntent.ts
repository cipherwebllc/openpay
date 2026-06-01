// Eip3009Forwarder (contracts/src/Eip3009Forwarder.sol) と client/server が共有する intent 構築。
// 顧客が署名する receiveWithAuthorization の nonce は「分割 (merchant/feeReceiver/各額) の
// コミットメント」であり、contract の settle が同一式で再計算して照合する。ここの abi.encode は
// 契約の keccak256(abi.encode(...)) と完全一致させる必要がある (型・順序・値)。golden vector で
// Solidity との一致を fence する (tests/lib/forwarderIntent.test.ts)。詳細は memory:jpyc-eip3009。

import {
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { jpycEip712Domain } from '@/lib/jpycEip3009';

// Eip3009Forwarder.settle の ABI (relayer が呼ぶ calldata 用)。
const FORWARDER_SETTLE_ABI = parseAbi([
  'function settle(address from, address merchant, uint256 merchantValue, uint256 feeValue, uint256 validAfter, uint256 validBefore, bytes32 intentSalt, uint8 v, bytes32 r, bytes32 s)',
]);

// 契約の COMMIT_VERSION = keccak256("openpay.eip3009.forwarder.v1") と一致必須。
export const FORWARDER_COMMIT_VERSION: Hex = keccak256(
  toHex('openpay.eip3009.forwarder.v1'),
);

export type ForwarderSettleParams = {
  from: Address;
  merchant: Address;
  merchantValue: bigint;
  feeReceiver: Address;
  feeValue: bigint;
  validAfter: bigint;
  validBefore: bigint;
  intentSalt: Hex; // 32-byte random (契約は intentSalt==0 を reject)
};

// 契約 settle の nonce 計算 (keccak256(abi.encode(...))) と完全一致させる。
export function buildForwarderNonce(
  p: ForwarderSettleParams,
  chainId: number,
  forwarder: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // COMMIT_VERSION
        { type: 'address' }, // from
        { type: 'address' }, // merchant
        { type: 'uint256' }, // merchantValue
        { type: 'address' }, // feeReceiver
        { type: 'uint256' }, // feeValue
        { type: 'uint256' }, // validAfter
        { type: 'uint256' }, // validBefore
        { type: 'bytes32' }, // intentSalt
        { type: 'uint256' }, // block.chainid
        { type: 'address' }, // address(this) = forwarder
      ],
      [
        FORWARDER_COMMIT_VERSION,
        p.from,
        p.merchant,
        p.merchantValue,
        p.feeReceiver,
        p.feeValue,
        p.validAfter,
        p.validBefore,
        p.intentSalt,
        BigInt(chainId),
        forwarder,
      ],
    ),
  );
}

// 顧客が署名する EIP-3009 ReceiveWithAuthorization の型 (USDC/JPYC v3 共通の標準形)。
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// 受領総額 (= merchantValue + feeValue)。settle が同じ和を受領 value とする。
export function forwarderTotalValue(p: ForwarderSettleParams): bigint {
  return p.merchantValue + p.feeValue;
}

// 顧客が署名する receiveWithAuthorization の EIP-712 typed data (to=forwarder・nonce=commit)。
export function buildReceiveWithAuthorizationTypedData(
  p: ForwarderSettleParams,
  chainId: number,
  token: Address,
  forwarder: Address,
) {
  return {
    domain: jpycEip712Domain(chainId, token),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization' as const,
    message: {
      from: p.from,
      to: forwarder,
      value: forwarderTotalValue(p),
      validAfter: p.validAfter,
      validBefore: p.validBefore,
      nonce: buildForwarderNonce(p, chainId, forwarder),
    },
  };
}

// 65-byte signature を v/r/s に分解 (v<27→+27 正規化)。settle の引数用。
export function splitSignatureToVRS(signature: Hex): {
  v: number;
  r: Hex;
  s: Hex;
} {
  const hex = signature.slice(2);
  if (hex.length !== 130) {
    throw new Error(`unexpected signature length: ${hex.length / 2} bytes`);
  }
  const r = `0x${hex.slice(0, 64)}` as Hex;
  const s = `0x${hex.slice(64, 128)}` as Hex;
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

// 顧客署名 (receiveWithAuthorization) の署名者を recover する。server が ==from を検証する。
export async function recoverReceiveWithAuthorizationSigner(
  p: ForwarderSettleParams,
  chainId: number,
  token: Address,
  forwarder: Address,
  signature: Hex,
): Promise<Address> {
  const t = buildReceiveWithAuthorizationTypedData(p, chainId, token, forwarder);
  return recoverTypedDataAddress({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
    signature,
  });
}

// relayer が forwarder に送る settle calldata を組む。
export function encodeSettleCalldata(
  p: ForwarderSettleParams,
  signature: Hex,
): Hex {
  const { v, r, s } = splitSignatureToVRS(signature);
  return encodeFunctionData({
    abi: FORWARDER_SETTLE_ABI,
    functionName: 'settle',
    args: [
      p.from,
      p.merchant,
      p.merchantValue,
      p.feeValue,
      p.validAfter,
      p.validBefore,
      p.intentSalt,
      v,
      r,
      s,
    ],
  });
}
