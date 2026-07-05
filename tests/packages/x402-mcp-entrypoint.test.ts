// npx/npm の bin はシンボリックリンク経由で起動される。素朴な argv[1] 比較の main ガードは
// リンクと実体のパス不一致で main() が走らず「exit 0 の即死」になる (0.1.0/0.2.0 で実害)。
// リンク経由起動で MCP initialize が返ることを回帰テストする。

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRY = resolve(process.cwd(), 'packages/x402-mcp/src/index.mjs');

describe('x402-mcp entrypoint', () => {
  it('starts and answers initialize when invoked via a symlink (npx simulation)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x402-mcp-bin-'));
    const link = join(dir, 'openpay-x402-mcp');
    symlinkSync(ENTRY, link);

    const proc = spawn('node', [link], {
      cwd: resolve(process.cwd(), 'packages/x402-mcp'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    proc.stdin.write(init + '\n');

    const firstLine = await new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('no response within 15s')), 15_000);
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          resolvePromise(buf.slice(0, nl));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`process exited early (code=${code}) — entrypoint guard regression`));
      });
    }).finally(() => proc.kill());

    const parsed = JSON.parse(firstLine) as {
      result?: { serverInfo?: { name?: string; version?: string } };
    };
    expect(parsed.result?.serverInfo?.name).toBe('openpay-x402-mcp');
    // Server の version は package.json と一致する (ハードコード剥がれの回帰も兼ねる)。
    const pkg = await import('../../packages/x402-mcp/package.json');
    expect(parsed.result?.serverInfo?.version).toBe(pkg.default.version);
  }, 30_000);
});
