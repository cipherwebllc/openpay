// @vitest-environment node
// openpay-x402-mcp の discovery_search: /api/discovery にある項目 (id・題名・いつ使うか・ドキュメント・利用条件・
// 更新日・最終確認日・公式) をそのまま AI に渡す (無ければ出さない)。query は題名と「いつ使うか」にも当たる。
// 価格・手数料・合計の計算は従来どおり accepts の merchantValue / feeValue から (plans/ai-store-agent-metadata.md)。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type Runtime = { callTool: (name: string, args: unknown) => Promise<ToolResult> };
const { createToolRuntime } = (await import(
  pathToFileURL(resolve('packages/x402-mcp/src/tools.mjs')).href
)) as { createToolRuntime: (options: Record<string, unknown>) => Runtime };

const unit = 10n ** 18n;
let home: string;

function accepts(resource: string) {
  return [
    {
      scheme: 'exact',
      network: 'eip155:137',
      resource,
      extra: { openpay: { merchantValue: String(2n * unit), feeValue: String(unit / 10n) } },
    },
  ];
}

const THIRD_PARTY = {
  id: 'r_abc',
  resource: 'https://api.example.com/weather',
  title: '天気の要約',
  description: '指定した都市の今日の天気を JSON で返す',
  trigger: '旅行の前に現地の天気を確かめたいとき',
  category: 'data',
  docsUrl: 'https://api.example.com/docs',
  license: 'CC BY 4.0',
  updatedAt: '2026-10-01T00:00:00.000Z',
  verifiedAt: '2026-10-19T03:00:00.000Z',
  network: 'eip155:137',
  accepts: accepts('https://api.example.com/weather'),
  // MCP の要約には出さない (USDC の併売は MCP の JPYC 買い手には使わない)
  usdc: { priceUsd: '0.02', serviceName: 'Weather' },
};
const FIRST_PARTY = {
  resource: 'https://open-pay.jp/api/paid/jpyc/rate',
  description: 'JPYC のレート',
  category: 'finance',
  official: true,
  verifiedAt: '2026-10-19T03:00:00.000Z',
  accepts: accepts('https://open-pay.jp/api/paid/jpyc/rate'),
};
const BARE = {
  resource: 'https://api.example.com/bare',
  description: '最小の掲載',
  category: 'data',
  official: 'yes', // true 以外は公式扱いしない
  docsUrl: '',
  accepts: accepts('https://api.example.com/bare'),
};

function runtime() {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ x402Version: 1, items: [THIRD_PARTY, FIRST_PARTY, BARE] })));
  return createToolRuntime({
    env: { HOME: home, SIGNER_MODE: 'keystore', CATALOG_TRUST: 'false' },
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    nowSec: () => 1_790_000_000,
  });
}

async function search(args: Record<string, unknown>) {
  const result = await runtime().callTool('discovery_search', args);
  return JSON.parse(result.content[0].text) as { ok: boolean; count: number; items: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-mcp-discovery-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('discovery_search', () => {
  it('カタログにある項目をそのまま渡し、価格・手数料・合計は accepts から計算する', async () => {
    const body = await search({});
    expect(body.ok).toBe(true);
    const [third, first, bare] = body.items;
    expect(third).toEqual({
      id: 'r_abc',
      resource: 'https://api.example.com/weather',
      title: '天気の要約',
      description: '指定した都市の今日の天気を JSON で返す',
      trigger: '旅行の前に現地の天気を確かめたいとき',
      category: 'data',
      priceJpyc: '2',
      feeJpyc: '0.1',
      totalJpyc: '2.1',
      network: 'eip155:137',
      docsUrl: 'https://api.example.com/docs',
      license: 'CC BY 4.0',
      updatedAt: '2026-10-01T00:00:00.000Z',
      verifiedAt: '2026-10-19T03:00:00.000Z',
    });
    expect(first).toMatchObject({ official: true, verifiedAt: '2026-10-19T03:00:00.000Z' });
    expect('id' in first).toBe(false);
    // 無い・空・型の違う値は出さない
    expect(['id', 'title', 'trigger', 'docsUrl', 'license', 'updatedAt', 'verifiedAt', 'official'].filter((key) => key in bare)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('priceUsd');
  });

  it('query は題名と「いつ使うか」にも当たる', async () => {
    expect((await search({ query: '天気の要約' })).items.map((item) => item.resource)).toEqual(['https://api.example.com/weather']);
    expect((await search({ query: '旅行の前' })).items.map((item) => item.resource)).toEqual(['https://api.example.com/weather']);
    expect((await search({ query: 'レート' })).count).toBe(1);
  });
});
