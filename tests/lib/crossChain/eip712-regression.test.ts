// EIP-712 typehash 整合性 regression guard。
//
// Circle Gateway の on-chain validation は以下の hard-code 値を typehash として使う:
//   - EIP712Domain typehash = 0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3
//   - BurnIntent typehash  = 0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c
//
// JS 側で BURN_INTENT_TYPED_DATA / TRANSFER_SPEC_TYPED_DATA の field 順序 or
// 型を変更すると、computed typehash がずれ、attestation API は signature を
// reject する (黙って "InvalidAttestationSigner" になる、debug 困難)。
//
// 本テストは viem 実コード (keccak256 + encodeAbiParameters 不使用、raw string
// hash) で typehash を計算し、Solidity hard-code 値と完全一致するか検証する。
// 不一致 = schema drift = on-chain breakage の cause。

import { describe, it, expect } from 'vitest';
import {
  keccak256,
  toHex,
  hashTypedData,
  type TypedDataDefinition,
} from 'viem';
import {
  BURN_INTENT_TYPED_DATA,
  GATEWAY_EIP712_DOMAIN,
  TRANSFER_SPEC_TYPED_DATA,
} from '@/lib/crossChain/types';
import {
  buildBurnIntent,
  getBurnIntentTypedData,
} from '@/lib/crossChain/gateway';
import {
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_POLYGON,
} from '@/lib/crossChain/types';

// EIP-712 typeString エンコーディング規則 (https://eips.ethereum.org/EIPS/eip-712):
//   primaryType(field1Type field1Name,field2Type field2Name,...)
//   dependencyType1(...) dependencyType2(...)
// dependencies はアルファベット順。本 case: BurnIntent depends on TransferSpec のみ。
function fieldList(fields: ReadonlyArray<{ name: string; type: string }>): string {
  return fields.map((f) => `${f.type} ${f.name}`).join(',');
}

describe('EIP-712 typehash regression (Solidity constants との完全一致)', () => {
  it('EIP712Domain typehash = Solidity EIP712_DOMAIN_TYPE_HASH', () => {
    // Solidity: keccak256("EIP712Domain(string name,string version)")
    // (GatewayCommon.sol が chainId/verifyingContract 意図的に omit している)
    const SOLIDITY_DOMAIN_TYPEHASH =
      '0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3';
    const jsTypeString = 'EIP712Domain(string name,string version)';
    const jsTypehash = keccak256(toHex(jsTypeString));
    expect(jsTypehash).toBe(SOLIDITY_DOMAIN_TYPEHASH);
  });

  it('BurnIntent typehash = Solidity BURN_INTENT_TYPEHASH', () => {
    // Solidity hard-code (BurnIntents.sol):
    // keccak256("BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)
    //  TransferSpec(uint32 version,...,bytes hookData)")
    const SOLIDITY_BURN_INTENT_TYPEHASH =
      '0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c';

    // JS 側で typeString を組み立てて keccak256
    const burnIntentTypeString = `BurnIntent(${fieldList(BURN_INTENT_TYPED_DATA)})TransferSpec(${fieldList(TRANSFER_SPEC_TYPED_DATA)})`;
    const jsTypehash = keccak256(toHex(burnIntentTypeString));
    expect(jsTypehash).toBe(SOLIDITY_BURN_INTENT_TYPEHASH);
  });

  it('TransferSpec field 順序が変わると typehash が drift (sanity test)', () => {
    // 故意に field 順を変えた場合 typehash が変わることを確認
    // (= 本テストが drift を検出できる sensitivity を持つことの保証)
    const reversed = [...TRANSFER_SPEC_TYPED_DATA].reverse();
    const correctTypehash = keccak256(
      toHex(`TransferSpec(${fieldList(TRANSFER_SPEC_TYPED_DATA)})`),
    );
    const reversedTypehash = keccak256(
      toHex(`TransferSpec(${fieldList(reversed)})`),
    );
    expect(reversedTypehash).not.toBe(correctTypehash);
  });

  it('GATEWAY_EIP712_DOMAIN は chainId/verifyingContract を含まない', () => {
    // Circle GatewayCommon.sol 仕様: cross-chain で signature 流用するため
    // chainId/verifyingContract を意図的に omit。
    expect(GATEWAY_EIP712_DOMAIN).toEqual({
      name: 'GatewayWallet',
      version: '1',
    });
    expect(GATEWAY_EIP712_DOMAIN).not.toHaveProperty('chainId');
    expect(GATEWAY_EIP712_DOMAIN).not.toHaveProperty('verifyingContract');
  });

  it('viem.hashTypedData が typed-data spec を accept する (smoke)', () => {
    // 実 viem で structHash を計算、エラーなく Hex 値を返すことを smoke check。
    // 不正な field 型 (uint32 を Number で渡す等) があると viem が throw する。
    const intent = buildBurnIntent({
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destinationDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      destinationToken: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      depositor: '0x1234567890123456789012345678901234567890',
      recipient: '0x000000000000000000000000000000000000aBcd',
      value: 1_000_000n,
      currentBlockHeight: 100n,
      overrides: {
        salt: '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      },
    });
    const td = getBurnIntentTypedData(intent);
    const hash = hashTypedData(td as TypedDataDefinition);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hashTypedData は intent.value 変更で hash が変わる (determinism)', () => {
    function hashWith(value: bigint) {
      const intent = buildBurnIntent({
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destinationDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        destinationToken: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
        depositor: '0x1234567890123456789012345678901234567890',
        recipient: '0x000000000000000000000000000000000000aBcd',
        value,
        currentBlockHeight: 100n,
        overrides: {
          salt: '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
        },
      });
      return hashTypedData(getBurnIntentTypedData(intent) as TypedDataDefinition);
    }
    expect(hashWith(1n)).not.toBe(hashWith(2n));
  });
});
