import { concatHex, encodePacked, pad, type Hex } from 'viem';
import { GATEWAY_MINTER_ADDRESS, GATEWAY_WALLET_ADDRESS } from '@/lib/crossChain/config';
import type { TransferSpec } from '@/lib/crossChain/types';

export const gatewaySpec: TransferSpec = {
  version: 1, sourceDomain: 6, destinationDomain: 7,
  sourceContract: pad(GATEWAY_WALLET_ADDRESS), destinationContract: pad(GATEWAY_MINTER_ADDRESS),
  sourceToken: pad('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  destinationToken: pad('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'),
  sourceDepositor: pad('0x1234567890123456789012345678901234567890'),
  sourceSigner: pad('0x1234567890123456789012345678901234567890'),
  destinationRecipient: pad('0x000000000000000000000000000000000000aBcd'),
  destinationCaller: pad('0x00'), value: 1_000_000n, salt: pad('0x01'), hookData: '0x',
};
// Circle's packed wire encoding, independent of the production decoder/hash implementation.
export function encodedSpec(spec: TransferSpec = gatewaySpec): Hex {
  return encodePacked(
    ['bytes4', 'uint32', 'uint32', 'uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'uint32', 'bytes'],
    ['0xca85def7', spec.version, spec.sourceDomain, spec.destinationDomain, spec.sourceContract,
      spec.destinationContract, spec.sourceToken, spec.destinationToken, spec.sourceDepositor,
      spec.destinationRecipient, spec.sourceSigner, spec.destinationCaller, spec.value, spec.salt,
      (spec.hookData.length - 2) / 2, spec.hookData],
  );
}
export function gatewayAttestation(spec: TransferSpec = gatewaySpec, expiry = 100n) {
  const wire = encodedSpec(spec);
  return { attestation: concatHex([encodePacked(['bytes4', 'uint256', 'uint32'], ['0xff6fb334', expiry, (wire.length - 2) / 2]), wire]), signature: `0x${'11'.repeat(65)}` as Hex };
}
