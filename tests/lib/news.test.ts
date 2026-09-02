import { describe, it, expect } from 'vitest';
import { NEWS_ITEMS, sortedNews, latestNewsId } from '@/lib/news';
import {
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';

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

  it('gas-recovery per-tx 利用料の pricing 文面が legal.ts の開示と矛盾しない (決済1件ごと / 1% / 最低2JPYC / 7月)', () => {
    // gas-recovery 利用料の SOT は id 固定で取得 (pricing 項目は複数あり得るため「最新」では特定しない)。
    const pricing = NEWS_ITEMS.find((n) => n.id === 'per-tx-fee-2026-06-12');
    expect(pricing).toBeDefined();
    expect(pricing!.body.ja).toMatch(/決済\s*1\s*件ごと/);
    expect(pricing!.body.ja).toContain('1%');
    expect(pricing!.body.ja).toMatch(/最低\s*2\s*JPYC/);
    expect(pricing!.body.ja).toMatch(/7\s*月/);
    // 断定的な「無料」誤誘導ではなく、無料の範囲 (通常決済等) を明記している。
    expect(pricing!.body.ja).toMatch(/無料/);
    // 確定モデル (2026-06-13): 決済は店舗が手数料を負担し、お客様は表示額のみ。
    expect(pricing!.body.ja).toMatch(/店舗が負担/);
    expect(pricing!.body.ja).toMatch(/表示額のみ/);
    // チップはガス相当額をお送りになるお客様 (チッパー) が負担し、1% は適用しない。
    expect(pricing!.body.ja).toMatch(/チップ/);
    expect(pricing!.body.ja).toMatch(/1%\s*は適用しません/);
    // 「店舗が選択」式の負担者トグル開示が残っていないこと (撤去済み)。
    expect(pricing!.body.ja).not.toMatch(/店舗が.*選択/);
  });

  // L4: 最新 pricing 本文の数値を lib/legal.ts の DISCLOSED_RECOVER_FEE 定数に結びつける。
  // 定数だけ・本文だけの片側変更で fail する (お知らせが env/法務開示と黙って乖離するのを防ぐ)。
  it('gas-recovery 利用料の本文が定数由来の数値 (約/最低 N JPYC・M%) を ja/en で含む (L4 フェンス)', () => {
    const floorJpyc = DISCLOSED_RECOVER_FEE.floorJpyc; // 2
    const percentFromJuly = DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100; // 1 (%)
    const pricing = NEWS_ITEMS.find((n) => n.id === 'per-tx-fee-2026-06-12');
    expect(pricing).toBeDefined();
    expect(pricing!.body.ja).toContain(`約 ${floorJpyc} JPYC`);
    expect(pricing!.body.ja).toContain(`最低 ${floorJpyc} JPYC`);
    expect(pricing!.body.ja).toContain(`${percentFromJuly}%`);
    // en も同じ数値 (about N JPYC / N JPYC minimum / M%)。
    expect(pricing!.body.en).toContain(`${floorJpyc} JPYC`);
    expect(pricing!.body.en).toContain(`${percentFromJuly}%`);
  });

  // モバイル注文システム利用料のお知らせ (別 SOT = DISCLOSED_MOBILE_ORDER_FEE)。本文が定数由来の
  // 料率 (店頭 N% / 事前 M%) を ja/en で含むことをフェンス (定数だけ・本文だけの片側変更で fail)。
  it('モバイル注文 fee のお知らせが DISCLOSED_MOBILE_ORDER_FEE の料率 (1% / 3%) を ja/en で含む (L4 フェンス)', () => {
    const storefront = DISCLOSED_MOBILE_ORDER_FEE.storefrontBps / 100; // 1 (%)
    const preorder = DISCLOSED_MOBILE_ORDER_FEE.preorderBps / 100; // 3 (%)
    const mo = NEWS_ITEMS.find((n) => n.id === 'mobile-order-fee-2026-06-18');
    expect(mo).toBeDefined();
    expect(mo!.category).toBe('pricing');
    expect(mo!.body.ja).toContain(`${storefront}%`); // 店頭・券売機 1%
    expect(mo!.body.ja).toContain(`${preorder}%`); // 事前モバイルオーダー 3%
    expect(mo!.body.en).toContain(`${storefront}%`);
    expect(mo!.body.en).toContain(`${preorder}%`);
    // 経路非依存 + 非二重課金 (gas-recovery と重複/加算しない) + 対象外 (/pay・チップ・通常リンク) を明記。
    expect(mo!.body.ja).toMatch(/経路を問わず|通常決済/);
    expect(mo!.body.ja).toMatch(/重複|加算され/);
    expect(mo!.body.ja).toMatch(/対象外/);
  });

  // x402 ファシリテーター利用料のお知らせ (別 SOT = DISCLOSED_X402_FEE)。料率 (bps→%) と
  // 下限 (floorJpyc) を定数から導出してフェンスする。下限は 2026-07-05 に 2→1 へ改定済みで、
  // 定数だけ・本文だけの片側変更 (お知らせが古い下限を語り続ける等) で fail させる。
  it('x402 fee のお知らせが DISCLOSED_X402_FEE の料率 (1% / 下限 1 JPYC) を ja/en で含む (L4 フェンス)', () => {
    const percent = DISCLOSED_X402_FEE.bps / 100; // 1 (%)
    const floorJpyc = DISCLOSED_X402_FEE.floorJpyc; // 1
    const revision = NEWS_ITEMS.find((n) => n.id === 'x402-fee-floor-2026-07-05');
    expect(revision).toBeDefined();
    expect(revision!.category).toBe('pricing');
    // 改定後の下限は title / body の両方で現行値と一致する。
    expect(revision!.title.ja).toContain(`${floorJpyc} JPYC`);
    expect(revision!.title.en).toContain(`${floorJpyc} JPYC`);
    expect(revision!.body.ja).toContain(`${floorJpyc} JPYC`);
    expect(revision!.body.en).toContain(`${floorJpyc} JPYC`);
    expect(revision!.body.ja).toContain(`${percent}%`);
    expect(revision!.body.en).toContain(`${percent}%`);
    // 買い手上乗せ方式 (seller は表示額をそのまま受領) の開示が残っている。
    expect(revision!.body.ja).toMatch(/上乗せ/);
    expect(revision!.body.en).toMatch(/buyer/i);

    // 公開告知 (旧下限 2 JPYC 記載) 側も、現行料率と改定後の下限への言及を伴う
    // (旧値だけが残る = AI/読者が古い下限を引用し続ける事故を防ぐ)。
    const launch = NEWS_ITEMS.find(
      (n) => n.id === 'x402-facilitator-launch-2026-06-28',
    );
    expect(launch).toBeDefined();
    expect(launch!.body.ja).toContain(`${percent}%`);
    expect(launch!.body.en).toContain(`${percent}%`);
    expect(launch!.body.ja).toContain(`${floorJpyc} JPYC`);
    expect(launch!.body.en).toContain(`${floorJpyc} JPYC`);
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
