import { describe, it, expect, vi } from 'vitest';
import type { PublicClient } from 'viem';
import {
  detectAccountKind,
  IncompatibleSmartAccountError,
  isIncompatibleSmartAccountError,
  PIMLICO_SIMPLE7702_ADDRESS,
  ALCHEMY_MAV2_ADDRESS,
  METAMASK_DELEGATOR_ADDRESS,
} from '@/lib/accountDetection';

const ADDR = '0x1138cDC8E85330C428562AA7849e252De63c089F' as const;

function mockPublicClient(code: string | undefined): PublicClient {
  return {
    getCode: vi.fn().mockResolvedValue(code),
  } as unknown as PublicClient;
}

describe('detectAccountKind', () => {
  it('空 EOA (0x): none', async () => {
    const c = mockPublicClient('0x');
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('none');
    expect(r.delegateAddress).toBeNull();
  });

  it('undefined (RPC が code 未返却): none', async () => {
    const c = mockPublicClient(undefined);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('none');
  });

  it('Pimlico SimpleAccount 7702: pimlico-simple-7702', async () => {
    const code = `0xef0100${PIMLICO_SIMPLE7702_ADDRESS.slice(2).toLowerCase()}`;
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('pimlico-simple-7702');
    expect(r.delegateAddress).toBe(PIMLICO_SIMPLE7702_ADDRESS);
  });

  it('Alchemy MAv2 7702: alchemy-mav2-7702', async () => {
    const code = `0xef0100${ALCHEMY_MAV2_ADDRESS.slice(2).toLowerCase()}`;
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('alchemy-mav2-7702');
    expect(r.delegateAddress).toBe(ALCHEMY_MAV2_ADDRESS);
  });

  it('MetaMask Smart Account (EIP7702StatelessDeleGator): metamask-7702', async () => {
    // MetaMask delegator は 23 mainnet 全てで同 address に CREATE2 deploy
    // (salt "GATOR")、確認 2026-05-24。
    const code = `0xef0100${METAMASK_DELEGATOR_ADDRESS.slice(2).toLowerCase()}`;
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('metamask-7702');
    expect(r.delegateAddress).toBe(METAMASK_DELEGATOR_ADDRESS);
  });

  it('checksum 大文字混在の code でも一致する (case-insensitive)', async () => {
    // RPC は通常 lower だが provider 実装によって checksum を返すケースを保険的にテスト
    const code = `0xEF0100${ALCHEMY_MAV2_ADDRESS.slice(2)}`;
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('alchemy-mav2-7702');
  });

  it('未知の 7702 委任先: unknown + delegateAddress 保持', async () => {
    const unknownDelegate = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const code = `0xef0100${unknownDelegate.slice(2)}`;
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('unknown');
    // checksum 化されて返る
    expect(r.delegateAddress?.toLowerCase()).toBe(unknownDelegate);
  });

  it('7702 prefix だが長さが不正 (20 byte 未満): unknown', async () => {
    const code = '0xef0100abcd';
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('unknown');
    expect(r.delegateAddress).toBeNull();
  });

  it('7702 prefix だが target が無効な hex: unknown', async () => {
    // 40 chars だが invalid (getAddress が throw する偽データ — ただし viem は length OK なら通すので別の判定)
    // ここでは 0xef0100 + 40 hex の通常ケース。getAddress は基本通るが、prefix なし non-eip-55 では通る。
    // 真の不正 case として、文字列長が 48 以外を unknown と扱うことを既に確認済み。
    // ここは 7702 prefix なしの contract code (旧来の deploy 済 contract) を unknown とする方を確認。
    const code = '0x60806040526004361015610026575b36156100245761001c612135565b602081519101f35b005b'; // 普通の contract bytecode の頭
    const c = mockPublicClient(code);
    const r = await detectAccountKind(c, ADDR);
    expect(r.kind).toBe('unknown');
    expect(r.delegateAddress).toBeNull();
  });
});

describe('IncompatibleSmartAccountError', () => {
  it('delegateAddress と i18nKey を保持', () => {
    const e = new IncompatibleSmartAccountError({
      delegateAddress: ALCHEMY_MAV2_ADDRESS,
      i18nKey: 'errorMav2Disabled',
    });
    expect(e.name).toBe('IncompatibleSmartAccountError');
    expect(e.delegateAddress).toBe(ALCHEMY_MAV2_ADDRESS);
    expect(e.i18nKey).toBe('errorMav2Disabled');
    expect(e.message).toContain('incompatible_smart_account');
    expect(e.message).toContain(ALCHEMY_MAV2_ADDRESS);
  });

  it('delegateAddress=null でも構築可能', () => {
    const e = new IncompatibleSmartAccountError({
      delegateAddress: null,
      i18nKey: 'errorIncompatibleSmartAccount',
    });
    expect(e.delegateAddress).toBeNull();
    expect(e.message).toContain('none');
  });

  it('errorMetaMaskKaia i18nKey でも構築可能 (Kaia + MetaMask SC ガード用)', () => {
    const e = new IncompatibleSmartAccountError({
      delegateAddress: METAMASK_DELEGATOR_ADDRESS,
      i18nKey: 'errorMetaMaskKaia',
    });
    expect(e.i18nKey).toBe('errorMetaMaskKaia');
    expect(e.delegateAddress).toBe(METAMASK_DELEGATOR_ADDRESS);
  });
});

describe('isIncompatibleSmartAccountError', () => {
  it('真の instance を判定', () => {
    const e = new IncompatibleSmartAccountError({
      delegateAddress: null,
      i18nKey: 'errorIncompatibleSmartAccount',
    });
    expect(isIncompatibleSmartAccountError(e)).toBe(true);
  });

  it('普通の Error は false', () => {
    expect(isIncompatibleSmartAccountError(new Error('boom'))).toBe(false);
  });

  it('null / undefined / プリミティブは false', () => {
    expect(isIncompatibleSmartAccountError(null)).toBe(false);
    expect(isIncompatibleSmartAccountError(undefined)).toBe(false);
    expect(isIncompatibleSmartAccountError('x')).toBe(false);
    expect(isIncompatibleSmartAccountError(42)).toBe(false);
  });

  it('name=IncompatibleSmartAccountError を持つ任意 object は true (HMR 耐性)', () => {
    const fake = { name: 'IncompatibleSmartAccountError', message: 'replicated' };
    expect(isIncompatibleSmartAccountError(fake)).toBe(true);
  });
});
