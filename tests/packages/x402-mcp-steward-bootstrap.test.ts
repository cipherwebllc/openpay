// steward-bootstrap の入力バリデーションを子プロセスで検証 (ネットワーク非依存)。
// 本体フローは実 Steward 相手のライブ検証で担保 (README/plan 参照)。

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(
  process.cwd(),
  'packages/x402-mcp/scripts/steward-bootstrap.mjs',
);

function run(env: Record<string, string>) {
  return spawnSync('node', [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

describe('steward-bootstrap input validation', () => {
  it('exits non-zero without STEWARD_PLATFORM_KEY', () => {
    const r = run({ STEWARD_PLATFORM_KEY: '', OWNER_PRIVATE_KEY: '0x' + '11'.repeat(32) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/STEWARD_PLATFORM_KEY is required/);
  });

  it('exits non-zero with a malformed OWNER_PRIVATE_KEY', () => {
    const r = run({ STEWARD_PLATFORM_KEY: 'k', OWNER_PRIVATE_KEY: 'not-hex' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OWNER_PRIVATE_KEY must be/);
  });
});
