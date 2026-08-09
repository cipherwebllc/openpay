// /guide/start 「導入前チェックリスト」の content SOT (lib/startGuide.ts) を実コードで検証する。
//
// 観点: (1) ja/en の構造 parity + 全 leaf 非空 (2) 数値の直書き禁止 — 利用料とチェーン一覧は
// page が messages (掟 14 フェンス済み) から描画するので content 側に現れてはいけない
// (3) **開示した保存期間が実装値と一致する** (72h / 200 件 / 180 日)。実装を変えたら本文も
// 変えないと落ちる = ドリフト検出フェンス。

import { describe, it, expect } from 'vitest';
import { startGuideContentFor, startGuideMetadata } from '@/lib/startGuide';
import { ORDER_LIST_MAX, ORDER_LIST_TTL_SEC } from '@/lib/orderRelay';
import { TIP_MESSAGE_TTL_SEC } from '@/lib/tipMessages';

const LOCALES = ['ja', 'en'] as const;

function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { __array: value.length ? shape(value[0]) : 'empty', len: value.length };
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

function leaves(value: unknown, path: string, sink: [string, string][]): void {
  if (typeof value === 'string') {
    sink.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, sink));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, sink);
  }
}

describe('startGuide content', () => {
  it('未知ロケールは ja へ・en だけが英語版', () => {
    expect(startGuideContentFor('ja')).toBe(startGuideContentFor('xx'));
    expect(startGuideContentFor('en')).not.toBe(startGuideContentFor('ja'));
  });

  it('ja / en が同一構造で、全 leaf が非空', () => {
    const ja = startGuideContentFor('ja');
    const en = startGuideContentFor('en');
    expect(shape(en)).toEqual(shape(ja));
    for (const locale of LOCALES) {
      const sink: [string, string][] = [];
      leaves(startGuideContentFor(locale), locale, sink);
      for (const [path, text] of sink) {
        expect(text.trim().length, `${path} が空`).toBeGreaterThan(0);
      }
    }
  });

  it('8 項目・チェックリスト 5 件・番号は 1..8 連番', () => {
    for (const locale of LOCALES) {
      const c = startGuideContentFor(locale);
      expect(c.checklistItems).toHaveLength(5);
      expect(c.sections.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('利用料の slot は fee 1 つ・チェーンの slot は chains 1 つ (messages から描画)', () => {
    for (const locale of LOCALES) {
      const slots = startGuideContentFor(locale)
        .sections.map((s) => s.slot)
        .filter(Boolean);
      expect(slots.sort()).toEqual(['chains', 'fee']);
    }
  });

  it('利用料の数値とチェーン名を content に直書きしない (掟 14 の単一情報源を割らない)', () => {
    // 例外: 「1 JPYC = 1 円」(ペッグの言い切り・料率ではない) と、最低額の効きを説明する
    // tip callout は意図的に数値を持つ。それ以外に料率・チェーン名が現れたら誤り。
    const FORBIDDEN = /Polygon|Kaia|Avalanche|Ethereum|Base|Arbitrum|Optimism|USDC/;
    for (const locale of LOCALES) {
      const sink: [string, string][] = [];
      leaves(startGuideContentFor(locale), locale, sink);
      for (const [path, text] of sink) {
        expect(FORBIDDEN.test(text), `${path} にチェーン名/通貨名の直書き: ${text}`).toBe(
          false,
        );
      }
    }
  });

  it('開示した保存期間が実装値と一致する (ドリフト検出)', () => {
    expect(ORDER_LIST_TTL_SEC).toBe(72 * 60 * 60);
    expect(ORDER_LIST_MAX).toBe(200);
    expect(TIP_MESSAGE_TTL_SEC).toBe(180 * 24 * 60 * 60);

    const ja = startGuideContentFor('ja');
    const dataSection = ja.sections.find((s) => s.n === 8);
    const text = (dataSection?.defs ?? []).map((d) => d.desc).join('\n');
    expect(text).toContain(`${ORDER_LIST_TTL_SEC / 3600} 時間`);
    expect(text).toContain(`${ORDER_LIST_MAX} 件`);
    expect(text).toContain(`${TIP_MESSAGE_TTL_SEC / 86400} 日`);

    const en = startGuideContentFor('en');
    const enText = (en.sections.find((s) => s.n === 8)?.defs ?? [])
      .map((d) => d.desc)
      .join('\n');
    expect(enText).toContain(`${ORDER_LIST_TTL_SEC / 3600} hours`);
    expect(enText).toContain(`${ORDER_LIST_MAX} entries`);
    expect(enText).toContain(`${TIP_MESSAGE_TTL_SEC / 86400} days`);
  });

  it('metadata は canonical / hreflang / OG 画像を持つ', () => {
    for (const locale of LOCALES) {
      const m = startGuideMetadata(locale);
      expect(m.alternates?.canonical).toContain('/guide/start');
      expect(m.alternates?.languages).toBeDefined();
      expect(m.openGraph?.images).toBeDefined();
    }
  });
});
