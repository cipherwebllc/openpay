#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/index.mjs'],
  env: process.env,
});

const client = new Client(
  { name: 'openpay-x402-mcp-smoke', version: '0.1.0' },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const result = await client.listTools();
  console.log(
    JSON.stringify(
      {
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
  // P2-Q: ツールは discovery_search / x402_quote / x402_pay / order_menu / order_quote の 5 個
  // (order 系追加後も 3 のままで常に fail していた陳腐化した canary を是正)。
  if (result.tools.length !== 5) {
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
