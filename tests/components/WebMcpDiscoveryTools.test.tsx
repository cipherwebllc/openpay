// WebMCP spike (components/WebMcpDiscoveryTools) の検証。
// 柱: (1) 未対応ブラウザで no-op、(2) 3 tools の登録/解除、(3) 各 tool の契約 —
// search の統合/絞り込み・schema の openapi 参照・prepare の 402 素通し、
// (4) 安全境界: resource は同一 origin の /api/* のみ・支払い実行はしない (402 以外は throw)。

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  buildWebMcpTools,
  normalizeResourceArg,
  WebMcpDiscoveryTools,
} from '@/components/WebMcpDiscoveryTools';

const ORIGIN = 'https://open-pay.jp';

const USDC_ITEMS = [
  {
    resource: 'https://open-pay.jp/api/paid/usdc/jpyc/services',
    title: 'JPYC Service Monitor',
    description: 'weekly change feed',
    priceUsd: '0.01',
    category: 'data' as const,
  },
];

function routingFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const handler = routes[u];
    if (!handler) throw new Error(`unexpected fetch: ${u}`);
    return handler();
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function toolResult(
  tool: { execute: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> },
  args: Record<string, unknown>,
) {
  const res = await tool.execute(args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  delete (navigator as Navigator & { modelContext?: unknown }).modelContext;
});

describe('normalizeResourceArg (安全境界)', () => {
  it('同一 origin の /api/* のみ受理 (パス・完全 URL とも)', () => {
    expect(normalizeResourceArg('/api/paid/demo', ORIGIN)).toBe('/api/paid/demo');
    expect(
      normalizeResourceArg('https://open-pay.jp/api/paid/jpyc/services?changedSince=2026-08-27', ORIGIN),
    ).toBe('/api/paid/jpyc/services?changedSince=2026-08-27');
  });

  it.each([
    ['他 origin', 'https://evil.example/api/paid/demo'],
    ['非 /api/ パス', '/discovery'],
    ['非 URL 文字列', 'not a url'],
    ['数値', 42],
  ])('%s は拒否', (_label, value) => {
    expect(normalizeResourceArg(value, ORIGIN)).toBeNull();
  });
});

describe('buildWebMcpTools', () => {
  it('search: /api/discovery + usdcItems を統合し keyword/currency で絞る', async () => {
    const fetchImpl = routingFetch({
      '/api/discovery': () =>
        json({
          items: [
            {
              resource: 'https://open-pay.jp/api/paid/stores',
              description: 'JPYC acceptance list',
              priceJpyc: '5',
            },
          ],
        }),
    });
    const [search] = buildWebMcpTools(USDC_ITEMS, ORIGIN, fetchImpl);
    const all = await toolResult(search, {});
    expect(all.total).toBe(2);

    const usdcOnly = await toolResult(search, { currency: 'usdc' });
    expect(usdcOnly.total).toBe(1);
    expect((usdcOnly.items as Array<{ currency: string }>)[0].currency).toBe('usdc');

    const byKeyword = await toolResult(search, { keyword: 'acceptance' });
    expect(byKeyword.total).toBe(1);
  });

  it('schema: openapi の該当 operation から parameters/x-agent-usage/payment を返す', async () => {
    const fetchImpl = routingFetch({
      '/api/openapi.json': () =>
        json({
          paths: {
            '/api/paid/jpyc/services': {
              get: {
                summary: 'monitor',
                parameters: [{ name: 'changedSince' }],
                'x-agent-usage': 'weekly',
                'x-payment-info': { price: { amount: '3' } },
                responses: {
                  '200': { content: { 'application/json': { example: { mode: 'delta' } } } },
                },
              },
            },
          },
        }),
    });
    const [, schema] = buildWebMcpTools(USDC_ITEMS, ORIGIN, fetchImpl);
    const result = await toolResult(schema, {
      resource: 'https://open-pay.jp/api/paid/jpyc/services?changedSince=2026-08-27',
    });
    expect(result).toMatchObject({
      path: '/api/paid/jpyc/services',
      agentUsage: 'weekly',
      responseExample: { mode: 'delta' },
    });
    await expect(
      schema.execute({ resource: 'https://evil.example/api/x' }),
    ).rejects.toThrow(/open-pay\.jp/);
  });

  it('prepare: 402 の accepts を素通しし、支払い非実行の note を必ず付ける', async () => {
    const fetchImpl = routingFetch({
      '/api/paid/demo': () => json({ accepts: [{ network: 'eip155:137' }] }, 402),
      '/api/free': () => json({ ok: true }, 200),
    });
    const [, , prepare] = buildWebMcpTools(USDC_ITEMS, ORIGIN, fetchImpl);
    const result = await toolResult(prepare, { resource: '/api/paid/demo' });
    expect(result.accepts).toEqual([{ network: 'eip155:137' }]);
    expect(String(result.note)).toContain('out of scope'); // 支払い非実行の明示
    // 402 以外 (無料/エラー) は throw = 「支払える」と誤認させない。
    await expect(prepare.execute({ resource: '/api/free' })).rejects.toThrow(/402/);
  });
});

describe('WebMcpDiscoveryTools component', () => {
  it('未対応ブラウザ (modelContext なし) では何も描画せず何も起きない', () => {
    const { container } = render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    expect(container.innerHTML).toBe('');
  });

  it('対応ブラウザでは 3 tools を登録し、unmount で解除する', () => {
    const registered: string[] = [];
    const unregistered: string[] = [];
    (navigator as Navigator & { modelContext?: unknown }).modelContext = {
      registerTool: (tool: { name: string }) => registered.push(tool.name),
      unregisterTool: (name: string) => unregistered.push(name),
    };
    const { unmount } = render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    expect(registered).toEqual([
      'search_paid_resources',
      'get_resource_schema',
      'prepare_purchase',
    ]);
    unmount();
    expect(unregistered).toEqual(registered);
  });
});
