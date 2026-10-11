// ガイドの目次・/guide ハブの content SOT (lib/guideNav.ts) のフェンス:
// ja/en 構造 parity・全 leaf 非空・並び順・ガイドのディレクトリ/差し込み/sitemap とのドリフト・
// 料率/ガス/チェーン名/通貨名の混入禁止 (掟 14)・LP の入口と同文であること・metadata。

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import sitemap from '@/app/sitemap';
import { GUIDE_SLUGS, guideHubMetadata, guideNavFor } from '@/lib/guideNav';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const LOCALES = ['ja', 'en'] as const;
const GUIDE_DIR = path.join(process.cwd(), 'app', '[locale]', 'guide');

function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shape);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = shape((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return typeof value;
}

function leaves(value: unknown, at: string, sink: [string, string][]): void {
  if (typeof value === 'string') {
    sink.push([at, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${at}[${i}]`, sink));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${at}.${k}`, sink);
  }
}

// slug・group id は文言ではないので除く (/guide/ai-pay の "ai" 等)。
function copyLeaves(locale: string): [string, string][] {
  const sink: [string, string][] = [];
  leaves(guideNavFor(locale), locale, sink);
  return sink.filter(([at]) => !/\.(slug|id)$/.test(at));
}

describe('guideNav content', () => {
  it('未知ロケールは ja へ・en は別内容', () => {
    expect(guideNavFor('xx')).toBe(guideNavFor('ja'));
    expect(guideNavFor('en')).not.toBe(guideNavFor('ja'));
  });

  it('ja / en が同一構造 (グループ・並び・slug まで一致) で全 leaf 非空', () => {
    expect(shape(guideNavFor('en'))).toEqual(shape(guideNavFor('ja')));
    const order = (locale: string) =>
      guideNavFor(locale).groups.map((g) => [g.id, g.items.map((i) => i.slug)]);
    expect(order('en')).toEqual(order('ja'));
    for (const locale of LOCALES) {
      for (const [at, text] of copyLeaves(locale)) {
        expect(text.trim().length, `${at} が空`).toBeGreaterThan(0);
      }
    }
  });

  it('5 グループ・10 項目を計画どおりの順に並べ、全 slug をちょうど 1 回ずつ含む', () => {
    const nav = guideNavFor('ja');
    expect(nav.groups.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([
      ['お店向け', ['導入前チェックリスト', '決済QR', 'レジ・モバイルオーダー', '今お使いの POS レジと併用']],
      ['お客様向け', ['モバイルオーダーのやり方', 'AI に頼んで注文（訪日客向け）']],
      ['クリエイター向け', ['チップ・デジタル商品販売']],
      ['AI・開発者向け', ['AI が支払う', 'API を売る']],
      ['補足', ['画像 URL の用意のしかた']],
    ]);
    expect(guideNavFor('en').groups.map((g) => g.title)).toEqual([
      'For shops',
      'For customers',
      'For creators',
      'For AI & developers',
      'More',
    ]);
    const slugs = nav.groups.flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs).toEqual([...GUIDE_SLUGS]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('qr / shop の説明は LP の入口 (Landing.entryQrBody / entryShopBody) と同文', () => {
    for (const [locale, messages] of [['ja', ja], ['en', en]] as const) {
      const { items } = guideNavFor(locale);
      expect(items.qr.summary).toBe(messages.Landing.entryQrBody);
      expect(items.shop.summary).toBe(messages.Landing.entryShopBody);
    }
  });

  it('料率・無料・ガス・チェーン名・通貨名を含まない (掟 14 の同期面を増やさない)', () => {
    // \bBase\b / \bfees?\b は database・codebase・feedback に誤検出しないため (計画レビュー R2-5)。
    const FORBIDDEN =
      /[0-9]+\s*(%|JPYC|円|時間|日間)|無料|手数料|利用料|ガス|\bgas\b|\bfree\b|\bfees?\b|USDC|Polygon|Kaia|Avalanche|\bBase\b|Ethereum|Arbitrum|Optimism|\bArc\b|World\s?Chain|Sonic|\bSei\b|Unichain|HyperEVM|Hyperliquid/i;
    for (const locale of LOCALES) {
      for (const [at, text] of copyLeaves(locale)) {
        expect(FORBIDDEN.test(text), `${at} に可変情報: ${text}`).toBe(false);
      }
    }
    // 正規表現そのものの誤検出がないこと (R2-5 で実際に起きた型)。
    for (const ok of ['database', 'codebase', 'feedback', 'freedom']) {
      expect(FORBIDDEN.test(ok), ok).toBe(false);
    }
  });

  it('GUIDE_SLUGS と app/[locale]/guide/*/page.tsx のディレクトリが 1:1 (ガイドを足して目次に載せ忘れない)', () => {
    const dirs = readdirSync(GUIDE_DIR).filter((name) =>
      statSync(path.join(GUIDE_DIR, name)).isDirectory(),
    );
    expect(dirs.sort()).toEqual([...GUIDE_SLUGS].sort());
  });

  it.each(GUIDE_SLUGS)('/guide/%s の page.tsx は GuideFrame に自分の slug を渡す (現在地を取り違えない)', (slug) => {
    const source = readFileSync(path.join(GUIDE_DIR, slug, 'page.tsx'), 'utf8');
    expect(source).toContain('<GuideFrame');
    expect(source.match(/current="([^"]+)"/g)).toEqual([`current="${slug}"`]);
  });

  it('sitemap に /guide と全ガイドが ja / en で載る', () => {
    const urls = new Set(sitemap().map((entry) => entry.url));
    for (const locale of LOCALES) {
      expect(urls.has(`https://open-pay.jp/${locale}/guide`)).toBe(true);
      for (const slug of GUIDE_SLUGS) {
        expect(urls.has(`https://open-pay.jp/${locale}/guide/${slug}`), `${locale}/${slug}`).toBe(true);
      }
    }
  });

  it('guideHubMetadata: canonical /{locale}/guide・hreflang ja/en・未知ロケールは ja', () => {
    for (const locale of LOCALES) {
      const m = guideHubMetadata(locale);
      const nav = guideNavFor(locale);
      expect(m.title).toBe(nav.metaTitle);
      expect(m.description).toBe(nav.metaDescription);
      expect(m.alternates?.canonical).toBe(`/${locale}/guide`);
      expect(m.alternates?.languages).toEqual({ ja: '/ja/guide', en: '/en/guide' });
      expect(m.openGraph?.images).toBeDefined();
    }
    expect(guideHubMetadata('fr').alternates?.canonical).toBe('/ja/guide');
    expect(guideHubMetadata('fr').title).toBe(guideNavFor('ja').metaTitle);
  });

  it('<title> に OpenPay を 2 回出さない', () => {
    for (const locale of LOCALES) {
      expect(guideNavFor(locale).metaTitle.match(/OpenPay/g)).toHaveLength(1);
    }
  });
});
