import { describe, it, expect } from 'vitest';
import {
  EXPLORE_ENTRIES,
  EXPLORE_CATEGORY_ORDER,
  entriesByCategory,
} from '@/lib/explore';

describe('lib/explore: EXPLORE_ENTRIES の整合性', () => {
  it('id は一意 (deduplication / test key 用)', () => {
    const ids = EXPLORE_ENTRIES.map((e) => e.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('全 entry の URL は https:// で始まる (http や javascript: は弾く)', () => {
    for (const e of EXPLORE_ENTRIES) {
      expect(e.url).toMatch(/^https:\/\//);
    }
  });

  it('全 entry の category は EXPLORE_CATEGORY_ORDER に含まれる', () => {
    for (const e of EXPLORE_ENTRIES) {
      expect(EXPLORE_CATEGORY_ORDER).toContain(e.category);
    }
  });

  it('全 entry に description.ja / description.en が非空文字列で揃う (i18n parity)', () => {
    for (const e of EXPLORE_ENTRIES) {
      expect(typeof e.description.ja).toBe('string');
      expect(e.description.ja.length).toBeGreaterThan(0);
      expect(typeof e.description.en).toBe('string');
      expect(e.description.en.length).toBeGreaterThan(0);
    }
  });

  it('name は非空 (表示用)', () => {
    for (const e of EXPLORE_ENTRIES) {
      expect(typeof e.name).toBe('string');
      expect(e.name.length).toBeGreaterThan(0);
    }
  });

  it('各カテゴリに最低 1 entry が存在する (空カテゴリで UI が空 section を出さない)', () => {
    const grouped = entriesByCategory();
    for (const cat of EXPLORE_CATEGORY_ORDER) {
      const entries = grouped.get(cat) ?? [];
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it('badge が指定されている場合、値は jp-only / global / beta のいずれか', () => {
    const valid = new Set(['jp-only', 'global', 'beta']);
    for (const e of EXPLORE_ENTRIES) {
      if (!e.badges) continue;
      for (const b of e.badges) {
        expect(valid.has(b)).toBe(true);
      }
    }
  });

  it('tokens が指定されている場合、値は jpyc / usdc のいずれか', () => {
    const valid = new Set(['jpyc', 'usdc']);
    for (const e of EXPLORE_ENTRIES) {
      if (!e.tokens) continue;
      for (const tok of e.tokens) {
        expect(valid.has(tok)).toBe(true);
      }
    }
  });
});

describe('lib/explore: entriesByCategory', () => {
  it('全 entry が grouping され、合計件数が EXPLORE_ENTRIES と一致', () => {
    const grouped = entriesByCategory();
    let total = 0;
    for (const cat of EXPLORE_CATEGORY_ORDER) {
      total += (grouped.get(cat) ?? []).length;
    }
    expect(total).toBe(EXPLORE_ENTRIES.length);
  });

  it('order は EXPLORE_CATEGORY_ORDER と一致 (Map iteration 順)', () => {
    const grouped = entriesByCategory();
    const keys = Array.from(grouped.keys());
    expect(keys).toEqual([...EXPLORE_CATEGORY_ORDER]);
  });

  it('category 内の order は EXPLORE_ENTRIES の宣言順を保持', () => {
    const grouped = entriesByCategory();
    for (const cat of EXPLORE_CATEGORY_ORDER) {
      const filteredFromSource = EXPLORE_ENTRIES.filter((e) => e.category === cat).map(
        (e) => e.id,
      );
      const fromGrouping = (grouped.get(cat) ?? []).map((e) => e.id);
      expect(fromGrouping).toEqual(filteredFromSource);
    }
  });
});
