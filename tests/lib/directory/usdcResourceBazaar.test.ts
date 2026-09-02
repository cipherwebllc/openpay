// CDP Bazaar / agentic.market 向け宣言のドリフトフェンス。
// 宣言 (lib/directory/usdcResource.ts) は手書きの enum を含むため、実装
// (lib/directory/query.ts validateDirectoryQuery・types.ts の enum) とずれると
// エージェントがカードどおりに呼んで 400 を踏む。ここで「宣言した引数・値は全て受理される」
// を振る舞いで固定する。

import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import {
  USDC_DIRECTORY_SEARCH_BAZAAR,
  USDC_DIRECTORY_LIST_BAZAAR,
  USDC_PAYMENT_MONITOR_BAZAAR,
  USDC_SERVICE_MONITOR_BAZAAR,
} from '@/lib/directory/usdcResource';
import {
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import { QUERY_KEYS, validateDirectoryQuery } from '@/lib/directory/query';
import {
  DIRECTORY_CATEGORIES,
  DIRECTORY_CHAINS,
  DIRECTORY_LANGUAGES,
  DIRECTORY_STATUSES,
  DIRECTORY_TOKENS,
} from '@/lib/directory/types';
import { buildBazaarQueryExtensionV2 } from '@/lib/x402/v2';

type PropSchema = { enum?: readonly string[] };
const props = USDC_DIRECTORY_SEARCH_BAZAAR.queryParamsSchema.properties as Record<
  string,
  PropSchema
>;

describe('USDC directory の bazaar 宣言は実装と一致する', () => {
  it('宣言した引数名は全て validateDirectoryQuery が受理する', () => {
    for (const key of Object.keys(props)) {
      const sp = new URLSearchParams();
      // 値は各引数の代表値 (enum があれば先頭・数値系は 1・keyword は任意文字列)
      const schema = props[key];
      sp.set(key, schema.enum ? schema.enum[0] : key === 'keyword' ? 'jpyc' : '1');
      expect(validateDirectoryQuery(sp).ok, `key=${key}`).toBe(true);
    }
  });

  it('宣言した enum は types.ts の許容値と完全一致する (追加・削除の取りこぼし検出)', () => {
    expect([...props.category.enum!].sort()).toEqual([...DIRECTORY_CATEGORIES].sort());
    expect([...props.token.enum!].sort()).toEqual([...DIRECTORY_TOKENS].sort());
    expect([...props.chain.enum!].sort()).toEqual([...DIRECTORY_CHAINS].sort());
    expect([...props.language.enum!].sort()).toEqual([...DIRECTORY_LANGUAGES].sort());
    // status も types.ts が SoT (宣言だけ増減すると「宣言どおりに呼んで 400」が起きる)。
    expect([...props.status.enum!].sort()).toEqual([...DIRECTORY_STATUSES].sort());
  });

  it('queryParams の例示値はそのまま有効なクエリである', () => {
    const sp = new URLSearchParams(USDC_DIRECTORY_SEARCH_BAZAAR.queryParams);
    expect(validateDirectoryQuery(sp).ok).toBe(true);
  });

  it('E27: 宣言した引数キー集合は実装の QUERY_KEYS と完全一致する (欠落キーの取りこぼし検出)', () => {
    expect(Object.keys(props).sort()).toEqual([...QUERY_KEYS].sort());
  });

  it('宣言しない引数は実装も拒否する (宣言が「全部」であることの裏取り)', () => {
    const sp = new URLSearchParams({ q: 'jpyc' });
    expect(validateDirectoryQuery(sp).ok).toBe(false);
  });

  it('buildBazaarQueryExtensionV2 は宣言を公式形 (info.input.queryParams + schema.properties.input.properties.queryParams + info.output) に展開する', () => {
    const ext = buildBazaarQueryExtensionV2(USDC_DIRECTORY_SEARCH_BAZAAR);
    const info = ext.info as {
      input: { type: string; method: string; queryParams: Record<string, string> };
      output: { type: string; example: unknown };
    };
    expect(info.input.type).toBe('http');
    expect(info.input.method).toBe('GET');
    expect(info.input.queryParams).toEqual(USDC_DIRECTORY_SEARCH_BAZAAR.queryParams);
    expect(info.output.type).toBe('json');
    const schema = ext.schema as {
      properties: {
        input: { properties: { queryParams: { type: string; additionalProperties: boolean } } };
        output: { required: string[] };
      };
      required: string[];
    };
    expect(schema.properties.input.properties.queryParams.type).toBe('object');
    expect(schema.properties.input.properties.queryParams.additionalProperties).toBe(false);
    expect(schema.properties.output.required).toEqual(['type']);
    expect(schema.required).toEqual(['input']);
  });

  it('一覧 (引数なし) は queryParams を持たず output 例だけを持つ', () => {
    const ext = buildBazaarQueryExtensionV2(USDC_DIRECTORY_LIST_BAZAAR);
    const info = ext.info as { input: Record<string, unknown>; output?: unknown };
    expect(info.input).toEqual({ type: 'http', method: 'GET' });
    expect(info.output).toBeDefined();
  });
});

// W7: 掲載カードの output.example は「買い手が最初に見る応答の形」。有料応答の宣言スキーマ
// (paidResources.ts の *_OUTPUT) と食い違うと、エージェントは例を信じて実応答を誤読する。
// tests/lib/jpyc/liveResourcesBazaar.test.ts と同じ Ajv 2020 (CDP validator 相当) で検証する。
describe('Monitor の Bazaar output.example は有料応答スキーマに適合する (W7)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

  it.each([
    ['service monitor', JPYC_SERVICES_RESOURCE.outputSchema.output, USDC_SERVICE_MONITOR_BAZAAR.output.example],
    ['payment monitor', JPYC_PAYMENTS_RESOURCE.outputSchema.output, USDC_PAYMENT_MONITOR_BAZAAR.output.example],
  ])('%s', (_label, schema, example) => {
    const validate = ajv.compile(schema as Record<string, unknown>);
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    // 空オブジェクトが通るなら required が効いておらず、上の合格は無意味 (フェンスの自己検査)。
    expect(validate({}), 'スキーマが required を課していない').toBe(false);
  });
});

describe('USDC 面 description の CDP 上限フェンス', () => {
  it('全 USDC resource の description ≤ 480 字 (超過は settle 時に CDP が形式拒否しうる — #396 実測)', async () => {
    const mod = await import('@/lib/directory/usdcResource');
    for (const r of [mod.USDC_DIRECTORY_LIST, mod.USDC_DIRECTORY_SEARCH, mod.USDC_SERVICE_MONITOR, mod.USDC_PAYMENT_MONITOR]) {
      expect(r.description.length, r.path).toBeLessThanOrEqual(480);
    }
  });
});
