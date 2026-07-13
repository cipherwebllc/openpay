// 2 本の bin を実 entry から起動し、initialize / tools/list / tools/call の wire を検証する。
// npm pack の files も確認し、追加した order entry の publish 漏れを防ぐ。

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: unknown;
};

type Pending = {
  resolve: (message: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PACKAGE_DIR = resolve(process.cwd(), 'packages/x402-mcp');
const PROFILES = [
  {
    profile: 'x402',
    bin: 'openpay-x402-mcp',
    entry: resolve(PACKAGE_DIR, 'src/index.mjs'),
    toolNames: [
      'discovery_search',
      'x402_quote',
      'x402_pay',
      'order_menu',
      'order_quote',
      'order_summary',
      'createOrderLink',
      'find_shops',
      'search_shops',
    ],
  },
  {
    profile: 'order',
    bin: 'openpay-order-mcp',
    entry: resolve(PACKAGE_DIR, 'src/order.mjs'),
    toolNames: [
      'order_menu',
      'order_summary',
      'createOrderLink',
      'find_shops',
    ],
  },
] as const;

function startRpc(entry: string) {
  const proc = spawn(process.execPath, [entry], {
    cwd: PACKAGE_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, Pending>();
  let buffer = '';
  let stderr = '';

  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcResponse;
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  proc.on('exit', (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`process exited early (code=${code}): ${stderr || 'no stderr'}`),
      );
    }
    pending.clear();
  });

  function request(id: number, method: string, params: unknown): Promise<RpcResponse> {
    const response = new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`no ${method} response within 15s: ${stderr || 'no stderr'}`));
      }, 15_000);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  function notify(method: string): void {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  return { proc, request, notify };
}

function stop(proc: ChildProcessWithoutNullStreams): void {
  proc.kill();
}

describe('x402-mcp entrypoints', () => {
  it.each(PROFILES)(
    '$bin は $entry を node 直接起動して serverInfo と tools/list を返す',
    async ({ bin, entry, toolNames, profile }) => {
      const rpc = startRpc(entry);
      try {
        const initialized = await rpc.request(0, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        });
        const initResult = initialized.result as {
          serverInfo?: { name?: string; version?: string };
        };
        expect(initResult.serverInfo?.name).toBe(bin);
        const pkg = await import('../../packages/x402-mcp/package.json');
        expect(initResult.serverInfo?.version).toBe(pkg.default.version);

        rpc.notify('notifications/initialized');
        const listed = await rpc.request(1, 'tools/list', {});
        const listResult = listed.result as { tools: Array<{ name: string }> };
        expect(listResult.tools.map((tool) => tool.name)).toEqual(toolNames);

        if (profile === 'order') {
          const called = await rpc.request(2, 'tools/call', {
            name: 'x402_pay',
            arguments: {
              url: 'https://open-pay.jp/api/paid/demo',
              maxTotalJpyc: '2',
            },
          });
          const callResult = called.result as {
            isError?: boolean;
            content: Array<{ text: string }>;
          };
          expect(callResult.isError).toBe(true);
          expect(JSON.parse(callResult.content[0].text)).toEqual({
            ok: false,
            error: 'tool_not_in_profile',
          });
        }
      } finally {
        stop(rpc.proc);
      }
    },
    30_000,
  );

  it.each(PROFILES)(
    '$bin は npm/npx 同様の symlink 経由でも起動する',
    async ({ bin, entry }) => {
      const dir = mkdtempSync(join(tmpdir(), 'x402-mcp-bin-'));
      const link = join(dir, bin);
      symlinkSync(entry, link);
      const rpc = startRpc(link);
      try {
        const initialized = await rpc.request(0, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        });
        const initResult = initialized.result as {
          serverInfo?: { name?: string };
        };
        expect(initResult.serverInfo?.name).toBe(bin);
      } finally {
        stop(rpc.proc);
      }
    },
    30_000,
  );

  it('npm pack --dry-run に src/order.mjs と両 bin metadata が入る', () => {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
    });
    expect(packed.status, packed.stderr).toBe(0);
    const manifest = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    expect(manifest[0].files.map((file) => file.path)).toContain('src/order.mjs');

    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin).toEqual({
      'openpay-x402-mcp': 'src/index.mjs',
      'openpay-order-mcp': 'src/order.mjs',
    });
  });
});
