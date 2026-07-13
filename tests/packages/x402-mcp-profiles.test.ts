import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  profiles?: unknown;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ToolRuntime = {
  tools: Tool[];
  callTool: (name: string, args: unknown) => Promise<ToolResult>;
};

type ToolsModule = {
  TOOLS: Tool[];
  createToolRuntime: (options?: {
    profile?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }) => ToolRuntime;
};

const X402_TOOL_NAMES = [
  'discovery_search',
  'x402_quote',
  'x402_pay',
  'order_menu',
  'order_quote',
  'order_summary',
  'createOrderLink',
  'find_shops',
  'search_shops',
];
const ORDER_TOOL_NAMES = [
  'order_menu',
  'order_summary',
  'createOrderLink',
  'find_shops',
];
const X402_ONLY_TOOL_NAMES = [
  'x402_pay',
  'order_quote',
  'discovery_search',
  'x402_quote',
  'search_shops',
];
// 0.8.0 の既存 7 ツールは個別 JSON byte を固定し、0.9.0 はその末尾へ 2 ツールだけを追加する。
const V080_TOOL_WIRE_SHA256_BY_NAME: Record<string, string> = {
  discovery_search: '1ce53ff7e79c852648523c001bd24d80f058ba301f8447929fbb0a6efdb4bc2c',
  x402_quote: 'bb80a4c7bdaa1751437ad8d7cd86268091a23becac5a06001cbaa6fcd149c6f4',
  x402_pay: 'a2c601b6c390236a99b21d8282bb1fcdbbb0655aabe6d2fcb5a05d1d349fe59e',
  order_menu: '673539c538de4eeba81d58b515bbbcf370b56b8fad26b036c4a0cfd2495a23bb',
  order_quote: 'a0f961d3da2f0eaea6b6c52716eacd4203d27da74663617321315826a25e6c00',
  order_summary: '7059d06856221798c0038c359db74bc63682ad306f11d72b602bcb3527b7d6b1',
  createOrderLink: 'b11cc5e7b90aa7454c5c98863f328aec1751bdc116cab6ff4d3b3911cb5d3747',
};
const X402_V090_TOOLS_WIRE_SHA256 =
  'f4f7c69c2a150e55d5dc4f2e31cf83b0e17c4c34989317f3f03a1a3b2fc34de4';

async function loadTools(): Promise<ToolsModule> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs')).href
  )) as ToolsModule;
}

function parsedText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe('x402-mcp tool profiles', () => {
  it('profile 未指定 / x402 は既存7 byte不変の末尾に2ツールを追加する', async () => {
    const { TOOLS, createToolRuntime } = await loadTools();
    const implicit = createToolRuntime({ env: {} });
    const explicit = createToolRuntime({ profile: 'x402', env: {} });

    expect(implicit.tools.map((tool) => tool.name)).toEqual(X402_TOOL_NAMES);
    expect(explicit.tools).toEqual(implicit.tools);
    expect(implicit.tools).toEqual(TOOLS);
    expect(
      createHash('sha256').update(JSON.stringify(implicit.tools)).digest('hex'),
    ).toBe(X402_V090_TOOLS_WIRE_SHA256);
    for (const tool of implicit.tools.slice(0, 7)) {
      expect(
        createHash('sha256').update(JSON.stringify(tool)).digest('hex'),
      ).toBe(V080_TOOL_WIRE_SHA256_BY_NAME[tool.name]);
    }
    for (const tool of [...TOOLS, ...implicit.tools, ...explicit.tools]) {
      expect(tool).not.toHaveProperty('profiles');
    }
  });

  it('order は鍵なしで起動し、find を末尾追加した4ツールを同順で公開する', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ profile: 'order', env: {} });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(ORDER_TOOL_NAMES);
    for (const tool of runtime.tools) expect(tool).not.toHaveProperty('profiles');
  });

  it('不正 profile は起動時に throw する', async () => {
    const { createToolRuntime } = await loadTools();
    expect(() => createToolRuntime({ profile: 'invalid', env: {} })).toThrow(
      /invalid profile/,
    );
  });

  it.each(X402_ONLY_TOOL_NAMES)(
    'order の callTool(%s) は dispatch 前に拒否し fetch / 署名処理へ到達しない',
    async (name) => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('profile 外の tool は fetch してはならない');
      });
      const { createToolRuntime } = await loadTools();
      const runtime = createToolRuntime({
        profile: 'order',
        env: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const result = await runtime.callTool(name, {});

      expect(result.isError).toBe(true);
      expect(parsedText(result)).toEqual({
        ok: false,
        error: 'tool_not_in_profile',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('未知 tool は既存 unknown tool エラーを維持する', async () => {
    const { createToolRuntime } = await loadTools();
    const runtime = createToolRuntime({ profile: 'order', env: {} });

    const result = await runtime.callTool('not_a_tool', {});

    expect(result.isError).toBe(true);
    expect(parsedText(result)).toEqual({
      ok: false,
      error: 'unknown tool: not_a_tool',
    });
  });
});
