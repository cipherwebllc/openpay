// lib/x402/resourceRequestGuards.ts の単体検証。
// 出品リソースの書き込み面はウォレット単位の固定窓で守られている。上限・窓・キー名前空間が
// 静かに変わると全出品者に影響するため定数ごと固定し、rate-limit ストレージ障害時の
// fail-open (掟13: 付帯処理の障害を本体へ波及させない) も明示的に固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  throws: false,
  calls: [] as Array<{ key: string; max: number; windowSec: number }>,
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: async (key: string, max: number, windowSec: number) => {
    hold.calls.push({ key, max, windowSec });
    if (hold.throws) throw new Error('kv down');
    const next = (hold.counts.get(key) ?? 0) + 1;
    hold.counts.set(key, next);
    return next <= max;
  },
}));

import {
  checkResourceWalletRateLimit,
  RESOURCE_RATE_LIMIT_MAX,
  RESOURCE_RATE_LIMIT_WINDOW_SEC,
} from '@/lib/x402/resourceRequestGuards';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

beforeEach(() => {
  hold.counts = new Map();
  hold.throws = false;
  hold.calls = [];
});

describe('checkResourceWalletRateLimit', () => {
  it('上限 (10) までは許可し、11 回目で拒否する', async () => {
    expect(RESOURCE_RATE_LIMIT_MAX).toBe(10);
    const results: boolean[] = [];
    for (let i = 0; i < RESOURCE_RATE_LIMIT_MAX + 1; i += 1) {
      results.push(await checkResourceWalletRateLimit(WALLET));
    }
    expect(results.slice(0, RESOURCE_RATE_LIMIT_MAX)).toEqual(
      Array.from({ length: RESOURCE_RATE_LIMIT_MAX }, () => true),
    );
    expect(results[RESOURCE_RATE_LIMIT_MAX]).toBe(false);
  });

  it('キーは x402res: 名前空間 + 小文字ウォレット (大小表記で窓が割れない)', async () => {
    await checkResourceWalletRateLimit(WALLET);
    await checkResourceWalletRateLimit(WALLET.toLowerCase());

    expect(hold.calls).toEqual([
      {
        key: `x402res:${WALLET.toLowerCase()}`,
        max: RESOURCE_RATE_LIMIT_MAX,
        windowSec: RESOURCE_RATE_LIMIT_WINDOW_SEC,
      },
      {
        key: `x402res:${WALLET.toLowerCase()}`,
        max: RESOURCE_RATE_LIMIT_MAX,
        windowSec: RESOURCE_RATE_LIMIT_WINDOW_SEC,
      },
    ]);
    // 同一窓に相乗りしている (2 回目のカウントが 2)
    expect(hold.counts.get(`x402res:${WALLET.toLowerCase()}`)).toBe(2);
  });

  it('ウォレットが違えば窓は独立', async () => {
    const other = '0x0000000000000000000000000000000000000001';
    for (let i = 0; i < RESOURCE_RATE_LIMIT_MAX; i += 1) {
      await checkResourceWalletRateLimit(WALLET);
    }
    expect(await checkResourceWalletRateLimit(WALLET)).toBe(false);
    expect(await checkResourceWalletRateLimit(other)).toBe(true);
  });

  it('rate-limit ストレージ障害は fail-open (出品管理本体を止めない)', async () => {
    hold.throws = true;
    expect(await checkResourceWalletRateLimit(WALLET)).toBe(true);
  });
});
