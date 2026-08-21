// CDP Bazaar / agentic.market 向け宣言のドリフトフェンス。
// 宣言 (lib/directory/usdcResource.ts) は手書きの enum を含むため、実装
// (lib/directory/query.ts validateDirectoryQuery・types.ts の enum) とずれると
// エージェントがカードどおりに呼んで 400 を踏む。ここで「宣言した引数・値は全て受理される」
// を振る舞いで固定する。

import { describe, it, expect } from 'vitest';
import {
  USDC_DIRECTORY_SEARCH_BAZAAR,
  USDC_DIRECTORY_LIST_BAZAAR,
} from '@/lib/directory/usdcResource';
import { validateDirectoryQuery } from '@/lib/directory/query';
import {
  DIRECTORY_CATEGORIES,
  DIRECTORY_CHAINS,
  DIRECTORY_LANGUAGES,
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
  });

  it('queryParams の例示値はそのまま有効なクエリである', () => {
    const sp = new URLSearchParams(USDC_DIRECTORY_SEARCH_BAZAAR.queryParams);
    expect(validateDirectoryQuery(sp).ok).toBe(true);
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
