// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentProofTypedData, parseAgentProof } from '@/lib/agent/proof';

type Result = { ok: boolean; error?: string; address: Address; bindUrl: string; expiresAt: number; note: string };
type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type Runtime = {
  tools: Array<{ name: string; inputSchema: unknown }>;
  callTool: (name: string, args: unknown) => Promise<ToolResult>;
  walletInit: (args: unknown) => Promise<{ address: Address }>;
};
type TypedData = ReturnType<typeof agentProofTypedData>;
type Signer = { address: Address; signTypedData: (data: TypedData) => Promise<Hex> };
const { createToolRuntime } = await import(pathToFileURL(resolve('packages/x402-mcp/src/tools.mjs')).href) as {
  createToolRuntime: (options: Record<string, unknown>) => Runtime;
};
const { proveWallet } = await import(pathToFileURL(resolve('packages/x402-mcp/src/prove.mjs')).href) as {
  proveWallet: (options: {
    signer: Signer; origin: string; fetchImpl: typeof fetch;
    lookup: typeof lookup; nowSec: () => number;
  }) => Promise<Result>;
};
const key = `0x${'11'.repeat(32)}` as Hex;
const account = privateKeyToAccount(key);
const now = 1_800_000_000;
const nonce = `0x${'ab'.repeat(32)}` as Hex;
const challenge = { nonce, issuedAt: now, expiresAt: now + 300 };
const origin = 'https://open-pay.jp';
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const decode = (result: ToolResult) => JSON.parse(result.content[0].text) as Result;
let home: string;
let directory: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-prove-'));
  directory = join(home, 'wallet');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function runtime(fetchImpl = vi.fn(async () => json(challenge)), env = {}, extra = {}) {
  return createToolRuntime({
    env: { HOME: home, OPENPAY_X402_HOME: directory, BUYER_PRIVATE_KEY: key, ...env },
    fetchImpl, lookup, nowSec: () => now, ...extra,
  });
}
function prove(fetchImpl: typeof fetch, signer: Signer, nowSec = () => now) {
  return proveWallet({ signer, origin, fetchImpl, lookup, nowSec });
}
async function verify(result: Result, expected: Address, expectedChallenge = challenge, expectedOrigin = origin) {
  expect(result.ok).toBe(true);
  expect(Object.keys(result).sort()).toEqual(['address', 'bindUrl', 'expiresAt', 'note', 'ok']);
  const url = new URL(result.bindUrl);
  expect(url.origin).toBe(expectedOrigin);
  expect(url.pathname).toBe('/agent');
  expect(url.search).toBe(`?address=${expected}`);
  expect(url.hash).toMatch(/^#proof=[A-Za-z0-9_-]+$/);
  const encoded = url.hash.slice('#proof='.length);
  expect(encoded).not.toContain('=');
  const proof = parseAgentProof(encoded);
  expect(proof).not.toBeNull();
  if (!proof) throw new Error('server rejected the proof');
  expect(Object.keys(JSON.parse(Buffer.from(encoded, 'base64url').toString())).sort()).toEqual(['address', 'nonce', 'signature', 'v']);
  expect(proof.nonce).toBe(expectedChallenge.nonce.toLowerCase());
  expect(proof.address).toBe(expected.toLowerCase());
  const recovered = await recoverTypedDataAddress({
    ...agentProofTypedData(proof.address, expectedChallenge), signature: proof.signature,
  });
  expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  expect(result.address).toBe(expected);
  expect(result.expiresAt).toBe(expectedChallenge.expiresAt);
  expect(JSON.stringify(result)).not.toContain(proof.signature);
  expect(JSON.stringify(result)).not.toContain(proof.nonce);
  expect(JSON.stringify(result)).not.toContain(key);
}

describe('wallet_prove', () => {
  it('signs the server-compatible proof in env-key mode and returns only the fragment envelope', async () => {
    const fetchImpl = vi.fn(async () => json(challenge));
    const active = runtime(fetchImpl);
    expect(active.tools.find((tool) => tool.name === 'wallet_prove')?.inputSchema).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    });
    const result = decode(await active.callTool('wallet_prove', {}));
    await verify(result, account.address);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${origin}/api/agent/proof/challenge?address=${account.address}`, expect.objectContaining({
      headers: { accept: 'application/json' }, redirect: 'manual', signal: expect.any(AbortSignal),
    }));
    // The SDK's injected transport uses fetch's default GET; no body, credentials or payment header.
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    for (const text of ['5 minutes', 'only once', 'SIWE', 'Do not forward', 'overwriting', 'funds or keys', '400 days after the last record', 'wallet_history']) {
      expect(result.note).toContain(text);
    }
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the configured discovery origin but keeps the server audience fixed', async () => {
    const customOrigin = 'https://purchase.example';
    const fetchImpl = vi.fn(async () => json(challenge));
    const result = decode(await runtime(fetchImpl, { DISCOVERY_URL: `${customOrigin}/discovery?ignored=1` }).callTool('wallet_prove', {}));
    await verify(result, account.address, challenge, customOrigin);
    expect(fetchImpl).toHaveBeenCalledWith(`${customOrigin}/api/agent/proof/challenge?address=${account.address}`, expect.anything());
  });

  it('uses a newly initialized keystore immediately and creates no purchase or spend records', async () => {
    const active = runtime(undefined, { SIGNER_MODE: 'keystore' });
    const wallet = await active.walletInit({});
    const result = decode(await active.callTool('wallet_prove', {}));
    await verify(result, wallet.address);
    expect(result.address).not.toBe(account.address); // Stray environment key is never selected.
    expect(await readdir(directory)).toEqual(['wallet.json']);
  });

  it('serializes proof creation with wallet reinitialization', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; started(); }));
    const active = runtime(fetchImpl, { SIGNER_MODE: 'keystore' });
    const initial = await active.walletInit({});
    const pendingProof = active.callTool('wallet_prove', {});
    await fetching;
    let initialized = false;
    const pendingInit = active.walletInit({}).then(() => { initialized = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(initialized).toBe(false);
    release(json(challenge));
    await verify(decode(await pendingProof), initial.address);
    await pendingInit;
    expect(initialized).toBe(true);
  });

  it.each([-120, 0, 120])('accepts the inclusive clock boundary %i with a real signature', async (offset) => {
    const shifted = { ...challenge, issuedAt: now + offset, expiresAt: now + offset + 300 };
    const signer = { address: account.address, signTypedData: vi.fn((data: TypedData) => account.signTypedData(data)) };
    const result = await prove(vi.fn(async () => json(shifted)), signer);
    await verify(result, account.address, shifted);
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(signer.signTypedData).toHaveBeenCalledWith(agentProofTypedData(account.address, shifted));
  });

  it.each([
    ['types injection', { ...challenge, types: { Proof: [{ name: 'value', type: 'uint256' }] } }],
    ['domain injection', { ...challenge, domain: { chainId: 1 } }],
    ['audience injection', { ...challenge, audience: 'https://attacker.example' }],
    ['purpose injection', { ...challenge, purpose: 'transfer' }],
    ['address injection', { ...challenge, address: account.address }],
    ['old timestamp', { ...challenge, issuedAt: now - 121, expiresAt: now + 179 }],
    ['future timestamp', { ...challenge, issuedAt: now + 121, expiresAt: now + 421 }],
    ['wrong TTL', { ...challenge, expiresAt: now + 301 }],
    ['fractional seconds', { ...challenge, issuedAt: now + 0.5, expiresAt: now + 300.5 }],
    ['string timestamp', { ...challenge, issuedAt: String(now) }],
    ['milliseconds', { ...challenge, issuedAt: now * 1000, expiresAt: now * 1000 + 300 }],
    ['unsafe integer', { ...challenge, issuedAt: 2 ** 53, expiresAt: 2 ** 53 + 300 }],
    ['negative timestamp', { ...challenge, issuedAt: -1, expiresAt: 299 }],
    ['short nonce', { ...challenge, nonce: '0xab' }],
    ['non-hex nonce', { ...challenge, nonce: `0x${'zz'.repeat(32)}` }],
    ['nonce trailing newline', { ...challenge, nonce: `${nonce}\n` }],
    ['missing nonce', { issuedAt: now, expiresAt: now + 300 }],
    ['array', [challenge]], ['null', null], ['string', 'challenge'],
  ])('refuses %s without signing', async (_label, body) => {
    const signer = { address: account.address, signTypedData: vi.fn() };
    expect(await prove(vi.fn(async () => json(body)), signer)).toEqual({ ok: false, error: 'challenge_invalid' });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it.each([
    ['non-JSON', () => new Response('<html>no</html>')],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]))],
    ['over 8 KiB', () => new Response(JSON.stringify(challenge).padEnd(8193, ' '))],
    ['over 8 KiB in bytes', () => json({ nonce: 'あ'.repeat(3000), issuedAt: now, expiresAt: now + 300 })],
    ['201', () => json(challenge, 201)], ['204', () => new Response(null, { status: 204 })],
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })],
    ['400', () => json(challenge, 400)],
  ])('rejects %s without signing', async (_label, response) => {
    const signer = { address: account.address, signTypedData: vi.fn() };
    expect(await prove(vi.fn(async () => response()), signer)).toEqual({ ok: false, error: 'challenge_invalid' });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('accepts exactly 8 KiB of valid JSON', async () => {
    const signer = { address: account.address, signTypedData: vi.fn((data: TypedData) => account.signTypedData(data)) };
    await verify(await prove(vi.fn(async () => new Response(JSON.stringify(challenge).padEnd(8192, ' '))), signer), account.address);
  });

  it('cancels an oversized stream before buffering the rest, ignoring a false content-length', async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(4097)); }, cancel,
    }), { headers: { 'content-length': '1' } });
    const signer = { address: account.address, signTypedData: vi.fn() };
    expect(await prove(vi.fn(async () => response), signer)).toEqual({ ok: false, error: 'challenge_invalid' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toBeLessThanOrEqual(3);
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it.each([[404, 'feature_disabled'], [429, 'challenge_unavailable'], [500, 'challenge_unavailable'], [503, 'challenge_unavailable']] as const)(
    'returns a fixed error for HTTP %i without signing or reading the body', async (status, error) => {
      const signer = { address: account.address, signTypedData: vi.fn() };
      const response = json({ nonce, signature: 'private response' }, status);
      const getReader = vi.spyOn(response.body!, 'getReader');
      expect(await prove(vi.fn(async () => response), signer)).toEqual({ ok: false, error });
      expect(getReader).not.toHaveBeenCalled();
      expect(signer.signTypedData).not.toHaveBeenCalled();
    },
  );

  it.each(['fetch', 'body'])('isolates %s network failures without leaking details or signing', async (stage) => {
    const signer = { address: account.address, signTypedData: vi.fn() };
    const error = new Error(`private ${nonce} ${key}`);
    const fetchImpl = vi.fn(async () => {
      if (stage === 'fetch') throw error;
      return new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    });
    expect(await prove(fetchImpl, signer)).toEqual({ ok: false, error: 'challenge_unavailable' });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('does not expose typed data from signer errors', async () => {
    const signer = { address: account.address, signTypedData: vi.fn(async () => { throw new Error(`secret ${nonce} ${key}`); }) };
    expect(await prove(vi.fn(async () => json(challenge)), signer)).toEqual({ ok: false, error: 'proof_signing_failed' });
  });

  it('rejects a DNS-private challenge target before fetching or signing', async () => {
    const fetchImpl = vi.fn();
    const signer = { address: account.address, signTypedData: vi.fn() };
    expect(await proveWallet({ signer, origin, fetchImpl, nowSec: () => now,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    })).toEqual({ ok: false, error: 'challenge_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('rejects Steward without requesting a challenge or remote signature', async () => {
    const fetchImpl = vi.fn();
    const active = runtime(fetchImpl, {
      SIGNER_MODE: 'steward', STEWARD_URL: 'https://steward.example', STEWARD_TENANT: 'tenant',
      STEWARD_API_KEY: 'secret', STEWARD_AGENT_ID: 'agent', STEWARD_AGENT_ADDRESS: account.address,
      STEWARD_SIGNER_ID: 'signer', STEWARD_SIGNER_SECRET: 'signer-secret',
    });
    expect(decode(await active.callTool('wallet_prove', {}))).toEqual({ ok: false, error: 'signer_mode_unsupported' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['uninitialized keystore', { SIGNER_MODE: 'keystore' }, 'wallet_not_initialized'],
    ['missing env key', { BUYER_PRIVATE_KEY: undefined }, 'buyer_private_key_missing'],
  ])('rejects %s without fetching or creating storage', async (_label, env, error) => {
    const fetchImpl = vi.fn();
    expect(decode(await runtime(fetchImpl, env).callTool('wallet_prove', {}))).toEqual({ ok: false, error });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a corrupt keystore without falling back to the environment key', async () => {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'wallet.json'), '{', { mode: 0o600 });
    const fetchImpl = vi.fn();
    expect(decode(await runtime(fetchImpl, { SIGNER_MODE: 'keystore' }).callTool('wallet_prove', {})))
      .toEqual({ ok: false, error: 'wallet_corrupt' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, [], { address: account.address }, { url: 'https://attacker.example' }])('rejects arguments %j before fetching', async (args) => {
    const fetchImpl = vi.fn();
    expect((await runtime(fetchImpl).callTool('wallet_prove', args)).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is absent and rejected in the order profile', async () => {
    const fetchImpl = vi.fn();
    const active = runtime(fetchImpl, {}, { profile: 'order' });
    expect(active.tools.map((tool) => tool.name)).not.toContain('wallet_prove');
    expect(decode(await active.callTool('wallet_prove', {}))).toEqual({ ok: false, error: 'tool_not_in_profile' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
