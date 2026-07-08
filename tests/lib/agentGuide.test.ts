// /guide/agent ガイドの content SOT (lib/agentGuide.ts) を実コードで網羅検証する。
//
// ページ (app/[locale]/guide/agent/page.tsx) は async Server Component で next-intl server /
// AppShell に依存するため、描画ヘルパは tests/components/AgentGuidePieces.test.tsx で実描画検証し、
// ここでは「描画される全テキストの源」である AGENT_GUIDE / agentGuideContentFor / guideAgentMetadata を
// 実走で検証する (posGuide.test.ts と同思想)。
//
// 観点: (1) 関数の全分岐 (2) ja/en 構造 parity + 全 leaf 非空 (3) 形式不変条件
// (4) **JPYC アドレスが lib/tokens.ts の権威値と一致** (誤アドレス=資金喪失の回帰フェンス)
// (5) MCP 設定が鍵不要 (README/bin と一致・秘密鍵を含めない) (6) 交換業回避・投資助言でない等の開示
// (7) 掟 4 回帰: 撤去済み表記「JPYC 公式」を含まない。

import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_GUIDE,
  JPYC_CONTRACT_ADDRESS,
  agentGuideContentFor,
  guideAgentMetadata,
} from '@/lib/agentGuide';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const LOCALES = ['ja', 'en'] as const;

// 構造 (キー集合・ネスト・配列長・leaf 型) を抽出。leaf 値は無視し ja/en の翻訳差は許容しつつ、
// 「形」のズレ (キー欠落 / 配列長違い) だけを検出する。
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
    for (const [k, v] of Object.entries(value)) assertLeavesValid(v, `${path}.${k}`);
  } else {
    throw new Error(`${path}: 予期しない型 ${typeof value}`);
  }
}

// ── (1) agentGuideContentFor: 全分岐 ──────────────────────────────
describe('agentGuideContentFor: locale 解決の全分岐', () => {
  it("'ja' は AGENT_GUIDE.ja を返す (同一参照)", () => {
    expect(agentGuideContentFor('ja')).toBe(AGENT_GUIDE.ja);
  });
  it("'en' は AGENT_GUIDE.en を返す (同一参照)", () => {
    expect(agentGuideContentFor('en')).toBe(AGENT_GUIDE.en);
  });
  it('未知ロケールは ja にフォールバック', () => {
    expect(agentGuideContentFor('fr')).toBe(AGENT_GUIDE.ja);
    expect(agentGuideContentFor('ja-JP')).toBe(AGENT_GUIDE.ja);
  });
  it('空文字は ja にフォールバック', () => {
    expect(agentGuideContentFor('')).toBe(AGENT_GUIDE.ja);
  });
  it("大小区別: 'EN' は en ではなく ja (Next の locale は小文字 'en' のみ)", () => {
    expect(agentGuideContentFor('EN')).toBe(AGENT_GUIDE.ja);
  });
});

// ── guideAgentMetadata: <title>/<description> 組立 ─────────────────
describe('guideAgentMetadata: メタデータ組立', () => {
  it.each(LOCALES)('%s: title=metaTitle+" · OpenPay" / description=metaDescription', (loc) => {
    const c = AGENT_GUIDE[loc];
    const m = guideAgentMetadata(loc);
    expect(m.title).toBe(`${c.metaTitle} · OpenPay`);
    expect(m.description).toBe(c.metaDescription);
    expect(m.title).toContain('OpenPay');
  });

  it('未知ロケールは ja の metadata に一致', () => {
    expect(guideAgentMetadata('fr')).toEqual(guideAgentMetadata('ja'));
  });
});

