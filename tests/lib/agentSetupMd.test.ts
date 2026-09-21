import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DISCLOSED_X402_FEE } from '@/lib/legal';
// @ts-expect-error The SDK source of truth is JavaScript without declarations.
import { DEFAULT_MAX_PER_CALL_JPYC, DEFAULT_MAX_SESSION_JPYC, DEFAULT_ALLOWED_HOSTS, DEFAULT_CATALOG_TRUST, DEFAULT_MAX_TIMEOUT_SECONDS } from '../../packages/x402-sdk/src/guards.mjs';

const md = readFileSync('public/agent/setup.md', 'utf8');
describe('agent setup document drift fences', () => {
  it('matches the SDK defaults table', () => {
    for (const [key, value] of Object.entries({ MAX_PER_CALL_JPYC: DEFAULT_MAX_PER_CALL_JPYC, MAX_SESSION_JPYC: DEFAULT_MAX_SESSION_JPYC, ALLOWED_HOSTS: DEFAULT_ALLOWED_HOSTS, CATALOG_TRUST: DEFAULT_CATALOG_TRUST, MAX_TIMEOUT_SECONDS: DEFAULT_MAX_TIMEOUT_SECONDS })) {
      expect(md).toContain(`| \`${key}\` | \`${value}\` |`);
    }
    expect(md).toContain('| `MAX_DAILY_JPYC` | unset (no daily cap) |');
  });
  it('discloses the canonical x402 fee', () => {
    expect(md).toContain(`${DISCLOSED_X402_FEE.bps / 100}%`);
    expect(md).toContain(`minimum ${DISCLOSED_X402_FEE.floorJpyc} JPYC`);
  });
  it('references real MCP tools and contains no key-bearing execution example', () => {
    const source = readFileSync('packages/x402-mcp/src/tools.mjs', 'utf8');
    for (const tool of ['discovery_search', 'x402_quote', 'x402_pay', 'find_shops', 'wallet_init', 'wallet_status']) {
      expect(md).toContain(`\`${tool}\``);
      expect(source).toContain(`name: '${tool}'`);
    }
    expect(md).not.toMatch(/(?:BUYER_PRIVATE_KEY|OWNER_PRIVATE_KEY)\s*[=:]\s*["']?0x/);
    expect(md).toContain('Do not call `x402_pay`, `search_shops`');
  });
  it('uses the Polygon mainnet JPYC deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
    vi.resetModules();
    try {
      const { resolveDeployment } = await import('@/lib/tokens');
      const deployment = resolveDeployment('jpyc', 137);
      expect(deployment).toBeDefined();
      expect(md).toContain(deployment!.address);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it('registers the keystore signer with the pinned package version, and never a key', async () => {
    const { AGENT_MCP_SPEC } = await import('@/lib/agentSetup');
    // 全ての登録例が版固定の spec を使う (無固定の npx を残さない)。
    const specs = md.match(/openpay-x402-mcp@[0-9.]+/g) ?? [];
    expect(specs.length).toBeGreaterThanOrEqual(5);
    expect(new Set(specs)).toEqual(new Set([AGENT_MCP_SPEC]));
    expect(md).not.toMatch(/npx (?:--yes |-y )?openpay-x402-mcp(?!@)/);
    expect(md.match(/SIGNER_MODE\W+keystore/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // 壊れたウォレットを消させない・復元できないことを必ず伝える。
    expect(md).toContain('do not delete or rewrite the file');
    expect(md).toContain('never receives, stores, or can recover this key');
    const guards = readFileSync('packages/x402-mcp/src/tools.mjs', 'utf8');
    expect(guards).toContain('wallet_not_initialized');
    expect(md).toContain('`wallet_not_initialized`');
  });
});
