// 受取チェーンを 2 つ以上にするとき、受取ウォレットがどれかのチェーンでコントラクトのウォレットでないかを確かめる。
// EIP-7702 で委任した EOA (0xef0100…) は鍵が同じなので EOA として扱う。読めなかったチェーンは分けて返す。

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { receiverChainCodes } from '@/hooks/useReceiverChainCheck';

const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const DELEGATED = `0xef0100${'11'.repeat(20)}` as `0x${string}`;
const CONTRACT = '0x6080604052' as `0x${string}`;

describe('receiverChainCodes', () => {
  it('コードの無い EOA と 7702 で委任した EOA は通し、コントラクトのチェーンだけを返す', async () => {
    const reader = async (chain: string) => (chain === 'polygon' ? undefined : chain === 'kaia' ? DELEGATED : CONTRACT);
    await expect(receiverChainCodes(ADDRESS, ['polygon', 'kaia', 'avalanche'], reader)).resolves.toEqual({
      contract: ['avalanche'],
      failed: [],
    });
  });

  it('読めなかったチェーンは failed に分ける', async () => {
    const reader = async (chain: string) => {
      if (chain === 'kaia') throw new Error('rpc down');
      return '0x' as `0x${string}`;
    };
    await expect(receiverChainCodes(ADDRESS, ['polygon', 'kaia'], reader)).resolves.toEqual({ contract: [], failed: ['kaia'] });
  });
});
