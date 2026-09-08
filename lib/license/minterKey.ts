import 'server-only';

import type { Hex } from 'viem';

/** relay の鍵は共有しない。未設定/不正な minter 鍵で別 EOA へ fallback しない。 */
export function licenseMinterPrivateKey(): Hex | null {
  const key = process.env.LICENSE_MINTER_PRIVATE_KEY;
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) && BigInt(key) > 0n &&
    BigInt(key) < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n ? key as Hex : null;
}
