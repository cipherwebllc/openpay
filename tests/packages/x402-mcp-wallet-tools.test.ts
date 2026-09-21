// @vitest-environment node
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_JPYC_ASSETS, SUPPORTED_JPYC_FORWARDERS } from 'openpay-x402-sdk';

type Result = Record<string, unknown> & { limits: Record<string, unknown>; address: string | null };
type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type Runtime = {
  callTool: (name: string, args: unknown) => Promise<ToolResult>;
  walletStatus: (args: unknown) => Promise<Result>;
  walletInit: (args: unknown) => Promise<Result>;
  tools: Array<{ name: string }>;
};
const { createToolRuntime } = await import(
  pathToFileURL(resolve('packages/x402-mcp/src/tools.mjs')).href
) as { createToolRuntime: (options: Record<string, unknown>) => Runtime };
let home: string;
const resource = 'https://open-pay.jp/api/paid/demo';
const unit = 10n ** 18n;
const fixedNow = new Date('2026-09-21T12:00:00Z');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const decode = (result: ToolResult) => JSON.parse(result.content[0].text) as Result;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function accept(url = resource) {
  const token = SUPPORTED_JPYC_ASSETS['eip155:137'];
  const forwarder = SUPPORTED_JPYC_FORWARDERS['eip155:137'];
  return {
    scheme: 'exact', network: 'eip155:137', resource: url, maxAmountRequired: String(2n * unit),
    payTo: forwarder, asset: token.address, maxTimeoutSeconds: 600,
    extra: {
      ...token, assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split', forwarder,
        merchant: `0x${'2'.repeat(40)}`, merchantValue: String(unit),
        feeReceiver: `0x${'3'.repeat(40)}`, feeValue: String(unit),
        commitVersion: `0x${'a'.repeat(64)}`,
      },
    },
  };
}

