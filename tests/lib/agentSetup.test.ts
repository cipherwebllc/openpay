import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
// @ts-expect-error The SDK source of truth is JavaScript without declarations.
import { DEFAULT_MAX_PER_CALL_JPYC, DEFAULT_MAX_SESSION_JPYC, DEFAULT_ALLOWED_HOSTS, DEFAULT_CATALOG_TRUST, readMoneyConfig } from '../../packages/x402-sdk/src/guards.mjs';
// @ts-expect-error The MCP source of truth is JavaScript without declarations.
import { createToolRuntime } from '../../packages/x402-mcp/src/tools.mjs';
import { buildOpenInLink, AGENT_MCP_PACKAGE, AGENT_MCP_SPEC, AGENT_MCP_VERSION, AGENT_CLIENTS, AGENT_MODES, AGENT_LIMIT_DEFAULTS, AGENT_SETUP_URL, DEFAULT_AGENT_CONFIG_INPUT, buildAgentEnv, buildSetupPrompt, invalidAgentConfigFields, renderAgentConfig } from '@/lib/agentSetup';

const KOVA_INPUT = {
  ...DEFAULT_AGENT_CONFIG_INPUT,
  kovaWallet: 'agent.wallet_1-2',
  kovaAgentAddress: '0x52908400098527886E0F7030069857D2E4169EE7',
  maxDailyJpyc: '300',
};

describe('agent setup — package fences', () => {
  it('generated invocations name bins that the MCP package really ships', () => {
    const pkg = JSON.parse(readFileSync('packages/x402-mcp/package.json', 'utf8'));
    expect(pkg.name).toBe(AGENT_MCP_PACKAGE);
    // Kova を選べる Web と公開準備中の MCP の minor を揃える (npm publish は Web 公開前)。
    expect(AGENT_MCP_VERSION).toBe(pkg.version.split('.').slice(0, 2).join('.'));
    expect(AGENT_MCP_SPEC).toBe(`${AGENT_MCP_PACKAGE}@${AGENT_MCP_VERSION}`);
    expect(Object.keys(pkg.bin)).toEqual(expect.arrayContaining([AGENT_MCP_PACKAGE, 'openpay-order-mcp']));
    expect(renderAgentConfig('claude-code', 'human-pays', DEFAULT_AGENT_CONFIG_INPUT)).toContain('openpay-order-mcp');
  });
  // setup.md と keyNote の前提: 鍵なしの生成 env で MCP は起動でき、プレースホルダ鍵では起動時に落ちる。
  it('the MCP runtime starts with the generated env and rejects a placeholder key', () => {
    // keystore は起動時にウォレットを読む。開発機の本物の ~/.openpay-x402 を読まないよう隔離する。
    const env = { ...Object.fromEntries(buildAgentEnv(DEFAULT_AGENT_CONFIG_INPUT)), OPENPAY_X402_HOME: mkdtempSync(join(tmpdir(), 'openpay-agent-setup-')) };
    expect(() => createToolRuntime({ env })).not.toThrow();
    expect(() => createToolRuntime({ env: { ...env, BUYER_PRIVATE_KEY: '0x...' } })).toThrow(/BUYER_PRIVATE_KEY/);
    expect(() => createToolRuntime({ env: { ...env, SIGNER_MODE: 'steward' } })).toThrow(/steward/);
  });
});

describe('agent setup — open-in deep links', () => {
  it.each(['ja', 'en'])('round-trips the %s prompt and stays inside the Claude handler limits', (locale) => {
    const prompt = buildSetupPrompt(locale);
    const claude = new URL(buildOpenInLink('claude', prompt));
    expect(`${claude.protocol}//${claude.host}${claude.pathname}`).toBe('claude://code/new');
    expect(claude.searchParams.get('q')).toBe(prompt);
    const codex = new URL(buildOpenInLink('codex', prompt));
    expect(`${codex.protocol}//${codex.host}${codex.pathname}`).toBe('codex://threads/new');
    expect(codex.searchParams.get('prompt')).toBe(prompt);
    // Claude の URL handler は q を 14,336 字で切り、`/` 始まり (slash command) を拒否する。
    expect(prompt.length).toBeLessThan(14336);
    expect(prompt.startsWith('/')).toBe(false);
  });
});

