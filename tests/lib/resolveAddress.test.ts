import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isLikelyName } from '@/lib/resolveAddress';

// resolveAddress の network ロジックは viem の getEnsAddress に委譲して
// いるため、ここでは isLikelyName と "0x 直接入力" の即時 return path
// だけ実コードでテストし、ENS / Basenames の RPC 経路は別途 e2e で検証する。

describe('isLikelyName', () => {
  it('0x address → false', () => {
    expect(isLikelyName('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
      false,
    );
  });

  it('空文字 → false', () => {
    expect(isLikelyName('')).toBe(false);
  });

  it('vitalik.eth → true', () => {
    expect(isLikelyName('vitalik.eth')).toBe(true);
  });

  it('VITALIK.ETH (大文字) → true', () => {
    expect(isLikelyName('VITALIK.ETH')).toBe(true);
  });

  it('jesse.base.eth → true (Basenames)', () => {
    expect(isLikelyName('jesse.base.eth')).toBe(true);
  });

  it('foo.bar (.eth ない) → false', () => {
    expect(isLikelyName('foo.bar')).toBe(false);
  });

  it('前後空白付きでも判定', () => {
    expect(isLikelyName('  vitalik.eth  ')).toBe(true);
  });
});

describe('resolveAddress (0x ショートサーキット)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('0x アドレスは RPC を叩かず即時 return', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    const r = await resolveAddress(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    );
    expect(r).not.toBeNull();
    // checksum 化される
    expect(r?.address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(r?.name).toBeNull();
  });

  it('空文字 → null', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    expect(await resolveAddress('')).toBeNull();
    expect(await resolveAddress('   ')).toBeNull();
  });

  it('0x でも .eth でもない → 例外', async () => {
    const { resolveAddress } = await import('@/lib/resolveAddress');
    await expect(resolveAddress('not-an-address')).rejects.toThrow(
      /0x アドレスまたは/,
    );
  });
});
