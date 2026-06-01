// Eip3009Forwarder (contracts/src/Eip3009Forwarder.sol) と client/server が共有する intent 構築
// (軽量・client バンドル可)。顧客が署名する receiveWithAuthorization の nonce は「分割
// (merchant/feeReceiver/各額) のコミットメント」であり、contract の settle が同一式で再計算して
// 照合する。ここの abi.encode は契約の keccak256(abi.encode(...)) と完全一致させる必要がある
// (型・順序・値)。golden vector で Solidity との一致を fence (tests/lib/forwarderIntent.test.ts)。
//
// server 専用の sig 分解 / recover / settle calldata は lib/relay/forwarderSettle.ts に分離
// (client バンドルに encodeFunctionData/recoverTypedDataAddress を載せないため)。

import {
  keccak256,
  encodeAbiParameters,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { jpycEip712Domain } from '@/lib/jpycEip3009';

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
