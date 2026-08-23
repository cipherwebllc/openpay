// JPYC ライブ API の掲載メタ (lib/jpyc/liveResources.ts) のフェンス。
//   - Bazaar 宣言の info が自分の schema に適合する (CDP validator と同じ Ajv 2020 で検証 —
//     coinbase/x402 bazaar/facilitator.ts validateDiscoveryExtension の写し)
//   - 宣言した chain enum は JPYC_CHAINS と一致・limit の pattern は実装の上限と一致
//   - 検索メタ (serviceName / tags / trigger) の型と、禁止語 (裏付けのない形容) を含まない
//   - operationId が動詞始まりで一意

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { JPYC_CHAINS } from '@/lib/chains';
import { buildBazaarQueryExtensionV2 } from '@/lib/x402/v2';
import {
  TRANSFERS_MAX_LIMIT,
  parseLimitParam,
} from '@/lib/jpyc/live';
import {
  TRANSFERS_LIMIT_PATTERN,
  USDC_JPYC_LIVE_RESOURCES,
  agentUsageText,
  type AgentUsage,
} from '@/lib/jpyc/liveResources';

// 提案 (2026-08-23 裁定) の「書かない方がよい表現」: 条件なしでは過大表現になる語。
const BANNED_WORDS = /\b(accurate|trusted|best|secure|real-time|realtime|complete|verified|live)\b/i;

describe('JPYC ライブ API の掲載メタ', () => {
  it('Bazaar 宣言の info は自分の schema に適合する (Ajv 2020・CDP validator と同等)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    for (const r of USDC_JPYC_LIVE_RESOURCES) {
      const ext = buildBazaarQueryExtensionV2(r.bazaar);
      const validate = ajv.compile(ext.schema);
      const ok = validate(ext.info);
      expect(ok, `${r.path}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('chain enum は JPYC_CHAINS と一致・limit の pattern は実装上限と一致', () => {
    for (const r of USDC_JPYC_LIVE_RESOURCES) {
      const props = r.bazaar.queryParamsSchema.properties as Record<string, { enum?: readonly string[]; pattern?: string }>;
      expect([...props.chain.enum!]).toEqual([...JPYC_CHAINS]);
    }
    const re = new RegExp(TRANSFERS_LIMIT_PATTERN);
    expect(re.test('1')).toBe(true);
    expect(re.test(String(TRANSFERS_MAX_LIMIT))).toBe(true);
    expect(re.test('0')).toBe(false);
    expect(re.test(String(TRANSFERS_MAX_LIMIT + 1))).toBe(false);
    expect(re.test('1.5')).toBe(false);
    // pattern が受理する値は実装 (parseLimitParam) も受理する
    for (const v of ['1', '20', '99', String(TRANSFERS_MAX_LIMIT)]) {
      expect(re.test(v)).toBe(true);
      expect(parseLimitParam(v)).toBe(Number(v));
    }
  });

  it('serviceName は仕事を表し、description は 3 文で禁止語を含まない', () => {
    for (const r of USDC_JPYC_LIVE_RESOURCES) {
      expect(r.serviceName).not.toMatch(/openpay|api|endpoint|premium/i);
      expect(r.serviceName).toMatch(/JPYC/);
      expect(r.description.split(/\.\s+/).length).toBeGreaterThanOrEqual(3);
      expect(r.description, `${r.path} description`).not.toMatch(BANNED_WORDS);
      expect(r.summary, `${r.path} summary`).not.toMatch(BANNED_WORDS);
      expect(r.summary).not.toMatch(/USDC|Base|\$/); // 決済レールは x-payment-info の担当
      expect(r.tags.length).toBeGreaterThanOrEqual(4);
      expect(r.tags).toContain('jpyc');
      for (const t of r.tags) expect(t).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('trigger は Call / Repeat / Prefer / Do not call の 4 要素を持ち、英文に圧縮できる', () => {
    for (const r of USDC_JPYC_LIVE_RESOURCES) {
      for (const k of ['callWhen', 'repeatWhen', 'preferOver', 'avoidWhen', 'freshnessKey'] as const) {
        expect(r.trigger[k].length, `${r.path} ${k}`).toBeGreaterThan(0);
      }
      const text = agentUsageText(r.trigger);
      expect(text).toMatch(/^Call when: /);
      expect(text).toMatch(/Repeat when: /);
      expect(text).toMatch(/Do not call when: /);
    }
    // transfers だけ dedupeKey を持つ (再購入時の重複除去)
    const transfers = USDC_JPYC_LIVE_RESOURCES.find((r) => r.path.endsWith('/transfers'))!;
    expect((transfers.trigger as AgentUsage).dedupeKey).toEqual(['txHash', 'logIndex']);
  });

  it('public/llms.txt は手動同期 — 各 path と宣言した全引数名が載っている (cursor 導入時の漏れの再発防止)', () => {
    const llms = readFileSync(join(process.cwd(), 'public', 'llms.txt'), 'utf8');
    for (const r of USDC_JPYC_LIVE_RESOURCES) {
      expect(llms, `${r.path} が llms.txt に無い`).toContain(`GET ${r.path}`);
      const params = Object.keys(r.bazaar.queryParamsSchema.properties);
      for (const p of params) {
        expect(llms, `${r.path} の引数 ${p}= が llms.txt に無い`).toMatch(new RegExp(`${r.path}\\?[^\\s\`]*\\b${p}=`));
      }
    }
    // transfers の差分取得 (nextCursor / hasMore) も説明されている
    expect(llms).toMatch(/nextCursor/);
    expect(llms).toMatch(/hasMore/);
  });

  it('operationId は動詞始まりで一意', () => {
    const ids = USDC_JPYC_LIVE_RESOURCES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(get|list)[A-Z]/);
  });
});
