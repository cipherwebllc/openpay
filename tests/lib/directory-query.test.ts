import { describe, expect, it } from 'vitest';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  capDirectoryLimit,
  createDirectoryEnvelope,
  directoryCategoryCounts,
  directoryStats,
  directoryTagCounts,
  findPublishedDirectoryEntry,
  publishedDirectoryEntries,
  queryDirectory,
  validateDirectoryQuery,
} from '@/lib/directory/query';
import type { DirectoryQuery } from '@/lib/directory/types';

const DEFAULT_QUERY: DirectoryQuery = { limit: 20, offset: 0 };

describe('directory query pure functions', () => {
  it('公開一覧から draft を必ず除外する', () => {
    const published = publishedDirectoryEntries(DIRECTORY_ENTRIES);
    expect(published.length).toBeGreaterThanOrEqual(15);
    expect(published.length).toBeLessThanOrEqual(25);
    expect(published.every((entry) => entry.status === 'published')).toBe(true);
    expect(published.some((entry) => entry.slug === 'directory-draft-fixture')).toBe(
      false,
    );
  });

  it('keyword は name / nameJa / description / tags の部分一致を行う', () => {
    expect(
      queryDirectory(DIRECTORY_ENTRIES, {
        ...DEFAULT_QUERY,
        keyword: 'SBI VC',
      }).items.map((entry) => entry.slug),
    ).toContain('sbi-vc-trade');
    expect(
      queryDirectory(DIRECTORY_ENTRIES, {
        ...DEFAULT_QUERY,
        keyword: 'ビットバンク',
      }).items.map((entry) => entry.slug),
    ).toContain('bitbank');
    expect(
      queryDirectory(DIRECTORY_ENTRIES, {
        ...DEFAULT_QUERY,
        keyword: '発行と償還',
      }).items.map((entry) => entry.slug),
    ).toContain('jpyc-ex');
    expect(
      queryDirectory(DIRECTORY_ENTRIES, {
        ...DEFAULT_QUERY,
        keyword: 'self-custody',
      }).items.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('category / token / chain / language / capability を組み合わせて絞る', () => {
    const result = queryDirectory(DIRECTORY_ENTRIES, {
      ...DEFAULT_QUERY,
      category: 'wallet',
      token: 'jpyc',
      language: 'en',
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    });
    expect(result.items.map((entry) => entry.slug)).toEqual([
      'metamask',
      'rabby-wallet',
      'coinbase-wallet',
    ]);

    const polygon = queryDirectory(DIRECTORY_ENTRIES, {
      ...DEFAULT_QUERY,
      chain: 'polygon',
    });
    expect(polygon.items.length).toBeGreaterThan(0);
    expect(
      polygon.items.every((entry) => entry.facts.chains.includes('polygon')),
    ).toBe(true);
  });

  it('status=draft でも非公開データを返さない', () => {
    expect(
      queryDirectory(DIRECTORY_ENTRIES, {
        ...DEFAULT_QUERY,
        status: 'draft',
      }),
    ).toEqual({ items: [], total: 0 });
  });

  it('offset は total を変えずにページ位置だけを進める', () => {
    const first = queryDirectory(DIRECTORY_ENTRIES, {
      ...DEFAULT_QUERY,
      limit: 2,
    });
    const second = queryDirectory(DIRECTORY_ENTRIES, {
      ...DEFAULT_QUERY,
      limit: 2,
      offset: 2,
    });
    expect(second.total).toBe(first.total);
    expect(second.items[0]?.slug).toBe(
      publishedDirectoryEntries(DIRECTORY_ENTRIES)[2]?.slug,
    );
  });

  it('validator は allowlist を使い、limit/offset 上限を強制する', () => {
    const parsed = validateDirectoryQuery(
      new URLSearchParams(
        'token=JPYC&supportsJpyc=true&limit=999&offset=9999',
      ),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        token: 'jpyc',
        supportsJpyc: true,
        limit: 50,
        offset: 1000,
      },
    });
    if (parsed.ok) expect(capDirectoryLimit(parsed.value, 5).limit).toBe(5);

    expect(
      validateDirectoryQuery(new URLSearchParams('category=not-real')),
    ).toEqual({ ok: false, error: 'invalid_query' });
    expect(
      validateDirectoryQuery(new URLSearchParams('unexpected=true')),
    ).toEqual({ ok: false, error: 'invalid_query' });
  });

  it('封筒は freshness と attribution を生成し、attribution を重複排除する', () => {
    const result = queryDirectory(DIRECTORY_ENTRIES, {
      ...DEFAULT_QUERY,
      supportsUsdc: true,
    });
    const envelope = createDirectoryEnvelope(
      DEFAULT_QUERY,
      result,
      '2026-07-13T00:00:00.000Z',
    );
    expect(envelope).toMatchObject({
      schemaVersion: '1.0',
      query: DEFAULT_QUERY,
      total: result.total,
      generatedAt: '2026-07-13T00:00:00.000Z',
      dataFreshness: {
        oldest: '2026-07-13',
        newestVerifiedAt: '2026-07-13',
      },
    });
    expect(new Set(envelope.attribution).size).toBe(
      envelope.attribution.length,
    );
    expect(
      envelope.items.every((entry) => entry.sourceUrl && entry.attribution),
    ).toBe(true);
  });

  it('カテゴリとタグの件数にも draft を含めない', () => {
    const categoryTotal = directoryCategoryCounts(DIRECTORY_ENTRIES).reduce(
      (sum, item) => sum + item.count,
      0,
    );
    expect(categoryTotal).toBe(
      publishedDirectoryEntries(DIRECTORY_ENTRIES).length,
    );
    expect(directoryTagCounts(DIRECTORY_ENTRIES)).not.toContainEqual({
      tag: 'draft',
      count: 1,
    });
    expect(directoryStats(DIRECTORY_ENTRIES)).toEqual({
      entryCount: publishedDirectoryEntries(DIRECTORY_ENTRIES).length,
      categoryCount: directoryCategoryCounts(DIRECTORY_ENTRIES).length,
      lastUpdated: '2026-07-13',
    });
  });

  it('slug 検索は published だけを返す', () => {
    expect(findPublishedDirectoryEntry(DIRECTORY_ENTRIES, 'jpyc')?.name).toBe(
      'JPYC',
    );
    expect(
      findPublishedDirectoryEntry(
        DIRECTORY_ENTRIES,
        'directory-draft-fixture',
      ),
    ).toBeUndefined();
  });
});
