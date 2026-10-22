'use client';

// WebMCP spike (2026-08-30 裁定 項目 2): /discovery ページに read-only 3 tools を公開する。
// WebMCP 対応ブラウザ内エージェント (ChatGPT デスクトップの内蔵ブラウザ・Chrome の origin trial 等) が、
// 画面推測クリックの代わりに「検索 → スキーマ取得 → 402 要件の確認」を構造化ツールで行える。
//
// API は WebMCP の仕様 (W3C WebML CG Draft 2026-10-20) と Chrome の imperative API (2026-10-16):
// 入口は document.modelContext、登録は registerTool(tool, { signal }) (Promise)、解除は signal の abort。
// 8 月の実装の navigator.modelContext + unregisterTool は、古い Chrome・polyfill 向けの予備として残す
// (2026-10-23 裁定: 旧い入口だけでは今のエージェントからツールが見えない)。
//
// 掟 (承認境界・裁定項目 5 と整合): **支払いの実行はツール化しない**。prepare_purchase は
// 402 の支払い要件を返すだけで、署名・送金は購入者自身のウォレットツール (MCP/スクリプト) の
// 責任として明示する。tool の fetch 先は同一 origin の /api/* のみ (任意 URL を叩かせない)。
// annotations: search と schema は readOnlyHint。prepare_purchase は支払わないが、402 を取るときに
// サーバーが見積もりの記録 (期限つき・hosted 商品など) を作ることがあるので readOnlyHint を付けない。
// 出品者の書いた文章を返す search と prepare (402 の accepts[].description に商品名が入る) には
// untrustedContentHint (エージェントが出品文の中の指示に従わないよう、ブラウザとエージェントに知らせる)。
// get_resource_schema は自前の openapi.json だけを返す。
// execute は値をそのまま返す (仕様は戻り値を JSON に変換するので、文字列で返すと二重になる)。
// WebMCP 未対応ブラウザでは何もしない (UI 描画なし・既存ページに影響ゼロ)。

import { useEffect } from 'react';
import type { UsdcCatalogItem } from '@/lib/x402/usdcCatalog';

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: true; untrustedContentHint?: true };
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type ModelContext = {
  // 仕様は Promise を返す・旧い navigator.modelContext は void。
  registerTool?: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
  unregisterTool?: (name: string) => void;
};

/** 仕様の document.modelContext を優先し、無ければ旧い navigator.modelContext を使う。 */
function findModelContext(): ModelContext | undefined {
  return (
    (document as Document & { modelContext?: ModelContext }).modelContext ??
    (navigator as Navigator & { modelContext?: ModelContext }).modelContext
  );
}

/** tool 引数の resource を同一 origin の /api/* パスに正規化する。それ以外は null。 */
export function normalizeResourceArg(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let path: string;
  if (raw.startsWith('/')) {
    path = raw;
  } else {
    try {
      const url = new URL(raw);
      if (url.origin !== origin) return null;
      path = url.pathname + url.search;
    } catch {
      return null;
    }
  }
  return path.startsWith('/api/') ? path : null;
}

