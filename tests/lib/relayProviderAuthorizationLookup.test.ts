// relayProvider.findAuthorizationUsedTransactionHash の配線: 1 回の検索 (直近 10,000 ブロック) が通ればそのまま
// (従来どおり)。RPC の範囲制限で拒まれたら、window を渡したときだけ範囲を絞って小分けに探し、渡さなければ従来
// どおり失敗を上げる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const TX = `0x${'ab'.repeat(32)}` as Hex;
const chainState = vi.hoisted(() => ({
  latest: 3000n,
  maxRange: 10n as bigint | null, // null = 範囲制限なし
  logBlock: 2450n,
  calls: { getLogs: 0, getBlock: 0 },
}));
const ts = (n: bigint) => 1_800_000_000n + n * 2n;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBlockNumber: async () => chainState.latest,
      getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
        chainState.calls.getBlock += 1;
        const n = args.blockTag === 'latest' ? chainState.latest : args.blockNumber!;
        return { number: n, timestamp: ts(n) };
      },
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        chainState.calls.getLogs += 1;
        if (chainState.maxRange !== null && toBlock - fromBlock + 1n > chainState.maxRange) {
          throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
        }
        return chainState.logBlock >= fromBlock && chainState.logBlock <= toBlock ? [{ transactionHash: TX }] : [];
      },
    }),
  };
});

import { findAuthorizationUsedTransactionHash } from '@/lib/relay/relayProvider';

const TOKEN = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const FROM = '0x0000000000000000000000000000000000000abc' as Address;
const NONCE = `0x${'33'.repeat(32)}` as Hex;
const WINDOW = { validAfter: 0n, validBefore: ts(2500n), maxWindowSec: 210 };

afterEach(() => {
  chainState.maxRange = 10n;
  chainState.calls = { getLogs: 0, getBlock: 0 };
});

describe('findAuthorizationUsedTransactionHash (RPC の範囲制限)', () => {
  it('1 回で検索できる RPC では従来どおり 1 回だけ (ブロックの時刻も読まない)', async () => {
    chainState.maxRange = null;
    expect(await findAuthorizationUsedTransactionHash(80002, TOKEN, FROM, NONCE, WINDOW)).toBe(TX);
    expect(chainState.calls).toEqual({ getLogs: 1, getBlock: 0 });
  });

  it('範囲制限で拒まれたら、window があれば署名が使われうる時刻に絞って小分けに探す', async () => {
    expect(await findAuthorizationUsedTransactionHash(80002, TOKEN, FROM, NONCE, WINDOW)).toBe(TX);
    expect(chainState.calls.getLogs).toBeGreaterThan(1);
  });

  it('window が無ければ、従来どおり失敗を上げる (呼び出し側は「結論を出さない」)', async () => {
    await expect(findAuthorizationUsedTransactionHash(80002, TOKEN, FROM, NONCE)).rejects.toThrow(/10 block range/);
    expect(chainState.calls).toEqual({ getLogs: 1, getBlock: 0 });
  });
});
