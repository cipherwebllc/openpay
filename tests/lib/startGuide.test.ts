// /guide/start 「導入前チェックリスト」の content SOT (lib/startGuide.ts) を実コードで検証する。
//
// 観点: (1) ja/en の構造 parity + 全 leaf 非空 (2) 数値の直書き禁止 — 利用料とチェーン一覧は
// page が messages (掟 14 フェンス済み) から描画するので content 側に現れてはいけない
// (3) **開示した保存期間が実装値と一致する** (72h / 200 件 / 180 日)。実装を変えたら本文も
// 変えないと落ちる = ドリフト検出フェンス。

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('metadata は canonical / hreflang / 専用 OG 画像を持ち、実ファイルが存在する', () => {
    for (const locale of LOCALES) {
      const m = startGuideMetadata(locale);
      expect(m.alternates?.canonical).toContain('/guide/start');
      expect(m.alternates?.languages).toBeDefined();
      const images = m.openGraph?.images;
      // 既定の og-image.png (/guide/qr と共用) ではなく専用画像であること。
      expect(JSON.stringify(images)).toContain('/og-start.webp');
    }
    expect(existsSync(join(process.cwd(), 'public', 'og-start.webp'))).toBe(true);
  });

  // OG 画像は本文と別に手で作るため、文言変更時に取り残されやすい (実際 2026-08-09 に
  // 「テスト返金」がページだけ直り OG に残った)。チップは checklist 項目の短縮形なので、
  // 「共通する連続 3 文字以上が元項目に存在する」を対応の証拠として要求する。
  it('OG 画像のチップが checklist 項目と対応している (ドリフト検出)', () => {
    const svg = readFileSync(join(process.cwd(), 'assets', 'og', 'og-start.svg'), 'utf8');
    const chips = [...svg.matchAll(/<text[^>]*font-size="25"[^>]*>([^<]+)<\/text>/g)].map(
      (m) => m[1],
    );
    const items = startGuideContentFor('ja').checklistItems;
    expect(chips).toHaveLength(items.length);

    const sharesRun = (chip: string, item: string): boolean => {
      for (let i = 0; i + 3 <= chip.length; i += 1) {
        if (item.includes(chip.slice(i, i + 3))) return true;
      }
      return false;
    };
    // ⚠️ 「どれかの項目と一致」では弱い — 旧「テスト返金」は別項目の「テスト決済」に
    // 誤マッチして検出をすり抜けた。チップは項目と同順なので位置対応を要求する。
    chips.forEach((chip, i) => {
      expect(
        sharesRun(chip, items[i]),
        `OG のチップ ${i + 1} 「${chip}」が checklist 項目「${items[i]}」と対応していない (文言変更時は assets/og/og-start.svg を直して public/og-start.webp を再生成する)`,
      ).toBe(true);
    });
  });

  it('本文中の図版ファイルが実在する (リンク切れ防止)', () => {
    for (const locale of LOCALES) {
      for (const s of startGuideContentFor(locale).sections) {
        if (!s.figure) continue;
        const path = join(process.cwd(), 'public', 'guide', s.figure.file);
        expect(existsSync(path), `${s.figure.file} が無い`).toBe(true);
        expect(s.figure.alt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('外部リンクは https で、JPYC 公式と運用ガイドを案内する', () => {
    for (const locale of LOCALES) {
      const links = startGuideContentFor(locale).sections.flatMap(
        (s) => s.externalLinks ?? [],
      );
      expect(links.length).toBeGreaterThanOrEqual(2);
      for (const l of links) expect(l.href).toMatch(/^https:\/\//);
      const hrefs = links.map((l) => l.href);
      expect(hrefs).toContain('https://jpyc.co.jp/');
      expect(hrefs).toContain('https://note.com/masia02/n/ned04a4cdb00a');
    }
  });
});