// ── (2) ja/en parity + 全 leaf 非空 ───────────────────────────────
describe('AGENT_GUIDE: ja/en 構造 parity と非空', () => {
  it('ja と en のトップレベルキーが完全一致', () => {
    expect(Object.keys(AGENT_GUIDE.ja).sort()).toEqual(
      Object.keys(AGENT_GUIDE.en).sort(),
    );
  });

  it('ja と en の構造 (ネスト・配列長・leaf 型) が完全一致', () => {
    expect(shape(AGENT_GUIDE.ja)).toEqual(shape(AGENT_GUIDE.en));
  });

  it.each(LOCALES)('%s: 全 string leaf が非空・全 number leaf が有限', (loc) => {
    assertLeavesValid(AGENT_GUIDE[loc], loc);
  });

  it.each(LOCALES)('%s: 主要配列が非空 (空セクション描画を防ぐ)', (loc) => {
    const c = AGENT_GUIDE[loc];
    expect(c.canDo.length).toBeGreaterThan(0);
    expect(c.cannot.length).toBeGreaterThan(0);
    expect(c.need.length).toBeGreaterThan(0);
    expect(c.setupSteps.length).toBeGreaterThan(0);
    expect(c.flowSteps.length).toBeGreaterThan(0);
    expect(c.jpycSteps.length).toBeGreaterThan(0);
    expect(c.disclosures.length).toBeGreaterThan(0);
    expect(c.safety.length).toBeGreaterThan(0);
    expect(c.faqs.length).toBeGreaterThan(0);
  });
});

