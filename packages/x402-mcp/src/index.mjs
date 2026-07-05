#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createToolRuntime } from './tools.mjs';
import { safeErrorMessage } from './guards.mjs';

const pkg = createRequire(import.meta.url)('../package.json');

export function createServer(runtime = createToolRuntime()) {
  const server = new Server(
    { name: 'openpay-x402-mcp', version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runtime.tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    runtime.callTool(request.params.name, request.params.arguments ?? {}),
  );

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// npm/npx の bin はシンボリックリンク経由で起動されるため、argv[1] (リンクのパス) と
// import.meta.url (実体のパス) の素朴な比較では一致せず main() が走らない (exit 0 の即死)。
// realpath でリンクを実体に解決してから比較する。
function isDirectInvocation() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return pathToFileURL(realpathSync(invoked)).href === import.meta.url;
  } catch {
    return pathToFileURL(invoked).href === import.meta.url;
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
