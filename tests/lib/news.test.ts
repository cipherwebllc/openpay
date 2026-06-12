import { describe, it, expect } from 'vitest';
import { NEWS_ITEMS, sortedNews, latestNewsId } from '@/lib/news';

describe('lib/news: コンテンツ規約 (SOT 不変条件)', () => {
  it('id が重複しない', () => {
    const ids = NEWS_ITEMS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('全 item の date が YYYY-MM-DD 形式かつ有効な日付', () => {
    for (const n of NEWS_ITEMS) {
      expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 解釈して NaN にならない (例: 2026-13-40 を弾く)。
      const d = new Date(`${n.date}T00:00:00Z`);
      expect(Number.isNaN(d.getTime())).toBe(false);
      // round-trip で同じ日付に戻る (Date が桁あふれを silently 補正していない)。
      expect(d.toISOString().slice(0, 10)).toBe(n.date);
    }
  });

  it('全 item の category が許可された 3 種のいずれか', () => {
    for (const n of NEWS_ITEMS) {
      expect(['feature', 'pricing', 'notice']).toContain(n.category);
    }
  });

  it('全 item に ja/en の title・body が非空文字列で揃っている (parity)', () => {
    for (const n of NEWS_ITEMS) {
      for (const loc of ['ja', 'en'] as const) {
        expect(typeof n.title[loc]).toBe('string');
        expect(n.title[loc].trim().length).toBeGreaterThan(0);
        expect(typeof n.body[loc]).toBe('string');
        expect(n.body[loc].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('id は kebab-case (小文字英数 + ハイフン)', () => {
    for (const n of NEWS_ITEMS) {
      expect(n.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('link がある item は href / labelJa / labelEn が妥当', () => {
    for (const n of NEWS_ITEMS) {
      if (!n.link) continue;
      // 内部 ('/' 始まり) か https の外部 URL。
      expect(n.link.href).toMatch(/^(\/|https:\/\/)/);
      expect(n.link.labelJa.trim().length).toBeGreaterThan(0);
      expect(n.link.labelEn.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('lib/news: sortedNews / latestNewsId', () => {
  it('sortedNews は date 降順 (新しい順)', () => {
    const dates = sortedNews().map((n) => n.date);
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(dates).toEqual(sorted);
  });

  it('sortedNews は全 item を漏れなく含む (件数一致 + id 集合一致)', () => {
    const s = sortedNews();
    expect(s).toHaveLength(NEWS_ITEMS.length);
    expect(new Set(s.map((n) => n.id))).toEqual(new Set(NEWS_ITEMS.map((n) => n.id)));
  });

  it('latestNewsId は sortedNews の先頭 id', () => {
    expect(latestNewsId()).toBe(sortedNews()[0]?.id ?? null);
  });

  it('NEWS_ITEMS が空でないこと (初期コンテンツ存在)', () => {
    // 空でも壊れない設計だが、初期 3 件以上の周知コンテンツを同梱する規約。
    expect(NEWS_ITEMS.length).toBeGreaterThanOrEqual(3);
  });

  it('最新の pricing 文面が legal.ts の開示と矛盾しない (決済1件ごと / 1% / 最低2JPYC / 7月)', () => {
    // 最新 (date 降順先頭) の pricing が現行の料金 SOT。2026-06-12 改定 = per-tx 利用料。
    const pricing = sortedNews().find((n) => n.category === 'pricing');
    expect(pricing).toBeDefined();
    expect(pricing!.body.ja).toMatch(/決済\s*1\s*件ごと/);
    expect(pricing!.body.ja).toContain('1%');
    expect(pricing!.body.ja).toMatch(/最低\s*2\s*JPYC/);
    expect(pricing!.body.ja).toMatch(/7\s*月/);
    // 断定的な「無料」誤誘導ではなく、無料の範囲 (通常決済等) を明記している。
    expect(pricing!.body.ja).toMatch(/無料/);
    // 負担者は店舗が選択できることを明示 (gasMode トグルの開示)。
    expect(pricing!.body.ja).toMatch(/店舗が.*選択/);
  });

  it('置き換え済みの旧 pricing/feature お知らせは superseded 注記を持つ (黙った書き換え禁止)', () => {
    const monthly = NEWS_ITEMS.find((n) => n.id === 'usage-fee-2026-07');
    const free = NEWS_ITEMS.find((n) => n.id === 'jpyc-gasless-free');
    for (const stale of [monthly, free]) {
      expect(stale).toBeDefined();
      expect(stale!.body.ja).toMatch(/置き換えられました/);
      expect(stale!.body.en).toMatch(/superseded/i);
    }
    // 旧文面が現行料金を断定しない (全額負担/徴収しません の現在形断定が残っていない)。
    expect(free!.body.ja).not.toMatch(/一切徴収しません/);
  });
});