function runtime(fetchImpl = vi.fn(async () => json({ items: [] })), env: Record<string, string> = {}, extra = {}) {
  return createToolRuntime({
    env: { HOME: home, SIGNER_MODE: 'keystore', CATALOG_TRUST: 'false', ...env },
    fetchImpl,
    lookup: async (host: string) => [{ address: host === 'localhost' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
    nowSec: () => Math.floor(fixedNow.getTime() / 1000),
    ...extra,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-wallet-tools-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('OPENPAY_X402_HOME', '');
  vi.stubEnv('BUYER_PRIVATE_KEY', undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixedNow);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('MCP wallet tools', () => {
  it('starts empty, serves discovery and quotes, and rejects both payment tools before any fetch', async () => {
    const fetchImpl = vi.fn(async (url?: unknown) => String(url).includes('discovery')
      ? json({ items: [{ resource, description: 'demo' }] })
      : json({ accepts: [accept()] }, 402));
    const active = runtime(fetchImpl);
    const status = await active.walletStatus({});
    expect(status).toMatchObject({ address: null, walletError: null, chain: 'polygon', jpycBalance: null, balanceSource: 'no_rpc_configured' });
    for (const name of ['x402_pay', 'search_shops']) {
      const result = decode(await active.callTool(name, { url: resource, maxTotalJpyc: '2' }));
      expect(result.error).toBe('wallet_not_initialized');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decode(await active.callTool('discovery_search', {})).ok).toBe(true);
    const quote = decode(await active.callTool('x402_quote', { url: resource }));
    expect(quote.totalJpyc).toBe('2');
    expect(quote.reasons).toContain('daily_spend_unavailable');
  });

  it('initializes in the running runtime, signs with that address, and enforces the default daily limit across restarts', async () => {
    let payer: string | undefined;
    const fetchImpl = vi.fn(async (url?: unknown, init?: RequestInit) => {
      const payment = new Headers(init?.headers).get('X-PAYMENT');
      if (payment) {
        const decoded = JSON.parse(Buffer.from(payment, 'base64').toString());
        payer = decoded.payload.authorization.from;
        return json({ answer: 'demo' });
      }
      return json({ accepts: [accept(String(url))] }, 402);
    });
    const active = runtime(fetchImpl, { MAX_SESSION_JPYC: '2' });
    const initialized = decode(await active.callTool('wallet_init', {}));
    expect(initialized.created).toBe(true);
    expect(initialized.note).toBe('OpenPay never receives, stores, or can recover this key. Anything that can run commands as you can read it. Keep only a small balance in this wallet.');
    expect(initialized.fundingUrl).toBe(`https://open-pay.jp/agent?address=${initialized.address}`);
    expect(decode(await active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' })).status).toBe(200);
    expect(payer).toBe(initialized.address);
    expect((await active.walletStatus({})).limits).toMatchObject({ sessionSpentJpyc: '2', dailySpentJpyc: '2', dailyJpyc: '2', dailyLimitSource: 'default_keystore' });
    expect((await active.walletInit({})).created).toBe(false);
    const restarted = runtime(fetchImpl, { MAX_SESSION_JPYC: '2' });
    const denied = decode(await restarted.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' }));
    expect(denied.reasons).toContain('daily_limit_exceeded');
    expect((await restarted.walletStatus({})).limits.sessionSpentJpyc).toBe('0');
    expect(process.env.BUYER_PRIVATE_KEY === undefined).toBe(true);
  });

  it('loads once, never exports keys through tool output/errors, and preserves unrelated nonces in payloads', async () => {
    const active = runtime();
    await active.walletInit({});
    const path = join(home, '.openpay-x402/wallet.json');
    const key = JSON.parse(await readFile(path, 'utf8')).privateKey as string;
    const nonce = `0x${'b'.repeat(64)}`;
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new Error(`failure ${key}`); });
    const loaded = runtime(fetchImpl);
    const status = await loaded.walletStatus({});
    await writeFile(path, 'broken');
    expect((await loaded.walletStatus({})).address).toBe(status.address);
    const args = { url: resource, maxTotalJpyc: '2', handle: 'demo', items: [{ id: 'item', qty: 1 }] };
    for (const tool of loaded.tools) {
      if (tool.name === 'wallet_init') continue;
      const result = await loaded.callTool(tool.name, tool.name === 'wallet_status' ? {} : args);
      expect(JSON.stringify(result).includes(key)).toBe(false);
    }
    const error = decode(await loaded.callTool('discovery_search', {}));
    expect(error.error).toBe('failure [redacted_private_key]');
    fetchImpl.mockImplementation(async () => json({ items: [], leaked: key, nonce }));
    const payload = decode(await loaded.callTool('find_shops', {}));
    expect(payload.leaked).toBe('[redacted_private_key]');
    expect(payload.nonce).toBe(nonce);
    expect(decode(await loaded.callTool('wallet_init', {})).error).toBe('wallet_corrupt');
    expect(decode(await loaded.callTool('find_shops', {})).leaked).toBe('[redacted_private_key]');
    expect(JSON.stringify(await loaded.callTool(`unknown ${key}`, {})).includes(key)).toBe(false);
    expect(JSON.stringify(await active.callTool('wallet_init', {})).includes(key)).toBe(false);
    expect(process.env.BUYER_PRIVATE_KEY === undefined).toBe(true);
  });

  it.each(['corrupt', 'permissions', 'address'])('keeps %s wallets unchanged and fails closed while discovery stays available', async (kind) => {
    if (kind === 'permissions' && process.platform === 'win32') return;
    await runtime().walletInit({});
    const path = join(home, '.openpay-x402/wallet.json');
    if (kind === 'corrupt') await writeFile(path, '{broken');
    if (kind === 'permissions') await chmod(path, 0o644);
    if (kind === 'address') {
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.address = `0x${'2'.repeat(40)}`;
      await writeFile(path, JSON.stringify(record));
    }
    const original = digest(await readFile(path, 'utf8'));
    const fetchImpl = vi.fn(async () => json({ items: [] }));
    const active = runtime(fetchImpl);
    const code = kind === 'corrupt' ? 'wallet_corrupt' : kind === 'permissions' ? 'wallet_permissions_unsafe' : 'wallet_address_mismatch';
    expect((await active.walletStatus({})).walletError).toBe(code);
    expect(decode(await active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' })).error).toBe(code);
    expect(decode(await active.callTool('wallet_init', {})).error).toBe(code);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decode(await active.callTool('discovery_search', {})).ok).toBe(true);
    expect(digest(await readFile(path, 'utf8'))).toBe(original);
  });

  it.each(['env-key', 'steward'])('reports %s address/limits without changing its defaults and rejects wallet_init', async (mode) => {
    const key = `0x${'1'.repeat(64)}` as Hex;
    const address = privateKeyToAccount(key).address;
    const env = mode === 'env-key' ? { SIGNER_MODE: mode, BUYER_PRIVATE_KEY: key } : {
      SIGNER_MODE: mode, STEWARD_URL: 'https://steward.test', STEWARD_TENANT: 'tenant',
      STEWARD_API_KEY: 'secret-api', STEWARD_SIGNER_SECRET: 'secret-signer',
      STEWARD_AGENT_ID: 'agent', STEWARD_SIGNER_ID: 'signer', STEWARD_AGENT_ADDRESS: address,
    };
    const active = createToolRuntime({ env });
    const status = await active.walletStatus({});
    expect(status.address).toBe(address);
    expect(status.limits).toMatchObject({ dailyJpyc: null, dailySpentJpyc: null, dailyLimitSource: 'disabled' });
    expect((await active.walletInit({})).error).toBe('wallet_init_requires_keystore_mode');
    expect(JSON.stringify(status).includes(key)).toBe(false);
    expect(JSON.stringify(status).includes('secret-')).toBe(false);
  });

  it('queries only Polygon JPYC balanceOf at the configured RPC and respects explicit caps', async () => {
    const fetchImpl = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: `0x${(15n * unit).toString(16).padStart(64, '0')}` }));
    const active = runtime(fetchImpl, { POLYGON_RPC_URL: 'https://rpc.test', MAX_DAILY_JPYC: '15' });
    await active.walletInit({});
    const status = await active.walletStatus({});
    expect(status).toMatchObject({ jpycBalance: '15', balanceSource: 'rpc', chain: 'polygon' });
    expect(status.limits).toMatchObject({ dailyJpyc: '15', dailyLimitSource: 'configured' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://rpc.test/');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe('eth_call');
    expect(body.params[0].to).toBe(SUPPORTED_JPYC_ASSETS['eip155:137'].address);
    expect(decodeFunctionData({ abi: erc20Abi, data: body.params[0].data })).toMatchObject({ functionName: 'balanceOf', args: [status.address] });
    expect(decode(await active.callTool('wallet_status', { url: 'https://attacker.test' })).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['http://rpc.test', 'https://rpc.test', 'http://localhost:8545', 'http://127.0.0.1:8545'])('returns unknown on RPC errors and rejects unsafe URLs: %s', async (url) => {
    const fetchImpl = vi.fn(async () => { throw new Error('RPC failed'); });
    const active = runtime(fetchImpl, { POLYGON_RPC_URL: url });
    await active.walletInit({});
    expect(await active.walletStatus({})).toMatchObject({ jpycBalance: null, balanceSource: 'rpc_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(url === 'http://rpc.test' ? 0 : 1);
  });

  it('times out a stalled RPC body after five seconds', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response);
    const active = runtime(fetchImpl, { POLYGON_RPC_URL: 'https://rpc.test' });
    await active.walletInit({});
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(fixedNow);
    const pending = active.walletStatus({});
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ jpycBalance: null, balanceSource: 'rpc_error' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it.each(['empty', 'partial', 'mismatch', 'symlink'])('preserves %s wallets and delivers do-not-delete guidance through both tools', async (kind) => {
    const directory = join(home, '.openpay-x402');
    const path = join(directory, 'wallet.json');
    await mkdir(directory, { mode: 0o700 });
    if (kind === 'mismatch') {
      await runtime().walletInit({});
      const document = JSON.parse(await readFile(path, 'utf8'));
      document.address = `0x${'2'.repeat(40)}`;
      await writeFile(path, JSON.stringify(document));
    } else if (kind === 'symlink') {
      await writeFile(join(home, 'target'), '{}', { mode: 0o600 });
      await symlink(join(home, 'target'), path);
    } else {
      await writeFile(path, kind === 'empty' ? '' : '{"version":1,', { mode: 0o600 });
    }
    const original = digest(await readFile(path, 'utf8'));
    const active = runtime();
    const code = kind === 'mismatch' ? 'wallet_address_mismatch' : kind === 'symlink' ? 'wallet_file_unsafe' : 'wallet_corrupt';
    const timer = vi.spyOn(globalThis, 'setTimeout');
    for (const name of ['wallet_status', 'wallet_init']) {
      const result = decode(await active.callTool(name, {}));
      expect(name === 'wallet_status' ? result.walletError : result.error).toBe(code);
      const message = String(name === 'wallet_status' ? result.walletErrorMessage : result.message);
      expect(message).toContain(path);
      expect(message).toContain('Do not delete');
      expect(message).toContain(`mv '${path}' '${path}.broken'`);
      expect(message).toContain('only copy of the key');
      expect(message).toContain('funded this address');
    }
    expect(timer).not.toHaveBeenCalled();
    expect(digest(await readFile(path, 'utf8'))).toBe(original);
    expect(await readdir(directory)).toEqual(['wallet.json']);
  });

  it('keeps startup and discovery available but refuses relative wallet homes without writing', async () => {
    const relative = `./${home.slice(1)}`;
    const active = runtime(undefined, { OPENPAY_X402_HOME: relative });
    expect(decode(await active.callTool('wallet_status', {})).walletError).toBe('wallet_home_not_absolute');
    expect(decode(await active.callTool('wallet_init', {})).error).toBe('wallet_home_not_absolute');
    expect(decode(await active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' })).error).toBe('wallet_home_not_absolute');
    expect(decode(await active.callTool('discovery_search', {})).ok).toBe(true);
    await expect(readFile(join(relative, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never signs with or exposes a stray env key in keystore mode', async () => {
    const strayKey = `0x${'1'.repeat(64)}` as Hex;
    const strayAddress = privateKeyToAccount(strayKey).address;
    let payer: string | undefined;
    const fetchImpl = vi.fn(async (url?: unknown, init?: RequestInit) => {
      const payment = new Headers(init?.headers).get('X-PAYMENT');
      if (payment) {
        payer = JSON.parse(Buffer.from(payment, 'base64').toString()).payload.authorization.from;
        return json({ echoed: strayKey });
      }
      return json({ accepts: [accept(String(url))], items: [], echoed: strayKey }, 402);
    });
    const active = runtime(fetchImpl, { BUYER_PRIVATE_KEY: strayKey });
    expect(decode(await active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' })).error).toBe('wallet_not_initialized');
    expect(fetchImpl).not.toHaveBeenCalled();
    const initialized = decode(await active.callTool('wallet_init', {}));
    const paid = decode(await active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' }));
    expect(paid.status).toBe(200);
    expect(payer).toBe(initialized.address);
    expect(payer === strayAddress).toBe(false);
    expect(JSON.stringify(paid).includes(strayKey)).toBe(false);
    for (const tool of active.tools) {
      const args = tool.name.startsWith('wallet_') ? {} : { url: resource, maxTotalJpyc: '2', handle: 'demo', items: [{ id: 'item', qty: 1 }] };
      expect(JSON.stringify(await active.callTool(tool.name, args)).includes(strayKey)).toBe(false);
    }
    fetchImpl.mockImplementation(async () => { throw new Error(`echo ${strayKey}`); });
    expect(JSON.stringify(await active.callTool('find_shops', {})).includes(strayKey)).toBe(false);
    expect(process.env.BUYER_PRIVATE_KEY === undefined).toBe(true);
  });

  it('retains every previously activated key in payload and error redaction', async () => {
    const fetchImpl = vi.fn(async () => json({ items: [] }));
    const active = runtime(fetchImpl);
    await active.walletInit({});
    const path = join(home, '.openpay-x402/wallet.json');
    const firstKey = JSON.parse(await readFile(path, 'utf8')).privateKey as string;
    await rename(path, `${path}.saved`);
    await runtime(undefined, { OPENPAY_X402_HOME: join(home, 'replacement') }).walletInit({});
    await rename(join(home, 'replacement/wallet.json'), path);
    await active.walletInit({});
    const secondKey = JSON.parse(await readFile(path, 'utf8')).privateKey as string;
    const nonce = `0x${'b'.repeat(64)}`;
    fetchImpl.mockImplementation(async () => json({ items: [], echoed: [firstKey, secondKey], nonce }));
    const payload = decode(await active.callTool('find_shops', {}));
    expect([firstKey, secondKey].some((key) => JSON.stringify(payload).includes(key))).toBe(false);
    expect(payload.nonce).toBe(nonce);
    fetchImpl.mockImplementation(async () => { throw new Error(`echo ${firstKey} ${secondKey}`); });
    const error = decode(await active.callTool('find_shops', {}));
    expect(error.error === 'echo [redacted_private_key] [redacted_private_key]').toBe(true);
  });

  it('serializes concurrent payments across wallet reactivation and keeps per-address daily spend', async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const entered = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    let inFlight = 0;
    let maximum = 0;
    const payers: string[] = [];
    const fetchImpl = vi.fn(async (url?: unknown, init?: RequestInit) => {
      const payment = new Headers(init?.headers).get('X-PAYMENT');
      if (!payment) return json({ accepts: [accept(String(url))] }, 402);
      payers.push(JSON.parse(Buffer.from(payment, 'base64').toString()).payload.authorization.from);
      maximum = Math.max(maximum, ++inFlight);
      if (payers.length === 1) { started(); await held; }
      inFlight--;
      return json({ answer: 'ok' });
    });
    const active = runtime(fetchImpl);
    const firstWallet = await active.walletInit({});
    const first = active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' });
    await entered;
    const path = join(home, '.openpay-x402/wallet.json');
    await rename(path, `${path}.saved`);
    const replacement = await runtime(undefined, { OPENPAY_X402_HOME: join(home, 'replacement') }).walletInit({});
    await rename(join(home, 'replacement/wallet.json'), path);
    const reinit = active.walletInit({});
    const second = reinit.then(() => active.callTool('x402_pay', { url: resource, maxTotalJpyc: '2' }));
    // Give the old implementation time to start its replacement executor while the first retry is held.
    const timer = setTimeout(release, 100);
    try {
      expect((await Promise.all([first, second])).map((result) => decode(result).status)).toEqual([200, 200]);
    } finally { clearTimeout(timer); release(); }
    expect(maximum).toBe(1);
    expect(payers).toEqual([firstWallet.address, replacement.address]);
    expect((await active.walletStatus({})).limits).toMatchObject({ sessionSpentJpyc: '4', dailySpentJpyc: '2' });
  });

  it.each(['https://10.0.0.1', 'https://169.254.169.254', 'https://rpc.internal', 'https://[::1]', 'https://rpc.local', 'https://user:pass@rpc.test'])('rejects unsafe RPC before transport: %s', async (url) => {
    const fetchImpl = vi.fn(async () => json({ result: `0x${'0'.repeat(64)}` }));
    const active = runtime(fetchImpl, { POLYGON_RPC_URL: url });
    await active.walletInit({});
    expect(await active.walletStatus({})).toMatchObject({ jpycBalance: null, balanceSource: 'rpc_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects public RPC names resolving to private addresses before transport', async () => {
    const fetchImpl = vi.fn(async () => json({ result: `0x${'0'.repeat(64)}` }));
    const active = runtime(fetchImpl, { POLYGON_RPC_URL: 'https://rpc.test' }, {
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    await active.walletInit({});
    expect(await active.walletStatus({})).toMatchObject({ jpycBalance: null, balanceSource: 'rpc_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
