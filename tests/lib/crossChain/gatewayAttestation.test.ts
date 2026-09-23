import { describe, expect, it } from 'vitest';
import { concatHex, keccak256, pad, sliceHex, type Hex } from 'viem';
import { decodeGatewayAttestation, encodeGatewayTransferSpec, validateGatewayAttestation } from '@/lib/crossChain/gatewayAttestation';
import { gatewayAttestation, gatewaySpec, encodedSpec } from '../../fixtures/gateway';

describe('Circle attestation wire encoding', () => {
  it.each(['0x', '0x1234', '0x1234567890'] as Hex[])('hashes the exact byte-40 spec slice including hookData=%s', (hookData) => {
    const spec = { ...gatewaySpec, hookData };
    const att = gatewayAttestation(spec, 123456789012345n);
    const decoded = decodeGatewayAttestation(att.attestation);
    expect(decoded).toEqual({ maxBlockHeight: 123456789012345n, transferSpecHash: keccak256(encodedSpec(spec)), spec });
    expect(decoded.transferSpecHash).not.toBe(keccak256(att.attestation));
    expect(encodeGatewayTransferSpec(spec).toLowerCase()).toBe(encodedSpec(spec).toLowerCase());
  });
  it.each([
    '0x', '0xgarbage', concatHex(['0x1e12db71', sliceHex(gatewayAttestation().attestation, 4)]),
    concatHex(['0x00000000', sliceHex(gatewayAttestation().attestation, 4)]),
    sliceHex(gatewayAttestation().attestation, 0, 379),
    concatHex([gatewayAttestation().attestation, '0x00']),
    gatewayAttestation({ ...gatewaySpec, version: 2 }).attestation,
    concatHex([sliceHex(gatewayAttestation().attestation, 0, 376), '0x00000001']),
  ])('rejects malformed, unsupported set or unknown version %s', (payload) => {
    expect(() => decodeGatewayAttestation(payload as Hex)).toThrow();
  });
  it.each(['sourceContract', 'destinationContract', 'sourceToken', 'destinationToken', 'sourceDepositor',
    'destinationRecipient', 'sourceSigner', 'destinationCaller', 'salt'] as const)('binds %s', (field) => {
    expect(() => validateGatewayAttestation(gatewayAttestation({ ...gatewaySpec, [field]: pad('0x19') }), gatewaySpec)).toThrow('binding');
  });
  it.each(['sourceDomain', 'destinationDomain', 'value'] as const)('binds %s', (field) => {
    const spec = { ...gatewaySpec, [field]: field === 'value' ? 42n : 42 };
    expect(() => validateGatewayAttestation(gatewayAttestation(spec), gatewaySpec)).toThrow('binding');
  });
  it.each(['99', '101', '1e2', '-1'])('rejects contradictory/malformed API expiry %s', (expirationBlock) => {
    expect(() => validateGatewayAttestation({ ...gatewayAttestation(), expirationBlock }, gatewaySpec)).toThrow('metadata');
  });
  it('accepts matching API metadata without using it as the expiry source', () => {
    expect(validateGatewayAttestation({ ...gatewayAttestation(), expirationBlock: '100', transferId: 'api-id' }, gatewaySpec).maxBlockHeight).toBe(100n);
  });
});
