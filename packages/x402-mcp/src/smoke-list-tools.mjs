#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const profile = process.argv[2] ?? 'x402';
const profiles = {
  order: { entry: 'src/order.mjs', expectedToolCount: 3 },
  x402: { entry: 'src/index.mjs', expectedToolCount: 7 },
};
const selected = profiles[profile];
if (!selected) {
  throw new Error(`invalid profile: ${profile}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [selected.entry],
  env: process.env,
});

const client = new Client(
  { name: `openpay-${profile}-mcp-smoke`, version: '0.8.0' },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const result = await client.listTools();
  console.log(
    JSON.stringify(
      {
        profile,
        method: 'tools/list',
        toolCount: result.tools.length,
        toolNames: result.tools.map((tool) => tool.name),
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      },
      null,
      2,
    ),
  );
  // x402 は後方互換の 7 ツール、order は鍵なし人払いの 3 ツールを公開する。
  if (result.tools.length !== selected.expectedToolCount) {
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
