// forwarder.settle の server 専用ヘルパー (sig 分解 / 署名 recover / settle calldata)。
// client バンドルに encodeFunctionData / recoverTypedDataAddress / parseAbi を載せないため
// forwarderIntent (軽量・共有) から分離。route と forwarderRecover (server) のみが import する。

import {
  encodeFunctionData,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

// Eip3009Forwarder.settle の ABI (relayer が呼ぶ calldata 用)。
const FORWARDER_SETTLE_ABI = parseAbi([
  'function settle(address from, address merchant, uint256 merchantValue, uint256 feeValue, uint256 validAfter, uint256 validBefore, bytes32 intentSalt, uint8 v, bytes32 r, bytes32 s)',
]);

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
