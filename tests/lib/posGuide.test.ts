// /guide/pos ガイドの content SOT (lib/posGuide.ts) を実コードで網羅検証する。
//
// ページ (app/[locale]/guide/pos/page.tsx) は async Server Component で next-intl
// server / AppShell に依存するため、真の依存をモックせずに描画する単体テストは不適。
// 代わりに「描画される全テキストの源」である POS_GUIDE / guideContentFor と、参照する
// 実 SVG ファイル (public/guide) を**実走**で検証する (FS は実依存・データは実値を inspect)。
//
// 観点: (1) 関数の全分岐 (2) ja/en 構造 parity + 全 leaf 非空 (3) 形式不変条件
// (4) 図版ファイルの実在/整合 (リンク切れ防止) (5) これまでの修正の回帰フェンス
// (Web3 不使用 / 料金ページ参照撤去 / 手数料の時期・純着金・カード約3% / 完了画面=顧客側)。

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POS_GUIDE, guideContentFor, guidePosMetadata } from '@/lib/posGuide';

const GUIDE_DIR = join(process.cwd(), 'public', 'guide');
const LOCALES = ['ja', 'en'] as const;

// ── 再帰ユーティリティ ─────────────────────────────────────────────
// 構造 (キー集合・ネスト・配列長・leaf 型) を抽出。leaf 値そのものは無視するので
// ja/en の「翻訳差」は許容しつつ「形」のズレ (キー欠落/配列長違い) だけを検出する。
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
  return typeof value; // 'string' | 'number'
}

