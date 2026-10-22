// WebMCP spike (components/WebMcpDiscoveryTools) の検証。
// 柱: (1) 未対応ブラウザで no-op、(2) 3 tools の登録/解除 (仕様の document.modelContext + signal・
// 旧い navigator.modelContext の予備)、(3) 各 tool の契約 —
// search の統合/絞り込み・schema の openapi 参照・prepare の 402 素通し、
// (4) 安全境界: resource は同一 origin の /api/* のみ・支払い実行はしない (402 以外は throw)。

import { StrictMode } from 'react';
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
  tool: { execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> },
  args: Record<string, unknown>,
) {
  // 仕様は戻り値を JSON に変換してエージェントへ渡すので、値は素のオブジェクトで、変換できること。
  const value = await tool.execute(args);
  expect(typeof value).toBe('object');
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

type RegisterCall = { name: string; annotations?: Record<string, unknown>; signal?: AbortSignal };

/** registerTool の呼び出しを記録する modelContext。registerResult で戻り値 (Promise 等) を差し替える。 */
function fakeModelContext(registerResult: () => unknown = () => Promise.resolve()) {
  const calls: RegisterCall[] = [];
  const unregistered: string[] = [];
  return {
    calls,
    unregistered,
    context: {
      registerTool: (
        tool: { name: string; annotations?: Record<string, unknown> },
        options?: { signal?: AbortSignal },
      ) => {
        calls.push({ name: tool.name, annotations: tool.annotations, signal: options?.signal });
        return registerResult();
      },
      unregisterTool: (name: string) => unregistered.push(name),
    },
  };
}

/**
 * 仕様の登録表に近い modelContext (unregisterTool は無い): 同じ名前の二重登録は InvalidStateError で reject、
 * signal の abort でその場で表から消す (仕様の「unregister a tool」は同期)。
 */
function specModelContext() {
  const registered = new Set<string>();
  return {
    registered,
    context: {
      registerTool: (tool: { name: string }, options?: { signal?: AbortSignal }) => {
        if (registered.has(tool.name)) return Promise.reject(new DOMException(tool.name, 'InvalidStateError'));
        if (options?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
        registered.add(tool.name);
        options?.signal?.addEventListener('abort', () => registered.delete(tool.name), { once: true });
        return Promise.resolve();
      },
    },
  };
}

afterEach(() => {
  cleanup();
  delete (navigator as Navigator & { modelContext?: unknown }).modelContext;
  delete (document as Document & { modelContext?: unknown }).modelContext;
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

  it('仕様の document.modelContext に 3 tools を signal つきで登録し、unmount で signal を abort する', () => {
    const mc = fakeModelContext();
    (document as Document & { modelContext?: unknown }).modelContext = mc.context;
    const { unmount } = render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    expect(mc.calls.map((c) => c.name)).toEqual([
      'search_paid_resources',
      'get_resource_schema',
      'prepare_purchase',
    ]);
    const signals = mc.calls.map((c) => c.signal);
    expect(signals.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
    unmount();
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  it('search と schema は読み取りだけの印・出品者の文章を返す search と prepare には「信頼できない内容」の印', () => {
    // prepare は 402 の accepts[].description に出品者の商品名が入る (app/api/paid/hosted/[id]/route.ts)。
    const mc = fakeModelContext();
    (document as Document & { modelContext?: unknown }).modelContext = mc.context;
    render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    expect(Object.fromEntries(mc.calls.map((c) => [c.name, c.annotations]))).toEqual({
      search_paid_resources: { readOnlyHint: true, untrustedContentHint: true },
      get_resource_schema: { readOnlyHint: true },
      // 支払わないが、402 を取るときに見積もりの記録 (期限つき) を作ることがあるので「読み取りだけ」ではない。
      prepare_purchase: { untrustedContentHint: true },
    });
  });

  it('StrictMode のマウントし直し (登録 → abort → 再登録) のあとも 3 tools が登録されたまま、unmount で消える', () => {
    const mc = specModelContext();
    (document as Document & { modelContext?: unknown }).modelContext = mc.context;
    const { unmount } = render(
      <StrictMode>
        <WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />
      </StrictMode>,
    );
    expect([...mc.registered].sort()).toEqual(['get_resource_schema', 'prepare_purchase', 'search_paid_resources']);
    unmount();
    expect(mc.registered.size).toBe(0);
  });

  it('document と navigator の両方にあれば document を使う', () => {
    const doc = fakeModelContext();
    const nav = fakeModelContext();
    (document as Document & { modelContext?: unknown }).modelContext = doc.context;
    (navigator as Navigator & { modelContext?: unknown }).modelContext = nav.context;
    render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    expect(doc.calls).toHaveLength(3);
    expect(nav.calls).toHaveLength(0);
  });

  it('旧い navigator.modelContext (signal なし) にも登録し、unmount で unregisterTool する', () => {
    const mc = fakeModelContext(() => undefined);
    (navigator as Navigator & { modelContext?: unknown }).modelContext = mc.context;
    const { unmount } = render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    const names = mc.calls.map((c) => c.name);
    expect(names).toHaveLength(3);
    unmount();
    expect(mc.unregistered).toEqual(names);
  });

  it('登録の reject (二重登録・解除時の AbortError) や同期の throw でもページは描画を続け、未処理の reject を残さない', async () => {
    const rejecting = fakeModelContext(() => Promise.reject(new DOMException('dup', 'InvalidStateError')));
    (document as Document & { modelContext?: unknown }).modelContext = rejecting.context;
    const { unmount } = render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />);
    await new Promise((resolve) => setTimeout(resolve, 0)); // reject の後始末を待つ (未処理なら vitest が落とす)
    unmount();

    const throwing = fakeModelContext(() => {
      throw new Error('experimental API mismatch');
    });
    (document as Document & { modelContext?: unknown }).modelContext = throwing.context;
    expect(() => render(<WebMcpDiscoveryTools usdcItems={USDC_ITEMS} />)).not.toThrow();
    expect(throwing.calls).toHaveLength(3);
  });
});