// ── (3) 形式不変条件 ──────────────────────────────────────────────
describe('AGENT_GUIDE: 形式不変条件 (描画前提)', () => {
  it.each(LOCALES)('%s: ctaButtonHref は "/" 始まり (page が /${locale}+href を生成)', (loc) => {
    expect(AGENT_GUIDE[loc].ctaButtonHref.startsWith('/')).toBe(true);
  });

  it.each(LOCALES)('%s: setupSteps / flowSteps / jpycSteps の n は 1 起点の連番', (loc) => {
    for (const steps of [
      AGENT_GUIDE[loc].setupSteps,
      AGENT_GUIDE[loc].flowSteps,
      AGENT_GUIDE[loc].jpycSteps,
    ]) {
      steps.forEach((s, i) => expect(s.n).toBe(i + 1));
    }
  });

  it.each(LOCALES)('%s: faqs の q/a が非空', (loc) => {
    for (const f of AGENT_GUIDE[loc].faqs) {
      expect(f.q.trim().length).toBeGreaterThan(0);
      expect(f.a.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── (4) JPYC アドレス: lib/tokens.ts の権威値と一致 (資金喪失の回帰フェンス) ──
describe('AGENT_GUIDE: JPYC コントラクトアドレス整合', () => {
  it('公開定数 JPYC_CONTRACT_ADDRESS が tokens.ts の JPYC(Polygon) deployment と一致', () => {
    // ガイドに文字列転記せず tokens.ts を単一情報源にすることの実証。片方だけ変えたら落ちる。
    // これが env 非依存の本質的フェンス: 本番 (override 無し) では v3 hardcode default
    // (0xE7C3D8C9…3c29) に、test env では vitest.config の NEXT_PUBLIC_JPYC_TESTNET_ADDRESS
    // override に、いずれも tokens.ts の権威解決値に一致する (リテラル直書きは env で揺れるため避ける)。
    expect(JPYC_CONTRACT_ADDRESS).toBe(defaultDeploymentForSymbol('jpyc').address);
  });

  it('40 桁 hex の EVM アドレス形式', () => {
    expect(JPYC_CONTRACT_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it.each(LOCALES)('%s: 表示アドレス jpycAddress が権威値と同一', (loc) => {
    expect(AGENT_GUIDE[loc].jpycAddress).toBe(JPYC_CONTRACT_ADDRESS);
  });

  it('ja/en の表示アドレスは同一 (chain 非依存の単一値)', () => {
    expect(AGENT_GUIDE.ja.jpycAddress).toBe(AGENT_GUIDE.en.jpycAddress);
  });

  it.each(LOCALES)('%s: レガシー v1 (0x431d…) を回避せよと注意喚起している', (loc) => {
    expect(AGENT_GUIDE[loc].jpycLegacyWarning).toContain('0x431d');
  });
});

// ── (4b) ヒーロー画像: 実在・言語非依存の同一画像 (リンク切れ防止) ────
describe('AGENT_GUIDE: ヒーロー画像', () => {
  it.each(LOCALES)('%s: heroImage.src は /guide-agent/ 配下の .webp・寸法は正の数', (loc) => {
    const h = AGENT_GUIDE[loc].heroImage;
    expect(h.src).toMatch(/^\/guide-agent\/.+\.webp$/);
    expect(h.width).toBeGreaterThan(0);
    expect(h.height).toBeGreaterThan(0);
    expect(h.alt.trim().length).toBeGreaterThan(0);
  });

  it('ja/en は同一画像 (src・寸法が一致・言語非依存)', () => {
    expect(AGENT_GUIDE.ja.heroImage.src).toBe(AGENT_GUIDE.en.heroImage.src);
    expect(AGENT_GUIDE.ja.heroImage.width).toBe(AGENT_GUIDE.en.heroImage.width);
    expect(AGENT_GUIDE.ja.heroImage.height).toBe(AGENT_GUIDE.en.heroImage.height);
  });

  it('画像ファイルが public 配下に実在し非空 (公開時のリンク切れ防止)', () => {
    const rel = AGENT_GUIDE.ja.heroImage.src.replace(/^\//, '');
    const st = statSync(join(process.cwd(), 'public', rel));
    expect(st.size).toBeGreaterThan(0);
  });
});

// ── (5) MCP 設定: 鍵不要・README/bin と一致 (秘密鍵を含めない) ──────
describe('AGENT_GUIDE: MCP 設定スニペット', () => {
  it('ja/en の configCode は同一 (言語非依存)', () => {
    expect(AGENT_GUIDE.ja.configCode).toBe(AGENT_GUIDE.en.configCode);
  });

  it.each(LOCALES)('%s: mcpServers / npx / bin(openpay-x402-mcp) を含む', (loc) => {
    const code = AGENT_GUIDE[loc].configCode;
    expect(code).toContain('mcpServers');
    expect(code).toContain('"npx"');
    expect(code).toContain('openpay-x402-mcp');
  });

  it.each(LOCALES)('%s: 秘密鍵・署名モードを含めない (AI は財布を持たない handoff 経路)', (loc) => {
    const code = AGENT_GUIDE[loc].configCode;
    expect(code).not.toContain('BUYER_PRIVATE_KEY');
    expect(code).not.toContain('SIGNER_MODE');
    expect(code).not.toMatch(/private[_ ]?key/i);
  });

  it.each(LOCALES)('%s: config は妥当な JSON としてパースでき mcpServers.openpay-x402 を持つ', (loc) => {
    const parsed = JSON.parse(AGENT_GUIDE[loc].configCode);
    expect(parsed.mcpServers['openpay-x402'].command).toBe('npx');
    expect(parsed.mcpServers['openpay-x402'].args).toEqual(['openpay-x402-mcp']);
  });
});

// ── (6) 開示: 交換業回避・投資助言でない・公式確認 ─────────────────
describe('AGENT_GUIDE: 法的開示 (交換業回避)', () => {
  it('ja: 交換・両替をしない / 投資助言でない / (公式) 確認 の 3 点を含む', () => {
    const d = AGENT_GUIDE.ja.disclosures.join('\n');
    expect(d).toContain('交換');
    expect(d).toContain('両替');
    expect(d).toContain('投資助言');
    expect(d).toMatch(/確認/);
  });

  it('en: exchange/convert しない / investment advice でない / verify を含む', () => {
    const d = AGENT_GUIDE.en.disclosures.join('\n').toLowerCase();
    expect(d).toMatch(/exchange|convert/);
    expect(d).toContain('investment advice');
    expect(d).toContain('verify');
  });

  it.each(LOCALES)('%s: cannot に「AI は支払わない/財布を持たない」旨がある', (loc) => {
    const cannot = AGENT_GUIDE[loc].cannot.join('\n');
    if (loc === 'ja') {
      expect(cannot).toContain('AI');
      expect(cannot).toMatch(/財布|秘密鍵|承認/);
    } else {
      expect(cannot.toLowerCase()).toMatch(/does not pay|no wallet|no private key/);
    }
  });
});

// ── (7) 掟 4 回帰: 撤去済み表記「JPYC 公式」を含まない ─────────────
describe('AGENT_GUIDE: 文言フェンス (回帰防止)', () => {
  const jaJson = JSON.stringify(AGENT_GUIDE.ja);
  const enJson = JSON.stringify(AGENT_GUIDE.en);

  it('撤去済みの「JPYC 公式 / JPYC公式」を含まない (全域統一済み表記=JPYC EX)', () => {
    expect(jaJson).not.toContain('JPYC 公式');
    expect(jaJson).not.toContain('JPYC公式');
    expect(enJson).not.toContain('JPYC 公式');
  });

  it('公式確認先として JPYC EX を案内している', () => {
    expect(jaJson).toContain('JPYC EX');
    expect(enJson).toContain('JPYC EX');
  });
});
