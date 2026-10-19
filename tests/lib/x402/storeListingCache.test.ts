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
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn } }));

import {
  fitStoreListingsForCache,
  listStoreListingsCached,
  STORE_LISTINGS_CACHE_BUDGET_BYTES,
  STORE_LISTINGS_REVALIDATE_SEC,
} from '@/lib/x402/storeListingCache';
import type { StoreListing } from '@/lib/x402/storeListing';
import {
  MAX_HOSTED_DESC_LEN,
  MAX_HOSTED_DETAILS_LEN,
  MAX_HOSTED_SPECS,
  MAX_HOSTED_SPEC_LABEL_LEN,
  MAX_HOSTED_SPEC_VALUE_LEN,
  MAX_HOSTED_TITLE_LEN,
} from '@/lib/x402/hostedStore';
import { STORE_INDEX_MAX_IDS } from '@/lib/x402/storeIndex';
import { MAX_USAGE_NOTE_LEN } from '@/lib/store/usageTerms';

/** 入力の上限いっぱい・エスケープで膨らむ文字 (\) だけで作った、いちばん重い掲載。 */
function heaviest(n: number): StoreListing {
  const heavy = (len: number) => '\\'.repeat(len);
  return {
    id: `h_${String(n).padStart(32, '0')}`,
    title: heavy(MAX_HOSTED_TITLE_LEN),
    desc: heavy(MAX_HOSTED_DESC_LEN),
    priceJpyc: '1000000',
    totalJpyc: '1010000',
    feeJpyc: '10000',
    label: 'download',
    contentKind: 'url',
    handle: 'shop',
    updatedAt: 1,
    details: heavy(MAX_HOSTED_DETAILS_LEN),
    specs: Array.from({ length: MAX_HOSTED_SPECS }, () => ({
      label: heavy(MAX_HOSTED_SPEC_LABEL_LEN),
      value: heavy(MAX_HOSTED_SPEC_VALUE_LEN),
    })),
    // 利用条件は落とさない (小さく、買う判断に直接かかわる)。上限いっぱいでも予算に収まることを下で固定する。
    usage: { commercial: 'not_allowed', modify: 'not_allowed', redistribute: 'not_allowed', note: heavy(MAX_USAGE_NOTE_LEN) },
  } as StoreListing;
}

const LISTING = { id: 'h_1', title: 'fixture', priceJpyc: '100', totalJpyc: '101', feeJpyc: '1', handle: 'shop', updatedAt: 1, label: 'data' };

describe('listStoreListingsCached', () => {
  beforeEach(() => {
    list.mockReset();
    cacheState.stored = undefined;
  });

  it('公開データを 60 秒だけ共有キャッシュする (tag 付き)', () => {
    expect(STORE_LISTINGS_REVALIDATE_SEC).toBe(60);
    expect(cacheState.options).toEqual({ revalidate: 60, tags: ['store-listings'] });
    expect(cacheState.keyParts).toEqual(['store-listings-v2']);
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

// Codex レビュー P2: 文字数の上限は直列化後の大きさを縛らない。Data Cache の 1 件 2 MB を超えると黙ってキャッシュされず、
// 毎回 KV を読む。保存の前に大きさを測り、AI 向けの詳細を落として必ず収める。
describe('fitStoreListingsForCache', () => {
  beforeEach(() => warn.mockReset());

  it('いちばん重い掲載 (上限 200 件・入力の上限いっぱい・エスケープで膨らむ文字) でも予算に収め、本体は残す', () => {
    const listings = Array.from({ length: STORE_INDEX_MAX_IDS }, (_, i) => heaviest(i));
    const fitted = fitStoreListingsForCache(listings);
    const size = Buffer.byteLength(JSON.stringify(JSON.stringify(fitted.listings)), 'utf8');
    expect(size).toBeLessThanOrEqual(STORE_LISTINGS_CACHE_BUDGET_BYTES);
    expect(fitted.dropped.length).toBeGreaterThan(0);
    expect(fitted.listings).toHaveLength(STORE_INDEX_MAX_IDS);
    expect(fitted.listings.map((listing) => listing.id)).toEqual(listings.map((listing) => listing.id));
    expect(fitted.listings.every((listing) => listing.priceJpyc === '1000000' && listing.handle === 'shop')).toBe(true);
    expect(fitted.listings.every((listing) => listing.usage?.note?.length === MAX_USAGE_NOTE_LEN)).toBe(true);
  });

  it('予算内なら何も落とさない (詳細も残す)', () => {
    const listings = [heaviest(1), heaviest(2)];
    expect(fitStoreListingsForCache(listings)).toEqual({ listings, dropped: [] });
  });

  it('details を落とせば足りるときは specs を残す', () => {
    const listings = [heaviest(1)];
    const onlyDetailsBudget = Buffer.byteLength(JSON.stringify(JSON.stringify([{ ...listings[0], details: undefined }])), 'utf8');
    const fitted = fitStoreListingsForCache(listings, onlyDetailsBudget);
    expect(fitted.dropped).toEqual(['details']);
    expect(fitted.listings[0].specs).toHaveLength(MAX_HOSTED_SPECS);
    expect('details' in fitted.listings[0]).toBe(false);
  });

  it('キャッシュに入れる前に収め、落としたら警告を残す', async () => {
    list.mockReset();
    cacheState.stored = undefined;
    list.mockResolvedValue(Array.from({ length: STORE_INDEX_MAX_IDS }, (_, i) => heaviest(i)));
    const cached = (await listStoreListingsCached())!;
    expect(Buffer.byteLength(JSON.stringify(JSON.stringify(cached)), 'utf8')).toBeLessThanOrEqual(STORE_LISTINGS_CACHE_BUDGET_BYTES);
    expect(warn).toHaveBeenCalledWith('store.listings_cache.trimmed', expect.objectContaining({ count: STORE_INDEX_MAX_IDS }));
  });
});
