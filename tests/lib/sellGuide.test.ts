// /guide/sell ガイドの content SOT (lib/sellGuide.ts) を実コードで検証する。
//
// ページは async Server Component のため、ここでは全表示テキストの源である SELL_GUIDE と locale / metadata
// 関数を検証する。観点は agentGuide.test.ts と同じく、ja/en 構造 parity、全 leaf の非空、形式不変条件、
// 主要リンク、言語非依存のコード・数値・tx の一致。

import { describe, expect, it } from 'vitest';
import {
  SELL_GUIDE,
  guideSellMetadata,
  sellGuideContentFor,
} from '@/lib/sellGuide';

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

function assertLeavesValid(value: unknown, path: string): void {
  if (typeof value === 'string') {
    expect(value.trim().length, `${path} が空文字`).toBeGreaterThan(0);
  } else if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} が非有限`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertLeavesValid(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assertLeavesValid(v, `${path}.${k}`);
    }
  } else {
    throw new Error(`${path}: 予期しない型 ${typeof value}`);
  }
}

describe('sellGuideContentFor: locale 解決の全分岐', () => {
  it("'ja' は SELL_GUIDE.ja を返す (同一参照)", () => {
    expect(sellGuideContentFor('ja')).toBe(SELL_GUIDE.ja);
  });

  it("'en' は SELL_GUIDE.en を返す (同一参照)", () => {
    expect(sellGuideContentFor('en')).toBe(SELL_GUIDE.en);
  });

  it('未知ロケール・空文字・大文字は ja にフォールバック', () => {
    expect(sellGuideContentFor('fr')).toBe(SELL_GUIDE.ja);
    expect(sellGuideContentFor('')).toBe(SELL_GUIDE.ja);
    expect(sellGuideContentFor('EN')).toBe(SELL_GUIDE.ja);
  });
});

describe('guideSellMetadata: metadata 組立', () => {
  it.each(LOCALES)('%s: title と description を content SOT から組み立てる', (loc) => {
    const c = SELL_GUIDE[loc];
    const metadata = guideSellMetadata(loc);
    expect(metadata).toEqual({
      title: `${c.metaTitle} · OpenPay`,
      description: c.metaDescription,
    });
    expect(Object.keys(metadata).sort()).toEqual(['description', 'title']);
  });

  it('未知ロケールは ja の metadata に一致', () => {
    expect(guideSellMetadata('fr')).toEqual(guideSellMetadata('ja'));
  });
});

describe('SELL_GUIDE: ja/en 構造 parity と非空', () => {
  it('ja と en のトップレベルキーが完全一致', () => {
    expect(Object.keys(SELL_GUIDE.ja).sort()).toEqual(
      Object.keys(SELL_GUIDE.en).sort(),
    );
  });

  it('ja と en の構造 (ネスト・配列長・leaf 型) が完全一致', () => {
    expect(shape(SELL_GUIDE.ja)).toEqual(shape(SELL_GUIDE.en));
  });

  it.each(LOCALES)('%s: 全 string leaf が非空・全 number leaf が有限', (loc) => {
    assertLeavesValid(SELL_GUIDE[loc], loc);
  });

  it.each(LOCALES)('%s: 掲載手順は 1 起点の 4 ステップ', (loc) => {
    expect(SELL_GUIDE[loc].listingSteps).toHaveLength(4);
    SELL_GUIDE[loc].listingSteps.forEach((step, index) => {
      expect(step.n).toBe(index + 1);
    });
  });
});

describe('SELL_GUIDE: 主要リンク', () => {
  const expected = {
    transaction:
      'https://polygonscan.com/tx/0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249',
    article: 'https://note.com/masia02/n/nf891b56872b4',
    gateway: 'https://github.com/cipherwebllc/x402-jpyc-gateway',
    npm: 'https://www.npmjs.com/package/openpay-x402-sdk',
  } as const;

  it.each(LOCALES)('%s: ケーススタディと実装経路の外部リンクが正しい', (loc) => {
    const c = SELL_GUIDE[loc];
    expect(c.proofTransaction.href).toBe(expected.transaction);
    expect(c.proofArticle.href).toBe(expected.article);
    expect(c.noCodeLink.href).toBe(expected.gateway);
    expect(c.sdkPackage.href).toBe(expected.npm);
  });

  it.each(LOCALES)('%s: discovery と買い手ガイドの内部リンクが正しい', (loc) => {
    const c = SELL_GUIDE[loc];
    expect(c.snippetLink.href).toBe('/discovery');
    expect(c.registrationLink.href).toBe('/discovery');
    expect(c.ctaButtonHref).toBe('/discovery');
    expect(c.buyerGuideLink.href).toBe('/guide/ai-pay');
  });

  it('ja/en で tx・URL がすべて同一', () => {
    expect(SELL_GUIDE.en.proofTransaction.href).toBe(
      SELL_GUIDE.ja.proofTransaction.href,
    );
    expect(SELL_GUIDE.en.proofTransaction.label).toBe(
      SELL_GUIDE.ja.proofTransaction.label,
    );
    expect(SELL_GUIDE.en.proofArticle.href).toBe(SELL_GUIDE.ja.proofArticle.href);
    expect(SELL_GUIDE.en.noCodeLink.href).toBe(SELL_GUIDE.ja.noCodeLink.href);
    expect(SELL_GUIDE.en.sdkPackage.href).toBe(SELL_GUIDE.ja.sdkPackage.href);
  });
});

describe('SELL_GUIDE: SDK コードと x402 開示', () => {
  it('ja/en の env・install・SDK コードは同一', () => {
    expect(SELL_GUIDE.en.noCodeEnv).toBe(SELL_GUIDE.ja.noCodeEnv);
    expect(SELL_GUIDE.en.sdkInstall).toBe(SELL_GUIDE.ja.sdkInstall);
    expect(SELL_GUIDE.en.sdkOneShotCode).toBe(SELL_GUIDE.ja.sdkOneShotCode);
    expect(SELL_GUIDE.en.sdkSplitCode).toBe(SELL_GUIDE.ja.sdkSplitCode);
  });

  it.each(LOCALES)('%s: handle と verify→settle の両経路を掲載', (loc) => {
    const c = SELL_GUIDE[loc];
    expect(c.sdkOneShotCode).toContain('gate.handle(request)');
    expect(c.sdkSplitCode).toContain('gate.verify(request)');
    expect(c.sdkSplitCode).toContain('payment.settle()');
    expect(c.sdkSplitCode.indexOf('callUpstream()')).toBeLessThan(
      c.sdkSplitCode.indexOf('payment.settle()'),
    );
  });

  it('ja: 既存開示と同じ料率・最低額・支払う側上乗せを明記', () => {
    expect(SELL_GUIDE.ja.subtitle).toContain(
      '利用料は決済額の 1%（最低 1 JPYC）・支払う側の上乗せです。',
    );
  });

  it('en: 1%・minimum 1 JPYC・payer-side addition を明記', () => {
    expect(SELL_GUIDE.en.subtitle).toContain('1%');
    expect(SELL_GUIDE.en.subtitle).toContain('minimum 1 JPYC');
    expect(SELL_GUIDE.en.subtitle).toContain("payer's side");
  });
});
