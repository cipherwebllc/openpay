// Circle single-attestation wire format: Attestations.sol + TransferSpec.sol.
import { concatHex, encodePacked, keccak256, sliceHex, size, type Hex } from 'viem';
import type { AttestationResponse, TransferSpec } from './types';

export function encodeGatewayTransferSpec(s: TransferSpec): Hex {
  return concatHex([
    encodePacked(['bytes4', 'uint32', 'uint32', 'uint32'], ['0xca85def7', s.version, s.sourceDomain, s.destinationDomain]),
    s.sourceContract, s.destinationContract, s.sourceToken, s.destinationToken,
    s.sourceDepositor, s.destinationRecipient, s.sourceSigner, s.destinationCaller,
    encodePacked(['uint256', 'bytes32', 'uint32'], [s.value, s.salt, size(s.hookData)]), s.hookData,
  ]);
}

export function decodeGatewayAttestation(payload: Hex) {
  // Malformed/unsupported payloads must never reach mint or authorize a replacement.
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(payload) || size(payload) < 380 || sliceHex(payload, 0, 4) !== '0xff6fb334') {
    throw new Error('Unsupported or malformed Gateway attestation');
  }
  const uint = (start: number, length: number) => BigInt(sliceHex(payload, start, start + length));
  const length = Number(uint(36, 4));
  if (length !== size(payload) - 40 || length < 340) throw new Error('Invalid Gateway spec length');
  const bytes = sliceHex(payload, 40, 40 + length);
  const field = (offset: number) => sliceHex(bytes, offset, offset + 32);
  if (sliceHex(bytes, 0, 4) !== '0xca85def7' || uint(44, 4) !== 1n || uint(376, 4) !== BigInt(length - 340)) {
    throw new Error('Invalid Gateway spec version or hook length');
  }
  const spec: TransferSpec = {
    version: 1, sourceDomain: Number(uint(48, 4)), destinationDomain: Number(uint(52, 4)),
    sourceContract: field(16), destinationContract: field(48), sourceToken: field(80), destinationToken: field(112),
    sourceDepositor: field(144), destinationRecipient: field(176), sourceSigner: field(208), destinationCaller: field(240),
    value: BigInt(field(272)), salt: field(304), hookData: length === 340 ? '0x' : sliceHex(bytes, 340),
  };
  return { maxBlockHeight: uint(4, 32), transferSpecHash: keccak256(bytes), spec };
}

export function validateGatewayAttestation(att: AttestationResponse, expected: TransferSpec, expectedHash?: Hex) {
  const decoded = decodeGatewayAttestation(att.attestation);
  const expectedBytes = encodeGatewayTransferSpec(expected);
  if (decoded.transferSpecHash.toLowerCase() !== keccak256(expectedBytes).toLowerCase() ||
      (expectedHash && decoded.transferSpecHash.toLowerCase() !== expectedHash.toLowerCase())) {
    throw new Error('Gateway payment binding mismatch');
  }
  if (att.expirationBlock !== undefined &&
      (typeof att.expirationBlock !== 'string' || !/^\d+$/.test(att.expirationBlock) || BigInt(att.expirationBlock) !== decoded.maxBlockHeight)) {
    throw new Error('Gateway expiration metadata mismatch');
  }
  return decoded;
}
