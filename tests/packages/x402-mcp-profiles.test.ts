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
];
const ORDER_TOOL_NAMES = ['order_menu', 'order_summary', 'createOrderLink'];
const X402_ONLY_TOOL_NAMES = [
  'x402_pay',
  'order_quote',
  'discovery_search',
  'x402_quote',
];
// 0.7.2 の公開 TOOLS (順序/name/description/inputSchema) の wire fingerprint。
const X402_TOOLS_WIRE_SHA256 =
  'e46247d2655dbda8d7e51d3acadd5cfb3f153d1d9f3fe2cb2962af8a2461c7e7';

async function loadTools(): Promise<ToolsModule> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs')).href
  )) as ToolsModule;
}

function parsedText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe('x402-mcp tool profiles', () => {
  it('profile 未指定 / x402 は旧 7 ツールを同順・同 wire 形状で公開する', async () => {
    const { TOOLS, createToolRuntime } = await loadTools();
    const implicit = createToolRuntime({ env: {} });
    const explicit = createToolRuntime({ profile: 'x402', env: {} });

    expect(implicit.tools.map((tool) => tool.name)).toEqual(X402_TOOL_NAMES);
    expect(explicit.tools).toEqual(implicit.tools);
    expect(implicit.tools).toEqual(TOOLS);
    expect(
      createHash('sha256').update(JSON.stringify(implicit.tools)).digest('hex'),
    ).toBe(X402_TOOLS_WIRE_SHA256);
    for (const tool of [...TOOLS, ...implicit.tools, ...explicit.tools]) {
      expect(tool).not.toHaveProperty('profiles');
    }
  });

  it('order は鍵なしで起動し、人払い 3 ツールだけを同順で公開する', async () => {
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