export function buildWebMcpTools(
  usdcItems: readonly UsdcCatalogItem[],
  origin: string,
  fetchImpl: typeof fetch = fetch,
): WebMcpTool[] {
  return [
    {
      name: 'search_paid_resources',
      title: 'Search the OpenPay AI store',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      description:
        'Search the OpenPay AI store catalog of x402-payable APIs (JPYC on Polygon and USDC on Base). Returns resource URL, price, currency, and when an agent should buy it. Free to call.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: 'Optional case-insensitive match on description/URL.',
          },
          currency: { type: 'string', enum: ['jpyc', 'usdc'] },
        },
        required: [],
      },
      async execute(args) {
        const keyword =
          typeof args.keyword === 'string' ? args.keyword.toLowerCase() : '';
        const currency = args.currency === 'jpyc' || args.currency === 'usdc' ? args.currency : null;
        const items: Array<Record<string, unknown>> = [];
        if (currency !== 'usdc') {
          const res = await fetchImpl('/api/discovery');
          if (res.ok) {
            const body = (await res.json()) as {
              items?: Array<{
                resource: string;
                description: string;
                trigger?: string;
                priceJpyc: string;
                usdc?: { priceUsd: string };
              }>;
            };
            for (const item of body.items ?? []) {
              items.push({
                resource: item.resource,
                description: item.description,
                ...(item.trigger ? { whenToBuy: item.trigger } : {}),
                priceJpyc: item.priceJpyc,
                currency: 'jpyc',
                ...(item.usdc ? { alsoUsdcPriceUsd: item.usdc.priceUsd } : {}),
              });
            }
          }
        }
        if (currency !== 'jpyc') {
          for (const item of usdcItems) {
            items.push({
              resource: item.resource,
              description: item.description,
              title: item.title,
              priceUsd: item.priceUsd,
              currency: 'usdc',
            });
          }
        }
        const filtered = keyword
          ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(keyword))
          : items;
        return { items: filtered.slice(0, 50), total: filtered.length };
      },
    },
    {
      name: 'get_resource_schema',
      title: 'Get a paid resource schema',
      annotations: { readOnlyHint: true },
      description:
        'Get the machine-readable contract for one OpenPay paid resource: query parameters, x-agent-usage (when/how to re-buy), payment info, and response example. Free to call.',
      inputSchema: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            description: 'Resource URL or /api/... path from search_paid_resources.',
          },
        },
        required: ['resource'],
      },
      async execute(args) {
        const path = normalizeResourceArg(args.resource, origin);
        if (!path) throw new Error('resource must be an open-pay.jp /api/... URL or path');
        const pathname = path.split('?')[0];
        const res = await fetchImpl('/api/openapi.json');
        if (!res.ok) throw new Error('openapi_unavailable');
        const spec = (await res.json()) as {
          paths?: Record<string, { get?: Record<string, unknown> }>;
        };
        const op = spec.paths?.[pathname]?.get;
        if (!op) throw new Error(`no schema for ${pathname}`);
        return {
          path: pathname,
          method: 'GET',
          summary: op.summary,
          parameters: op.parameters,
          agentUsage: op['x-agent-usage'],
          paymentInfo: op['x-payment-info'],
          responseExample: (
            op.responses as
              | Record<string, { content?: Record<string, { example?: unknown }> }>
              | undefined
          )?.['200']?.content?.['application/json']?.example,
        };
      },
    },
    {
      name: 'prepare_purchase',
      title: 'Get payment requirements (no payment)',
      annotations: { untrustedContentHint: true },
      description:
        'Fetch the x402 payment requirements (HTTP 402 accepts) for one OpenPay paid resource, without paying. This tool NEVER signs or executes a payment — use your own wallet tooling (openpay-x402-mcp or the buyer scripts) to pay.',
      inputSchema: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            description: 'Resource URL or /api/... path from search_paid_resources.',
          },
        },
        required: ['resource'],
      },
      async execute(args) {
        const path = normalizeResourceArg(args.resource, origin);
        if (!path) throw new Error('resource must be an open-pay.jp /api/... URL or path');
        const res = await fetchImpl(path);
        if (res.status !== 402) {
          throw new Error(`expected 402 challenge, got HTTP ${res.status}`);
        }
        const body = (await res.json()) as { accepts?: unknown[] };
        return {
          resource: `${origin}${path}`,
          accepts: body.accepts ?? [],
          note: 'Payment execution is out of scope for this tool. Sign and pay with your own x402 wallet tooling; amounts are shown in the accepts entries (JPYC 18 decimals on Polygon, USDC 6 decimals on Base).',
        };
      },
    },
  ];
}

export function WebMcpDiscoveryTools({
  usdcItems,
}: {
  usdcItems: readonly UsdcCatalogItem[];
}) {
  useEffect(() => {
    const mc = findModelContext();
    if (!mc?.registerTool) return; // WebMCP 未対応ブラウザでは何もしない
    const tools = buildWebMcpTools(usdcItems, window.location.origin);
    const controller = new AbortController();
    for (const tool of tools) {
      // 実験段階の API の差異・二重登録 (InvalidStateError)・解除時の AbortError は、同期の throw でも
      // Promise の reject でもページ本体に波及させない (未処理の reject も残さない)。
      try {
        Promise.resolve(mc.registerTool(tool, { signal: controller.signal })).catch(() => {});
      } catch {
        /* 同上 */
      }
    }
    return () => {
      controller.abort();
      for (const tool of tools) {
        try {
          mc.unregisterTool?.(tool.name); // 旧い navigator.modelContext には signal が無い
        } catch {
          /* 同上 */
        }
      }
    };
  }, [usdcItems]);
  return null;
}
