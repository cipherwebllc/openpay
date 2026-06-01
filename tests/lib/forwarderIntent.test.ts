import { describe, it, expect } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import {
  FORWARDER_COMMIT_VERSION,
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  forwarderTotalValue,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

// contracts/test/Eip3009Forwarder.t.sol:test_goldenVector_nonce と同一の固定入力。
const GOLDEN: ForwarderSettleParams = {
  from: '0x1111111111111111111111111111111111111111',
  merchant: '0x2222222222222222222222222222222222222222',
  merchantValue: 1000n * 10n ** 18n,
  feeReceiver: '0x3333333333333333333333333333333333333333',
  feeValue: 2n * 10n ** 18n,
  validAfter: 0n,
  validBefore: 1_000_000_000_000n,
  intentSalt:
    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
};
const CHAIN = 80002;
const FORWARDER: Address = '0x4444444444444444444444444444444444444444';
const TOKEN: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';

describe('forwarderIntent', () => {
  it('COMMIT_VERSION は keccak256("openpay.eip3009.forwarder.v1") (契約と共有)', () => {
    expect(FORWARDER_COMMIT_VERSION).toBe(
      keccak256(toHex('openpay.eip3009.forwarder.v1')),
    );
  });

  it('buildForwarderNonce は Solidity の abi.encode と完全一致 (golden vector)', () => {
    // Solidity 側 (forge test_goldenVector_nonce) が出力した値と突き合わせる。
    // ここが一致する限り client が作る nonce を契約 settle が再計算して照合できる。
    const nonce = buildForwarderNonce(GOLDEN, CHAIN, FORWARDER);
    expect(nonce).toBe(
      '0xf1e88a8b02d5ff7edf8990e30fc9679ad4be8ba70f76bdbeb6a49742a84d20ab',
    );
  });

  it('入力が変われば nonce も変わる (改竄検知の基礎)', () => {
    const base = buildForwarderNonce(GOLDEN, CHAIN, FORWARDER);
    const tampered = buildForwarderNonce(
      { ...GOLDEN, merchantValue: GOLDEN.merchantValue - 1n, feeValue: GOLDEN.feeValue + 1n },
      CHAIN,
      FORWARDER,
    );
    expect(tampered).not.toBe(base);
  });

  it('buildReceiveWithAuthorizationTypedData: to=forwarder / value=mv+fv / nonce=commit / domain', () => {
    const t = buildReceiveWithAuthorizationTypedData(
      GOLDEN,
      CHAIN,
      TOKEN,
      FORWARDER,
    );
    expect(t.message.to).toBe(FORWARDER);
    expect(t.message.value).toBe(forwarderTotalValue(GOLDEN));
    expect(t.message.value).toBe(1002n * 10n ** 18n);
    expect(t.message.nonce).toBe(buildForwarderNonce(GOLDEN, CHAIN, FORWARDER));
    expect(t.domain.name).toBe('JPY Coin');
    expect(t.domain.version).toBe('1');
    expect(t.domain.chainId).toBe(CHAIN);
    expect(t.primaryType).toBe('ReceiveWithAuthorization');
  });
});
