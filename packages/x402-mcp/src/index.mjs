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
import { safeErrorMessage } from 'openpay-x402-sdk';
import { createToolRuntime } from './tools.mjs';

const pkg = createRequire(import.meta.url)('../package.json');

function serverNameForProfile(profile) {
  if (profile === 'x402') return 'openpay-x402-mcp';
  if (profile === 'order') return 'openpay-order-mcp';
  throw new Error(`invalid profile: ${profile}`);
}

export function createServer(profile = 'x402', runtime) {
  const activeRuntime = runtime ?? createToolRuntime({ profile });
  const server = new Server(
    { name: serverNameForProfile(profile), version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeRuntime.tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    activeRuntime.callTool(request.params.name, request.params.arguments ?? {}),
  );

  return server;
}

export async function main(profile = 'x402') {
  const server = createServer(profile);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function run(profile = 'x402') {
  try {
    await main(profile);
  } catch (error) {
    // P2-Q: 起動失敗時の redaction を無力化させない。config 無しだと safeErrorMessage は署名 hex の
    // 正規表現置換しか効かず、秘密値 (BUYER_PRIVATE_KEY / STEWARD_API_KEY / STEWARD_SIGNER_SECRET) の
    // 文字列置換が no-op になる。process.env から best-effort に redaction 対象を渡す。
    console.error(
      safeErrorMessage(error, {
        buyerPrivateKey: process.env.BUYER_PRIVATE_KEY ?? null,
        stewardApiKey: process.env.STEWARD_API_KEY ?? null,
        stewardSignerSecret: process.env.STEWARD_SIGNER_SECRET ?? null,
      }),
    );
    process.exitCode = 1;
  }
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
  run();
}
