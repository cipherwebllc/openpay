import type { Hex } from 'viem';

/**
 * 7702 の委任 (`0xef0100` + 20 byte) を除き、code を持つアドレス = コントラクトウォレット。
 * 委任済み EOA は秘密鍵の支配が残り、通常の署名 (ECDSA) ができるので EOA として扱う (accountDetection と同形式)。
 */
export function isNonDelegatedContractCode(code: Hex | undefined): boolean {
  if (!code || code === '0x') return false;
  return !/^0xef0100[0-9a-f]{40}$/i.test(code);
}