describe('agent setup', () => {
  it('keeps defaults in sync with SDK guards', () => {
    expect(AGENT_LIMIT_DEFAULTS).toEqual({ maxPerCallJpyc: DEFAULT_MAX_PER_CALL_JPYC, maxSessionJpyc: DEFAULT_MAX_SESSION_JPYC, allowedHosts: DEFAULT_ALLOWED_HOSTS, catalogTrust: DEFAULT_CATALOG_TRUST });
  });
  it.each([DEFAULT_AGENT_CONFIG_INPUT, { ...DEFAULT_AGENT_CONFIG_INPUT, maxPerCallJpyc: '0.000000000000000001', maxSessionJpyc: '20.5', maxDailyJpyc: '100', allowedHosts: 'EXAMPLE.COM,open-pay.jp,example.com', catalogTrust: false }])('round trips generated env through readMoneyConfig', (input) => {
    const config = readMoneyConfig(Object.fromEntries(buildAgentEnv(input)));
    expect(config.maxPerCallAtomic).toBe(parseUnits(input.maxPerCallJpyc, 18));
    expect(config.maxSessionAtomic).toBe(parseUnits(input.maxSessionJpyc, 18));
    expect(config.maxDailyAtomic).toBe(input.maxDailyJpyc ? parseUnits(input.maxDailyJpyc, 18) : null);
    expect(config.allowedHosts).toEqual([...new Set(input.allowedHosts.toLowerCase().split(','))]);
    expect(config.catalogTrust).toBe(input.catalogTrust);
    expect(config.buyerPrivateKey).toBeNull();
  });
  for (const client of AGENT_CLIENTS) for (const mode of AGENT_MODES) {
    it(`${client} / ${mode} produces a keyless config in the host format`, () => {
      const input = mode === 'agent-pays-kova' ? KOVA_INPUT : DEFAULT_AGENT_CONFIG_INPUT;
      const output = renderAgentConfig(client, mode, input);
      expect(output).not.toMatch(/PRIVATE_KEY|STEWARD|KOVA_CREDENTIAL/);
      const server = mode === 'human-pays' ? 'openpay-order' : 'openpay-x402';
      expect(output).toContain(server);
      if (mode === 'human-pays') expect(output).not.toMatch(/SIGNER_MODE|MAX_|ALLOWED_HOSTS|CATALOG_TRUST|\benv\b/);
      // Agent が払う設定は keystore を明示する (鍵は MCP が手元で作る・人が env に貼る手順を作らない)。
      if (mode === 'agent-pays') expect(output).toMatch(/SIGNER_MODE\W+keystore/);
      if (mode === 'agent-pays-kova') {
        expect(output).toMatch(/SIGNER_MODE\W+kova/);
        expect(output).toContain('KOVA_WALLET');
        expect(output).toContain(input.kovaWallet);
        expect(output).toContain('KOVA_AGENT_ADDRESS');
        expect(output).toContain(input.kovaAgentAddress);
      } else expect(output).not.toMatch(/KOVA_|0x/);
      if (client === 'claude-desktop') {
        const entry = JSON.parse(output).mcpServers[server];
        expect(entry.command).toBe('npx');
        expect(entry.args).toEqual(mode !== 'human-pays' ? ['--yes', AGENT_MCP_SPEC] : ['--yes', `--package=${AGENT_MCP_SPEC}`, '--', 'openpay-order-mcp']);
        expect(entry.env).toEqual(mode !== 'human-pays' ? Object.fromEntries(buildAgentEnv(input, mode)) : undefined);
      } else if (client === 'codex') {
        expect(output).toContain(`[mcp_servers.${server}]`);
        expect(output).toContain('command = "npx"');
        expect(output.includes(`[mcp_servers.${server}.env]`)).toBe(mode !== 'human-pays');
      } else if (client === 'hermes') {
        expect(output.split(' --args ')).toHaveLength(2);
        expect(output.split(' --args ')[1]).toBe(mode !== 'human-pays' ? `--yes ${AGENT_MCP_SPEC}` : `--yes --package=${AGENT_MCP_SPEC} -- openpay-order-mcp`);
      } else {
        expect(output).toMatch(/^claude mcp add /);
        expect(output).toContain(' -- npx --yes');
      }
    });
  }
  it('generates only public Kova configuration and the configured local limits', () => {
    expect(Object.fromEntries(buildAgentEnv({ ...KOVA_INPUT, allowedHosts: 'EXAMPLE.COM,open-pay.jp', catalogTrust: false }, 'agent-pays-kova'))).toEqual({
      SIGNER_MODE: 'kova',
      KOVA_WALLET: KOVA_INPUT.kovaWallet,
      KOVA_AGENT_ADDRESS: KOVA_INPUT.kovaAgentAddress,
      MAX_PER_CALL_JPYC: '10',
      MAX_SESSION_JPYC: '100',
      MAX_DAILY_JPYC: '300',
      ALLOWED_HOSTS: 'example.com,open-pay.jp',
      CATALOG_TRUST: 'false',
    });
  });
  it.each(['', '0x1234', '0x52908400098527886E0F7030069857D2E4169Ee7', '0x' + 'g'.repeat(40)])('rejects an invalid Kova address: %s', (kovaAgentAddress) => {
    const input = { ...KOVA_INPUT, kovaAgentAddress };
    expect(invalidAgentConfigFields(input, 'agent-pays-kova')).toContain('kovaAgentAddress');
    for (const client of AGENT_CLIENTS) expect(() => renderAgentConfig(client, 'agent-pays-kova', input)).toThrow('agent config input is invalid');
  });
  it.each([KOVA_INPUT.kovaAgentAddress, KOVA_INPUT.kovaAgentAddress.toLowerCase()])('accepts a public EVM address: %s', (kovaAgentAddress) => {
    expect(invalidAgentConfigFields({ ...KOVA_INPUT, kovaAgentAddress }, 'agent-pays-kova')).toEqual([]);
  });
  it.each(['', ' ', 'wallet name', 'wallet/name', '$(id)', 'wallet\n'])('rejects an invalid Kova wallet name: %s', (kovaWallet) => {
    const input = { ...KOVA_INPUT, kovaWallet };
    expect(invalidAgentConfigFields(input, 'agent-pays-kova')).toContain('kovaWallet');
    expect(() => buildAgentEnv(input, 'agent-pays-kova')).toThrow('agent config input is invalid');
    expect(invalidAgentConfigFields(input, 'agent-pays')).toEqual([]);
    expect(renderAgentConfig('claude-code', 'human-pays', input)).not.toMatch(/KOVA_|SIGNER_MODE/);
  });
  it.each(['0', '-1', '1.0000000000000000001', '', '1e2'])('rejects invalid required limits: %s', (value) => {
    for (const field of ['maxPerCallJpyc', 'maxSessionJpyc'] as const) {
      const input = { ...DEFAULT_AGENT_CONFIG_INPUT, [field]: value };
      expect(invalidAgentConfigFields(input)).toContain(field);
      expect(() => buildAgentEnv(input)).toThrow('agent config input is invalid');
    }
    if (value) expect(invalidAgentConfigFields({ ...DEFAULT_AGENT_CONFIG_INPUT, maxDailyJpyc: value })).toContain('maxDailyJpyc');
  });
  it.each(['https://open-pay.jp', '', ', ,', 'example.com/path', 'user@example.com', 'example.com:8080'])('rejects invalid hosts: %s', (allowedHosts) => {
    expect(invalidAgentConfigFields({ ...DEFAULT_AGENT_CONFIG_INPUT, allowedHosts })).toContain('allowedHosts');
  });
  it.each(['claude-code', 'hermes'] as const)('preserves shell metacharacters as literal arguments for %s', (client) => {
    // The stub only prints argv. If shell substitution executes, the expected literal changes.
    const allowedHosts = "$(id).example.com,`id`.example.com,example.com;printf,example'host.com";
    const output = renderAgentConfig(client, 'agent-pays', { ...DEFAULT_AGENT_CONFIG_INPUT, allowedHosts });
    const stub = 'id() { printf injected; }; claude() { printf \'%s\\n\' "$@"; }; hermes() { printf \'%s\\n\' "$@"; };\n';
    const args = execFileSync('/bin/sh', ['-c', stub + output], { encoding: 'utf8' }).split('\n');
    expect(args).toContain(`ALLOWED_HOSTS=${allowedHosts}`);
  });
  it.each(['ja', 'en'])('includes the setup URL and key prohibition in %s prompt', (locale) => {
    const prompt = buildSetupPrompt(locale);
    expect(prompt).toContain(AGENT_SETUP_URL);
    expect(prompt).toMatch(locale === 'ja' ? /秘密鍵を私に尋ねない/ : /Never ask me for a private key/);
  });
});
