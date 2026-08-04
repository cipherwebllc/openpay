// /guide/ai-pay ガイドの content SOT (lib/aiPayGuide.ts) を実コードで検証する。
//
// sellGuide.test.ts と同じく、locale / metadata 関数、ja/en 構造 parity、全 leaf の非空、
// 主要リンク、言語非依存の設定・tx、既存 agent guide から再利用する JPYC 文言を検証する。

import { describe, expect, it } from 'vitest';
import {
  AI_PAY_GUIDE,
  aiPayGuideContentFor,
  guideAiPayMetadata,
} from '@/lib/aiPayGuide';
import { AGENT_GUIDE } from '@/lib/agentGuide';

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

describe('aiPayGuideContentFor: locale 解決の全分岐', () => {
  it("'ja' は AI_PAY_GUIDE.ja を返す (同一参照)", () => {
    expect(aiPayGuideContentFor('ja')).toBe(AI_PAY_GUIDE.ja);
  });

  it("'en' は AI_PAY_GUIDE.en を返す (同一参照)", () => {
    expect(aiPayGuideContentFor('en')).toBe(AI_PAY_GUIDE.en);
  });

  it('未知ロケール・空文字・大文字は ja にフォールバック', () => {
    expect(aiPayGuideContentFor('fr')).toBe(AI_PAY_GUIDE.ja);
    expect(aiPayGuideContentFor('')).toBe(AI_PAY_GUIDE.ja);
    expect(aiPayGuideContentFor('EN')).toBe(AI_PAY_GUIDE.ja);
  });
});

describe('guideAiPayMetadata: metadata 組立', () => {
  it.each(LOCALES)('%s: title と description を content SOT から組み立てる', (loc) => {
    const c = AI_PAY_GUIDE[loc];
    const metadata = guideAiPayMetadata(loc);
    expect(metadata.title).toBe(`${c.metaTitle} · OpenPay`);
    expect(metadata.description).toBe(c.metaDescription);
    // P5: OG/Twitter/canonical/hreflang は guide 共通ビルダー (lib/guideMetadata.ts) が付与
    expect(metadata.alternates?.canonical).toBe(`/${loc}/guide/ai-pay`);
    expect(metadata.openGraph?.images).toEqual([
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: `${c.metaTitle} · OpenPay`,
      },
    ]);
    expect(JSON.stringify(metadata.twitter)).toContain('summary_large_image');
  });

  it('未知ロケールは ja の metadata に一致', () => {
    expect(guideAiPayMetadata('fr')).toEqual(guideAiPayMetadata('ja'));
  });
});

describe('AI_PAY_GUIDE: ja/en 構造 parity と非空', () => {
  it('ja と en のトップレベルキーが完全一致', () => {
    expect(Object.keys(AI_PAY_GUIDE.ja).sort()).toEqual(
      Object.keys(AI_PAY_GUIDE.en).sort(),
    );
  });

  it('ja と en の構造 (ネスト・配列長・leaf 型) が完全一致', () => {
    expect(shape(AI_PAY_GUIDE.ja)).toEqual(shape(AI_PAY_GUIDE.en));
  });

  it.each(LOCALES)('%s: 全 string leaf が非空・全 number leaf が有限', (loc) => {
    assertLeavesValid(AI_PAY_GUIDE[loc], loc);
  });

  it.each(LOCALES)('%s: 仕組みと JPYC 入手は 1 起点の連番', (loc) => {
    for (const steps of [
      AI_PAY_GUIDE[loc].mechanismSteps,
      AI_PAY_GUIDE[loc].jpycSteps,
    ]) {
      steps.forEach((step, index) => expect(step.n).toBe(index + 1));
    }
  });
});