// 全 leaf を辿り、string は非空・number は有限・それ以外の型は異常として検出。
function assertLeavesValid(value: unknown, path: string): void {
  if (typeof value === 'string') {
    expect(value.trim().length, `${path} が空文字`).toBeGreaterThan(0);
  } else if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} が非有限`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertLeavesValid(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertLeavesValid(v, `${path}.${k}`);
  } else {
    throw new Error(`${path}: 予期しない型 ${typeof value}`);
  }
}

// GuideImage ({file, alt}) を再帰的に収集 (将来フィールド追加にも追従)。
function collectImageFiles(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((v) => collectImageFiles(v, acc));
    return;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.file === 'string' && typeof o.alt === 'string') acc.add(o.file);
    for (const v of Object.values(o)) collectImageFiles(v, acc);
  }
}

function referencedFiles(): Set<string> {
  const acc = new Set<string>();
  for (const loc of LOCALES) collectImageFiles(POS_GUIDE[loc], acc);
  return acc;
}

// ── (1) guideContentFor: 全分岐 ───────────────────────────────────
describe('guideContentFor: locale 解決の全分岐', () => {
  it("'ja' は POS_GUIDE.ja を返す (同一参照)", () => {
    expect(guideContentFor('ja')).toBe(POS_GUIDE.ja);
  });
  it("'en' は POS_GUIDE.en を返す (同一参照)", () => {
    expect(guideContentFor('en')).toBe(POS_GUIDE.en);
  });
  it('未知ロケールは ja にフォールバック', () => {
    expect(guideContentFor('fr')).toBe(POS_GUIDE.ja);
    expect(guideContentFor('ja-JP')).toBe(POS_GUIDE.ja);
  });
  it('空文字は ja にフォールバック', () => {
    expect(guideContentFor('')).toBe(POS_GUIDE.ja);
  });
  it("大小区別: 'EN' は en ではなく ja (Next の locale は小文字 'en' のみ)", () => {
    expect(guideContentFor('EN')).toBe(POS_GUIDE.ja);
  });
});

// ── guidePosMetadata: <title>/<description> 組立 (page の generateMetadata が利用) ──
describe('guidePosMetadata: メタデータ組立', () => {
  it.each(LOCALES)('%s: title=metaTitle+" · OpenPay" / description=metaDescription', (loc) => {
    const c = POS_GUIDE[loc];
    const m = guidePosMetadata(loc);
    expect(m.title).toBe(`${c.metaTitle} · OpenPay`);
    expect(m.description).toBe(c.metaDescription);
    expect(m.title).toContain('OpenPay');
  });

  it('未知ロケールは ja の metadata に一致', () => {
    expect(guidePosMetadata('fr')).toEqual(guidePosMetadata('ja'));
  });
});

// ── (2) ja/en parity + 全 leaf 非空 ───────────────────────────────
describe('POS_GUIDE: ja/en 構造 parity と非空', () => {
  it('ja と en のトップレベルキーが完全一致', () => {
    expect(Object.keys(POS_GUIDE.ja).sort()).toEqual(
      Object.keys(POS_GUIDE.en).sort(),
    );
  });

  it('ja と en の構造 (ネスト・配列長・leaf 型) が完全一致', () => {
    // 翻訳差は無視し「形」のみ比較。steps/faqs/costRows/bullets の件数ズレもここで検出。
    expect(shape(POS_GUIDE.ja)).toEqual(shape(POS_GUIDE.en));
  });

  it.each(LOCALES)('%s: 全 string leaf が非空・全 number leaf が有限', (loc) => {
    assertLeavesValid(POS_GUIDE[loc], loc);
  });

  it.each(LOCALES)('%s: 主要配列が非空 (空セクション描画を防ぐ)', (loc) => {
    const c = POS_GUIDE[loc];
    expect(c.canDo.length).toBeGreaterThan(0);
    expect(c.cannot.length).toBeGreaterThan(0);
    expect(c.need.length).toBeGreaterThan(0);
    expect(c.setupSteps.length).toBeGreaterThan(0);
    expect(c.flowSteps.length).toBeGreaterThan(0);
    expect(c.reconcileBullets.length).toBeGreaterThan(0);
    expect(c.posExamples.length).toBeGreaterThan(0);
    expect(c.costRows.length).toBeGreaterThan(0);
    expect(c.faqs.length).toBeGreaterThan(0);
  });
});

// ── (3) 形式不変条件 ──────────────────────────────────────────────
describe('POS_GUIDE: 形式不変条件 (描画前提)', () => {
  it.each(LOCALES)('%s: ctaButtonHref は "/" 始まり (page が /${locale}+href を生成)', (loc) => {
    expect(POS_GUIDE[loc].ctaButtonHref.startsWith('/')).toBe(true);
  });

  it('参照する図版 file はすべて .svg', () => {
    for (const f of referencedFiles()) expect(f).toMatch(/\.svg$/);
  });

  it.each(LOCALES)('%s: setupSteps / flowSteps の n は 1 起点の連番', (loc) => {
    for (const steps of [POS_GUIDE[loc].setupSteps, POS_GUIDE[loc].flowSteps]) {
      steps.forEach((s, i) => expect(s.n).toBe(i + 1));
    }
  });

  it.each(LOCALES)('%s: faqs の q/a・costRows の label/card/openpay が非空', (loc) => {
    const c = POS_GUIDE[loc];
    for (const f of c.faqs) {
      expect(f.q.trim().length).toBeGreaterThan(0);
      expect(f.a.trim().length).toBeGreaterThan(0);
    }
    for (const r of c.costRows) {
      expect(r.label.trim().length).toBeGreaterThan(0);
      expect(r.card.trim().length).toBeGreaterThan(0);
      expect(r.openpay.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── (4) 図版ファイルの実在/整合 (実 FS) ───────────────────────────
describe('public/guide: 図版ファイルの実在と整合 (リンク切れ防止)', () => {
  const filesOnDisk = new Set(
    readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.svg')),
  );
  const referenced = referencedFiles();

  it('参照される全図版が public/guide に実在する', () => {
    for (const f of referenced) {
      expect(filesOnDisk.has(f), `${f} が public/guide に無い`).toBe(true);
    }
  });

  it('public/guide に未参照の孤児 SVG が無い', () => {
    for (const f of filesOnDisk) {
      expect(referenced.has(f), `${f} はどこからも参照されていない`).toBe(true);
    }
  });

  it('7 枚の想定図版がすべて存在する', () => {
    const expected = [
      'hero.svg',
      'overview-flow.svg',
      'pos-add-method.svg',
      'four-steps.svg',
      'payment-success.svg',
      'history-reconcile.svg',
      'cost-compare.svg',
    ];
    for (const f of expected) expect(filesOnDisk.has(f)).toBe(true);
    expect(filesOnDisk.size).toBe(expected.length);
  });

  it('各 SVG が実 XML としてパース可能 (DOMParser・parsererror 無し・root=svg・viewBox 有)', () => {
    // トークン有無でなく実パース。壊れた XML (タグ不整合等) は parsererror か
    // root 要素の不一致で検出する (jsdom の DOMParser を使用)。
    const parser = new DOMParser();
    for (const f of referenced) {
      const svg = readFileSync(join(GUIDE_DIR, f), 'utf8');
      expect(svg.length, `${f} が空`).toBeGreaterThan(0);
      const doc = parser.parseFromString(svg, 'image/svg+xml');
      const err = doc.querySelector('parsererror');
      expect(err, `${f} が XML として不正: ${err?.textContent ?? ''}`).toBeNull();
      expect(doc.documentElement.tagName.toLowerCase(), `${f} の root が svg でない`).toBe('svg');
      expect(
        doc.documentElement.getAttribute('viewBox'),
        `${f} に viewBox が無い`,
      ).toBeTruthy();
    }
  });
});

// ── (5) 回帰フェンス: これまでの修正を固定 ────────────────────────
describe('POS_GUIDE: 文言フェンス (回帰防止)', () => {
  const jaJson = JSON.stringify(POS_GUIDE.ja);
  const enJson = JSON.stringify(POS_GUIDE.en);

  it('「Web3」を含まない (店主の心理障壁回避・両 locale)', () => {
    expect(jaJson).not.toMatch(/Web3/i);
    expect(enJson).not.toMatch(/Web3/i);
  });

  it('存在しない「料金ページ / pricing page」を参照しない', () => {
    expect(jaJson).not.toContain('料金ページ');
    expect(enJson).not.toMatch(/pricing page/i);
  });

  it('feeNote が手数料の額・割合を開示と整合して述べる (present-tense: 決済額の 1%・最低 2 JPYC)', () => {
    // 2026 年 7 月で 1% が発効済みのため、feeNote は経過措置 (「2026 年 7 月のご利用分から」) を
    // 撤去し現在形で料率を述べる。額 (2 JPYC) / 率 (1%) / 純着金 (差し引) は引き続き固定する。
    const ja = POS_GUIDE.ja.feeNote;
    expect(ja).toContain('2 JPYC'); // 最低額
    expect(ja).toContain('1%'); // 料率
    expect(ja).toContain('差し引'); // 純着金 (差し引かれる)
    const en = POS_GUIDE.en.feeNote;
    expect(en).toContain('2 JPYC');
    expect(en).toContain('1%');
    expect(en).toMatch(/deducted/i);
  });

  it('純着金の具体例 (¥1,200 → 約¥1,188) を含む', () => {
    expect(POS_GUIDE.ja.feeNote).toContain('1,188');
    expect(POS_GUIDE.en.feeNote).toContain('1,188');
  });

  it('コスト表: カードは公式値「約3%」・OpenPay は「1%」を述べる', () => {
    for (const loc of LOCALES) {
      const fee = POS_GUIDE[loc].costRows.find((r) =>
        /決済手数料|Payment fee/.test(r.label),
      );
      expect(fee, `${loc}: 決済手数料 行が無い`).toBeDefined();
      expect(fee!.card).toContain('3%');
      expect(fee!.openpay).toContain('1%');
    }
  });

  it('完了画像は顧客側の画面であることをキャプションで明示', () => {
    expect(POS_GUIDE.ja.successCaption).toContain('お客様');
    expect(POS_GUIDE.ja.successCaption).toContain('着金を確認しました');
    expect(POS_GUIDE.en.successCaption).toMatch(/customer/i);
    expect(POS_GUIDE.en.successCaption).toMatch(/Payment received/i);
  });

  it('安全注記は「着金を確認する前に渡さない」(完了表示頼みにしない)', () => {
    expect(POS_GUIDE.ja.safetyNote).toContain('着金を確認する前');
    expect(POS_GUIDE.en.safetyNote).toMatch(/before confirming receipt/i);
  });
});

// ── (5b) 完了画像 SVG の文言フェンス (顧客側・旧文言の混入防止) ────
describe('payment-success.svg: 顧客側の文言になっている', () => {
  const svg = readFileSync(join(GUIDE_DIR, 'payment-success.svg'), 'utf8');

  it('「支払い完了」を含む', () => {
    expect(svg).toContain('支払い完了');
  });
  it('店舗/受領目線の旧文言 (受け取りました / 着金済み) を含まない', () => {
    expect(svg).not.toContain('受け取りました');
    expect(svg).not.toContain('着金済み');
  });
});
