import { describe, it, expect } from 'vitest';
import {
  decodeFunctionData,
  parseAbi,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildTransferWithAuthorizationTypedData,
  encodeTransferWithAuthorizationCalldata,
  recoverTransferAuthorizationSigner,
  randomAuthorizationNonce,
  validateAuthorization,
  jpycEip712Domain,
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  type Eip3009Authorization,
} from '@/lib/jpycEip3009';

const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const POLYGON = 137;
// Anvil #0 (捨て鍵)。
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);
const TO: Address = '0x000000000000000000000000000000000000dEaD';

function auth(over: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return {
    from: account.address,
    to: TO,
    value: 1000n,
    validAfter: 0n,
    validBefore: 2n ** 48n - 1n,
    nonce: `0x${'11'.repeat(32)}`,
    ...over,
  };
}

describe('jpycEip712Domain', () => {
  it('name="JPY Coin" / version="1" / chainId / verifyingContract (checksummed)', () => {
    const d = jpycEip712Domain(POLYGON, JPYC.toLowerCase() as Address);
    expect(d.name).toBe('JPY Coin');
    expect(d.version).toBe('1');
    expect(d.chainId).toBe(POLYGON);
    expect(d.verifyingContract).toBe(getAddress(JPYC));
  });
});

describe('buildTransferWithAuthorizationTypedData', () => {
  it('EIP-712 構造 (domain/types/primaryType/message) を組む', () => {
    const t = buildTransferWithAuthorizationTypedData(auth(), POLYGON, JPYC);
    expect(t.primaryType).toBe('TransferWithAuthorization');
    expect(t.domain.name).toBe('JPY Coin');
    expect(t.types.TransferWithAuthorization).toHaveLength(6);
    expect(t.message.value).toBe(1000n);
  });
});

describe('encodeTransferWithAuthorizationCalldata', () => {
  it('transferWithAuthorization の calldata を組み、decode で引数が一致する', async () => {
    const a = auth();
    const t = buildTransferWithAuthorizationTypedData(a, POLYGON, JPYC);
    const sig = await account.signTypedData({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
    });
    const data = encodeTransferWithAuthorizationCalldata(a, sig);
    const decoded = decodeFunctionData({
      abi: parseAbi([
        'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
      ]),
      data,
    });
    expect(decoded.functionName).toBe('transferWithAuthorization');
    expect(getAddress(decoded.args[0] as Address)).toBe(account.address);
    expect(getAddress(decoded.args[1] as Address)).toBe(getAddress(TO));
    expect(decoded.args[2]).toBe(1000n);
    expect(decoded.args[5]).toBe(a.nonce);
    // v は 27 / 28 に正規化される
    expect([27, 28]).toContain(decoded.args[6]);
  });
});

describe('recoverTransferAuthorizationSigner', () => {
  it('署名者を recover し from と一致する (server 側の検証)', async () => {
    const a = auth();
    const t = buildTransferWithAuthorizationTypedData(a, POLYGON, JPYC);
    const sig = await account.signTypedData({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
    });
    const signer = await recoverTransferAuthorizationSigner(a, POLYGON, JPYC, sig);
    expect(getAddress(signer)).toBe(account.address);
  });

  it('改竄された value の署名は別 signer に recover する (from と不一致)', async () => {
    const a = auth();
    const t = buildTransferWithAuthorizationTypedData(a, POLYGON, JPYC);
    const sig = await account.signTypedData({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
    });
    // 署名後に value を改竄 → recover は別アドレスになる
    const tampered = { ...a, value: 999_999n };
    const signer = await recoverTransferAuthorizationSigner(
      tampered,
      POLYGON,
      JPYC,
      sig,
    );
    expect(getAddress(signer)).not.toBe(account.address);
  });
});

describe('randomAuthorizationNonce', () => {
  it('32-byte hex でユニーク', () => {
    const a = randomAuthorizationNonce();
    const b = randomAuthorizationNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('validateAuthorization', () => {
  const now = 1_800_000_000;
  it('正常 → ok', () => {
    expect(
      validateAuthorization(
        auth({ validAfter: 0n, validBefore: BigInt(now + 60) }),
        now,
      ).ok,
    ).toBe(true);
  });
  it('value=0 → reject', () => {
    expect(validateAuthorization(auth({ value: 0n }), now).ok).toBe(false);
  });
  it('from==to → reject', () => {
    expect(
      validateAuthorization(auth({ to: account.address }), now).ok,
    ).toBe(false);
  });
  it('期限切れ (validBefore<=now) → reject', () => {
    expect(
      validateAuthorization(auth({ validBefore: BigInt(now - 1) }), now).ok,
    ).toBe(false);
  });
  it('未有効 (validAfter>now) → reject', () => {
    expect(
      validateAuthorization(
        auth({ validAfter: BigInt(now + 100), validBefore: BigInt(now + 200) }),
        now,
      ).ok,
    ).toBe(false);
  });
  it('窓が過大 → reject', () => {
    expect(
      validateAuthorization(
        auth({
          validAfter: 0n,
          validBefore: BigInt(now + AUTHORIZATION_VALIDITY_WINDOW_SEC * 10),
        }),
        now,
      ).ok,
    ).toBe(false);
  });
  it('maxValue 超過 → reject', () => {
    expect(
      validateAuthorization(auth({ value: 100n }), now, { maxValue: 50n }).ok,
    ).toBe(false);
  });
  it('nonce が 32-byte hex でない → reject', () => {
    expect(
      validateAuthorization(auth({ nonce: '0x1234' as Hex }), now).ok,
    ).toBe(false);
  });
});