describe('AI_PAY_GUIDE: 主要リンク', () => {
  const expected = {
    transaction:
      'https://polygonscan.com/tx/0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249',
    steward: 'https://github.com/Steward-Fi/steward',
    mcp: 'https://www.npmjs.com/package/openpay-x402-mcp',
    sdk: 'https://www.npmjs.com/package/openpay-x402-sdk',
  } as const;

  it.each(LOCALES)('%s: 実例・Steward・MCP・SDK の外部リンクが正しい', (loc) => {
    const c = AI_PAY_GUIDE[loc];
    expect(c.proofTransaction.href).toBe(expected.transaction);
    expect(c.stewardProject.href).toBe(expected.steward);
    expect(c.stewardSetup.href).toBe(expected.mcp);
    expect(c.sdkLink.href).toBe(expected.sdk);
  });

  it.each(LOCALES)('%s: discovery と売り手ガイドの内部リンクが正しい', (loc) => {
    const c = AI_PAY_GUIDE[loc];
    expect(c.ctaButtonHref).toBe('/discovery');
    expect(c.sellerLink.href).toBe('/guide/sell');
  });

  it('ja/en で tx・URL がすべて同一', () => {
    expect(AI_PAY_GUIDE.en.proofTransaction).toEqual(
      AI_PAY_GUIDE.ja.proofTransaction,
    );
    expect(AI_PAY_GUIDE.en.stewardProject.href).toBe(
      AI_PAY_GUIDE.ja.stewardProject.href,
    );
    expect(AI_PAY_GUIDE.en.stewardSetup.href).toBe(
      AI_PAY_GUIDE.ja.stewardSetup.href,
    );
    expect(AI_PAY_GUIDE.en.sdkLink.href).toBe(AI_PAY_GUIDE.ja.sdkLink.href);
  });
});

describe('AI_PAY_GUIDE: MCP 設定と金銭ガード', () => {
  it('ja/en の MCP・Steward 設定は同一', () => {
    expect(AI_PAY_GUIDE.en.quickSetupConfig).toBe(
      AI_PAY_GUIDE.ja.quickSetupConfig,
    );
    expect(AI_PAY_GUIDE.en.stewardEnv).toBe(AI_PAY_GUIDE.ja.stewardEnv);
  });

  it('Claude Desktop 設定は README と同じ env を持つ妥当な JSON', () => {
    const parsed = JSON.parse(AI_PAY_GUIDE.ja.quickSetupConfig);
    expect(parsed.mcpServers['openpay-x402']).toEqual({
      command: 'npx',
      args: ['openpay-x402-mcp'],
      env: {
        SIGNER_MODE: 'env-key',
        BUYER_PRIVATE_KEY: '0x...',
        MAX_PER_CALL_JPYC: '10',
        MAX_SESSION_JPYC: '100',
        ALLOWED_HOSTS: 'open-pay.jp',
      },
    });
  });

  it('Steward 設定は signer mode と 7 変数を含む', () => {
    const lines = AI_PAY_GUIDE.ja.stewardEnv.split('\n');
    expect(lines[0]).toBe('SIGNER_MODE=steward');
    expect(lines.filter((line) => line.startsWith('STEWARD_'))).toHaveLength(7);
  });

  it('ja: 既存開示と同じ料率・最低額・支払う側上乗せを明記', () => {
    expect(AI_PAY_GUIDE.ja.mechanismSteps[1].body).toContain(
      '利用料は決済額の 1%（最低 1 JPYC）・支払う側の上乗せです。',
    );
  });

  it('en: 1%・minimum 1 JPYC・payer-side addition を明記', () => {
    const quote = AI_PAY_GUIDE.en.mechanismSteps[1].body;
    expect(quote).toContain('1%');
    expect(quote).toContain('minimum 1 JPYC');
    expect(quote).toContain("payer's side");
  });

  it.each(LOCALES)('%s: 5 項目の money guard と paid-response 注意を含む', (loc) => {
    expect(AI_PAY_GUIDE[loc].guards).toHaveLength(5);
    expect(AI_PAY_GUIDE[loc].guards.join('\n').toLowerCase()).toMatch(
      /data|データ/,
    );
  });
});

describe('AI_PAY_GUIDE: agent guide の JPYC 入手文言を一字不変で再利用', () => {
  const keys = [
    'jpycTitle',
    'jpycBody',
    'jpycSteps',
    'jpycAddressLabel',
    'jpycAddress',
    'jpycAddressChainNote',
    'jpycLegacyWarning',
    'jpycGasNote',
    'jpycNoGasNote',
    'jpycLiquidityNote',
  ] as const;

  it.each(LOCALES)('%s: jpyc* 一式が AGENT_GUIDE と完全一致', (loc) => {
    for (const key of keys) {
      expect(AI_PAY_GUIDE[loc][key]).toBe(AGENT_GUIDE[loc][key]);
    }
  });
});
