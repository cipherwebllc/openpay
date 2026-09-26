import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// unstable_cache の最小の擬似実装: 解決した値だけを覚え、例外は覚えない (Next の挙動と同じ)。
const cacheState = vi.hoisted(() => ({
  options: undefined as { revalidate?: number; tags?: string[] } | undefined,
  keyParts: undefined as string[] | undefined,
  stored: undefined as { value: unknown } | undefined,
}));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[], options: { revalidate?: number; tags?: string[] }) => {
    cacheState.keyParts = keyParts;
    cacheState.options = options;
    return async () => {
      if (cacheState.stored) return cacheState.stored.value;
      const value = await fn();
      cacheState.stored = { value };
      return value;
    };
  },
}));

const list = vi.hoisted(() => vi.fn());
vi.mock('@/lib/x402/storeListing', () => ({ listStoreListings: list }));

import { listStoreListingsCached, STORE_LISTINGS_REVALIDATE_SEC } from '@/lib/x402/storeListingCache';

const LISTING = { id: 'h_1', title: 'fixture', priceJpyc: '100', totalJpyc: '101', feeJpyc: '1', handle: 'shop', updatedAt: 1, label: 'data' };

describe('listStoreListingsCached', () => {
  beforeEach(() => {
    list.mockReset();
    cacheState.stored = undefined;
  });

  it('公開データを 60 秒だけ共有キャッシュする (tag 付き)', () => {
    expect(STORE_LISTINGS_REVALIDATE_SEC).toBe(60);
    expect(cacheState.options).toEqual({ revalidate: 60, tags: ['store-listings'] });
    expect(cacheState.keyParts).toEqual(['store-listings-v1']);
  });

  it('成功した一覧はキャッシュから返し、KV を読み直さない', async () => {
    list.mockResolvedValue([LISTING]);
    expect(await listStoreListingsCached()).toEqual([LISTING]);
    expect(await listStoreListingsCached()).toEqual([LISTING]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('KV 障害 (null) はキャッシュせず、次の表示で読み直す', async () => {
    list.mockResolvedValueOnce(null).mockResolvedValueOnce([LISTING]);
    expect(await listStoreListingsCached()).toBeNull();
    expect(await listStoreListingsCached()).toEqual([LISTING]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('想定外の例外はそのまま投げる (null に丸めない)', async () => {
    list.mockRejectedValueOnce(new Error('boom'));
    await expect(listStoreListingsCached()).rejects.toThrow('boom');
  });
});
