import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
} from 'viem';

/** OpenPayLicense1155.PAYMENT_KEY_V1 と同じ ABI schema version。 */
const PAYMENT_KEY_V1 = keccak256(
  encodePacked(['string'], ['openpay.license.payment.v1']),
);

/** 決済元の authorization identity。txHash / NFT chain / contract / tokenId は含めない。 */
export function computeLicensePaymentKey({
  paymentChainId,
  paymentToken,
  payer,
  authorizationNonce,
}: {
  paymentChainId: bigint;
  paymentToken: Address;
  payer: Address;
  authorizationNonce: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [PAYMENT_KEY_V1, paymentChainId, paymentToken, payer, authorizationNonce],
    ),
  );
}

/**
 * hostedStore.newHostedId() の h_ + 小文字 hex 32 桁 (ランダム 128 bit) を、
 * prefix 込みの UTF-8 文字列として hash。除去/hex decode/正規化/形式検証はしない。
 * Solidity computeTokenId と同じ uint256 を bigint で返す (JS number にしない)。
 * 外部での license identity は chain + contract + tokenId。
 */
export function computeLicenseTokenId(productId: string): bigint {
  return BigInt(
    keccak256(encodePacked(['string', 'string'], ['openpay:license:', productId])),
  );
}
