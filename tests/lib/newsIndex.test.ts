import { describe, expect, it } from 'vitest';
import { NEWS_ITEMS, sortedNews } from '@/lib/news';
import { NEWS_INDEX, latestNewsId, sortedNewsIndex } from '@/lib/newsIndex';

// 索引 (lib/newsIndex.ts) は本文 SOT (lib/news.ts) の id/date の複製。ズレると未読バッジが狂うので固定する。
describe('newsIndex', () => {
  it('NEWS_INDEX は NEWS_ITEMS の id/date と同じ順で一致する', () => {
    expect(NEWS_INDEX).toEqual(NEWS_ITEMS.map(({ id, date }) => ({ id, date })));
  });
  it('sortedNewsIndex / latestNewsId は sortedNews と同じ順序・同じ先頭', () => {
    expect(sortedNewsIndex().map((n) => n.id)).toEqual(sortedNews().map((n) => n.id));
    expect(latestNewsId()).toBe(sortedNews()[0]?.id ?? null);
  });
});
