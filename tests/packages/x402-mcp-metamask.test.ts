// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const wrongAccount = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const unit = 10n ** 18n;
const resource = 'https://open-pay.jp/api/paid/demo';
const secret = 'credential-not-hex-DO-NOT-EXPOSE';
const fixedNow = new Date('2026-09-25T12:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type ChildError = Error & { code?: string | number | null; killed?: boolean; signal?: string };
type ExecFile = (
  bin: string, args: string[],
  options: { shell: boolean; timeout: number; killSignal: string; maxBuffer: number; encoding: string; env: Record<string, string | undefined> },
  callback: (error: ChildError | null, stdout: string, stderr: string) => void,
) => ReturnType<typeof fakeChild>;
type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type Result = Record<string, unknown> & { limits: Record<string, unknown> };
type Runtime = {
  config: { signerMode: string };
  callTool: (name: string, args: unknown) => Promise<ToolResult>;
  walletStatus: (args: unknown) => Promise<Result>;
};
const decode = (result: ToolResult) => JSON.parse(result.content[0].text) as Result;
const { createToolRuntime } = await import(pathToFileURL(resolve('packages/x402-mcp/src/tools.mjs')).href) as {
  createToolRuntime: (options: Record<string, unknown>) => Runtime;
};
const { createMetamaskSigner } = await import(pathToFileURL(resolve('packages/x402-mcp/src/metamask-signer.mjs')).href) as {
  createMetamaskSigner: (env: Record<string, string | undefined>, options: { execFileImpl: ExecFile }) => {
    mode: string; address: Address; signTypedData: (data: ReturnType<typeof typedData>) => Promise<Hex>;
  };
};
// Like existing MCP tests, read fixture constants from the repository SDK. CI only
// installs root dependencies; the runtime keeps its normal bare SDK import.
const { SUPPORTED_JPYC_ASSETS, SUPPORTED_JPYC_FORWARDERS } = await import(
  pathToFileURL(resolve('packages/x402-sdk/src/index.mjs')).href
) as {
  SUPPORTED_JPYC_ASSETS: Record<string, { address: Address; name: string; version: string; decimals: number }>;
  SUPPORTED_JPYC_FORWARDERS: Record<string, Address>;
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-metamask-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixedNow);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    HOME: home, SIGNER_MODE: 'metamask', METAMASK_AGENT_ADDRESS: account.address,
    CATALOG_TRUST: 'false', ...overrides,
  };
}

function typedData(chainId = 80002) {
  return {
    domain: { name: 'JPY Coin', version: '1', chainId, verifyingContract: SUPPORTED_JPYC_ASSETS['eip155:137'].address },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: account.address, to: SUPPORTED_JPYC_FORWARDERS['eip155:80002'],
      value: 12345678901234567890123456789n, validAfter: 0n, validBefore: 1800000600n,
      nonce: `0x${'a'.repeat(64)}` as Hex,
    },
  } as const;
}

function accept(network = 'eip155:137') {
  const token = SUPPORTED_JPYC_ASSETS[network] ?? SUPPORTED_JPYC_ASSETS['eip155:137'];
  const forwarder = SUPPORTED_JPYC_FORWARDERS[network] ?? SUPPORTED_JPYC_FORWARDERS['eip155:137'];
  return {
    scheme: 'exact', network, resource, maxAmountRequired: String(2n * unit),
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

function fakeChild(onEnd = () => {}) {
  return {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn(onEnd) }),
    kill: vi.fn((_signal: string) => true),
  };
}

function child(stdout: string, error: ChildError | null = null, stderr = '') {
  return vi.fn<ExecFile>((_bin, _args, _options, callback) => {
    callback(error, stdout, stderr);
    return fakeChild();
  });
}

function signingChild(signer = account) {
  return vi.fn<ExecFile>((_bin, args, _options, callback) => {
    void signer.signTypedData(JSON.parse(args[5])).then(
      // mm 7.0.0 echoes the intent on stderr even on success (measured 2026-09-26).
      (signature) => callback(null, JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature }, debug: secret }), 'Intent: OpenPay x402 payment\n'),
      (error) => callback(error, '', secret),
    );
    return fakeChild();
  });
}

function runtime(overrides: Record<string, string | undefined> = {}, metamaskExecFile: ExecFile = signingChild(), network = 'eip155:137', extra = {}) {
  const paidFetch = vi.fn();
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const payment = new Headers(init?.headers).get('X-PAYMENT');
    if (!payment) return json({ accepts: [accept(network)] }, 402);
    paidFetch(JSON.parse(Buffer.from(payment, 'base64').toString()));
    return json({ answer: 'demo' });
  });
  const active = createToolRuntime({
    env: env(overrides), metamaskExecFile, fetchImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    nowSec: () => Math.floor(Date.now() / 1000), ...extra,
  });
  return { active, fetchImpl, paidFetch };
}
const pay = (active: Runtime, maxTotalJpyc = '2') => active.callTool('x402_pay', { url: resource, maxTotalJpyc });

describe('Metamask signer adapter', () => {
  it.each([137, 80002])('serializes bigint losslessly and uses exact argv on %s', async (chainId) => {
    const execFileImpl = signingChild();
    const signer = createMetamaskSigner(env({ MM_BIN: 'mm-test' }), { execFileImpl });
    const data = typedData(chainId);
    expect(await signer.signTypedData(data)).toBe(await account.signTypedData(data));
    const [bin, args, options] = execFileImpl.mock.calls[0];
    expect(bin).toBe('mm-test');
    const payload = JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    expect(args).toEqual(['wallet', 'sign-typed-data', '--chain-id', String(chainId), '--payload', payload,
      '--intent', 'OpenPay x402 payment', '--wait', '--wallet-timeout', '20', '--json']);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(30_000);
    expect(options).toMatchObject({ shell: false, killSignal: 'SIGKILL', maxBuffer: 65536,
      encoding: 'utf8', env: env({ MM_BIN: 'mm-test' }) });
  });

  it('excludes OpenPay secrets before reading getters and forwards only the supplied env own keys', async () => {
    vi.stubEnv('KOVA_PARENT_ONLY', 'not-in-injected-env');
    const inherited = Object.defineProperty({}, 'INHERITED_ONLY', { get() { throw new Error(secret); }, enumerable: true });
    const config = Object.assign(Object.create(inherited), env({ MM_ENV: 'test', PATH: '/mm/bin', CUSTOM: 'keep' }));
    for (const key of ['BUYER_PRIVATE_KEY', 'STEWARD_API_KEY', 'STEWARD_SIGNER_SECRET', 'STEWARD_URL', 'STEWARD_TENANT', 'STEWARD_AGENT_ID', 'STEWARD_AGENT_ADDRESS', 'STEWARD_SIGNER_ID', 'STEWARD_FUTURE_SECRET', 'KOVA_CREDENTIAL', 'KOVA_FUTURE_SECRET', 'POLYGON_RPC_URL']) {
      Object.defineProperty(config, key, { get() { throw new Error(secret); }, enumerable: true });
    }
    const execFileImpl = signingChild();
    await createMetamaskSigner(config, { execFileImpl }).signTypedData(typedData());
    expect(execFileImpl.mock.calls[0][2].env).toEqual(env({ MM_ENV: 'test', PATH: '/mm/bin', CUSTOM: 'keep' }));
    expect(execFileImpl.mock.calls[0][2].env).not.toHaveProperty('KOVA_PARENT_ONLY');
  });

  it('filters stray OpenPay secrets on the MCP path while retaining Metamask and other env values', async () => {
    const execFileImpl = signingChild();
    const { active } = runtime({
      BUYER_PRIVATE_KEY: `0x${'2'.repeat(64)}`, STEWARD_API_KEY: 'openpay-secret',
      STEWARD_SIGNER_SECRET: 'openpay-secret', STEWARD_URL: 'https://unused.test',
      STEWARD_CUSTOM: 'openpay-secret', MM_ENV: 'test', PATH: '/mm/bin', CUSTOM: 'keep',
    }, execFileImpl);
    expect(decode(await pay(active)).status).toBe(200);
    expect(execFileImpl.mock.calls[0][2].env).toEqual(env({ MM_ENV: 'test', PATH: '/mm/bin', CUSTOM: 'keep' }));
  });

  it.each([1, 8453, 80001])('rejects unsupported chain %s before launching the CLI', async (chainId) => {
    const execFileImpl = signingChild();
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData(chainId))).rejects.toThrow(/^metamask_sign_failed$/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('rejects the wrong signer without disabling subsequent verification', async () => {
    const good = await account.signTypedData(typedData());
    const bad = await wrongAccount.signTypedData(typedData());
    const execFileImpl = child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature: bad } }));
    const signer = createMetamaskSigner(env(), { execFileImpl });
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
    execFileImpl.mockImplementation(child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature: good } })));
    await expect(signer.signTypedData(typedData())).resolves.toBe(good);
    execFileImpl.mockImplementation(child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature: bad } })));
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
  });

  it('verifies each response against that call\'s original typed-data', async () => {
    const signature = await account.signTypedData(typedData());
    const execFileImpl = child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature } }));
    const signer = createMetamaskSigner(env(), { execFileImpl });
    await expect(signer.signTypedData(typedData())).resolves.toBe(signature);
    const data = typedData();
    await expect(signer.signTypedData({ ...data, message: { ...data.message, nonce: `0x${'b'.repeat(64)}` } })).rejects.toThrow(/^metamask_sign_failed$/);
  });

  it('rejects a newline appended to an otherwise valid signature', async () => {
    const signature = `${await account.signTypedData(typedData())}\n`;
    const execFileImpl = child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature } }));
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
  });

  it.each([
    `0x${'a'.repeat(128)}`, `0x${'a'.repeat(132)}`, 'a'.repeat(130),
    `0x${'g'.repeat(130)}`, `0x${'0'.repeat(130)}`, `0x${'a'.repeat(130)}\n`,
  ])('rejects malformed/invalid signature %# without recoveryId repair', async (signature) => {
    const execFileImpl = child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature, recoveryId: 27 } }));
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
  });

  it('still validates signature length after the first signature was verified', async () => {
    const execFileImpl = signingChild();
    const signer = createMetamaskSigner(env(), { execFileImpl });
    await signer.signTypedData(typedData());
    execFileImpl.mockImplementation(child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature: '0x1234' } })));
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
  });
});

describe('Metamask child lifetime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(fixedNow);
  });

  it('kills a SIGTERM-ignoring child and rejects at 30 seconds even without an exit callback', async () => {
    const stuck = fakeChild(); // No callback, including on SIGTERM or SIGKILL.
    const execFileImpl = vi.fn<ExecFile>(() => stuck);
    const signer = createMetamaskSigner(env(), { execFileImpl });
    const pending = signer.signTypedData(typedData());
    const rejected = expect(pending).rejects.toThrow(/^metamask_approval_pending$/);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stuck.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(execFileImpl.mock.calls[0][2].killSignal).toBe('SIGKILL');
    expect(stuck.kill).toHaveBeenCalledOnce();
    expect(stuck.kill).toHaveBeenCalledWith('SIGKILL');
    expect(stuck.stdin.end).toHaveBeenCalledOnce();
    // Late output cannot turn a timed-out signature into success.
    execFileImpl.mock.calls[0][3](null, JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature: await account.signTypedData(typedData()) } }), secret);
    await expect(pending).rejects.toThrow(/^metamask_approval_pending$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not launch a queued call after its 30-second budget expires', async () => {
    const execFileImpl = vi.fn<ExecFile>(() => fakeChild());
    const signer = createMetamaskSigner(env(), { execFileImpl });
    const first = expect(signer.signTypedData(typedData())).rejects.toThrow(/^metamask_approval_pending$/);
    const second = expect(signer.signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(execFileImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(execFileImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes only the remaining queue budget to the child timeout', async () => {
    const signature = await account.signTypedData(typedData());
    const stdout = JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature } });
    const execFileImpl = child(stdout).mockImplementationOnce(() => fakeChild());
    const signer = createMetamaskSigner(env(), { execFileImpl });
    const first = signer.signTypedData(typedData());
    const second = signer.signTypedData(typedData());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(execFileImpl).toHaveBeenCalledOnce();
    execFileImpl.mock.calls[0][3](null, stdout, '');
    await expect(first).resolves.toBe(signature);
    await expect(second).resolves.toBe(signature);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    const timeout = execFileImpl.mock.calls[1][2].timeout;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(30_000 - 12_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the serialized SDK pay queue after a stuck child times out', async () => {
    const stuck = fakeChild();
    const execFileImpl = signingChild().mockImplementationOnce(() => stuck);
    const { active, paidFetch } = runtime({}, execFileImpl);
    const first = pay(active);
    const second = pay(active);
    await vi.waitFor(() => expect(execFileImpl).toHaveBeenCalledOnce());
    expect(paidFetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(decode(await first)).toMatchObject({ ok: false, error: 'metamask_approval_pending' });
    expect(decode(await second).status).toBe(200);
    expect(stuck.kill).toHaveBeenCalledOnce();
    expect(stuck.kill).toHaveBeenCalledWith('SIGKILL');
    expect(paidFetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes stdin so a child waiting for interactive input fails immediately on EOF', async () => {
    const execFileImpl = vi.fn<ExecFile>((_bin, _args, _options, callback) => fakeChild(() => {
      callback(Object.assign(new Error(secret), { code: 1 }), secret, secret);
    }));
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
    expect(execFileImpl.mock.results[0].value.stdin.end).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.results[0].value.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains stdin errors and kills the child without leaking the stream error', async () => {
    const broken = fakeChild(() => broken.stdin.emit('error', new Error(secret)));
    const execFileImpl = vi.fn<ExecFile>(() => broken);
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^metamask_sign_failed$/);
    expect(broken.kill).toHaveBeenCalledOnce();
    expect(broken.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still rejects on deadline when the OS kill attempt throws', async () => {
    const stuck = fakeChild();
    stuck.kill.mockImplementation(() => { throw new Error(secret); });
    const rejected = expect(createMetamaskSigner(env(), { execFileImpl: () => stuck }).signTypedData(typedData())).rejects.toThrow(/^metamask_approval_pending$/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Metamask mode and daily ledger wiring', () => {
  it.each([['eip155:137', '137'], ['eip155:80002', '80002']])('maps public metamask to SDK guards and chooses the CLI chain from %s', async (network, chain) => {
    const execFileImpl = signingChild();
    const { active, paidFetch } = runtime({}, execFileImpl, network);
    expect(active.config.signerMode).toBe('steward');
    expect(await active.walletStatus({})).toMatchObject({
      signerMode: 'metamask', address: account.address, chain: 'polygon', jpycBalance: null,
      limits: { dailyJpyc: '100', dailyLimitSource: 'default_metamask' },
    });
    expect(decode(await pay(active)).status).toBe(200);
    expect(paidFetch).toHaveBeenCalledOnce();
    expect(paidFetch.mock.calls[0][0]).toMatchObject({ network, payload: { authorization: { from: account.address } } });
    expect(execFileImpl.mock.calls[0][1][3]).toBe(chain);
    expect(JSON.parse(execFileImpl.mock.calls[0][1][5]).domain.chainId).toBe(Number(network.split(':')[1]));
  });

  it.each(['per_call', 'session', 'daily', 'network'])('keeps the %s guard before signing/payment', async (guard) => {
    const overrides = guard === 'per_call' ? { MAX_PER_CALL_JPYC: '1' }
      : guard === 'session' ? { MAX_SESSION_JPYC: '1', MAX_DAILY_JPYC: '100' }
        : guard === 'daily' ? { MAX_DAILY_JPYC: '1' } : {};
    const execFileImpl = signingChild();
    const { active, paidFetch } = runtime(overrides, execFileImpl, guard === 'network' ? 'eip155:1' : undefined);
    const result = decode(await pay(active));
    expect(result.ok).toBe(false);
    const reason = guard === 'network' ? 'unsupported_network'
      : guard === 'per_call' ? 'max_total_above_per_call_limit' : `${guard}_limit_exceeded`;
    expect(result.reasons).toContain(reason);
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('defaults to the configured session cap and persists by address + UTC day (custom home: %s)', async (customHome) => {
    const directory = customHome ? join(home, 'custom') : join(home, '.openpay-x402');
    const overrides = { MAX_SESSION_JPYC: '2', ...(customHome ? { OPENPAY_X402_HOME: directory } : {}) };
    const { active } = runtime(overrides);
    expect((await active.walletStatus({})).limits).toMatchObject({ dailyJpyc: '2', dailySpentJpyc: '0', dailyLimitSource: 'default_metamask' });
    expect(decode(await pay(active)).status).toBe(200);
    expect((await active.walletStatus({})).limits).toMatchObject({ dailySpentJpyc: '2', sessionSpentJpyc: '2' });
    const ledger = JSON.parse(await readFile(join(directory, 'spend.json'), 'utf8'));
    const key = `${account.address.toLowerCase()}:2026-09-25`;
    expect(ledger[key]).toBe(String(2n * unit));
    expect(Object.keys(ledger).filter((key) => !key.startsWith('__'))).toEqual([key]);
    const execFileImpl = signingChild();
    const restarted = runtime({ ...overrides, METAMASK_AGENT_ADDRESS: account.address.toLowerCase() }, execFileImpl, 'eip155:80002');
    expect(decode(await pay(restarted.active)).reasons).toContain('daily_limit_exceeded');
    expect((await restarted.active.walletStatus({})).limits).toMatchObject({ dailySpentJpyc: '2', sessionSpentJpyc: '0' });
    expect(execFileImpl).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
    expect((await restarted.active.walletStatus({})).limits.dailySpentJpyc).toBe('0');
    expect(decode(await pay(restarted.active)).status).toBe(200);
    expect(await readdir(directory)).not.toContain('wallet.json');
    await expect(readFile(join(home, '.metamask/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (customHome) await expect(readdir(join(home, '.openpay-x402'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports configured daily caps and rejects unsupported wallet tools without executing anything', async () => {
    const execFileImpl = signingChild();
    const { active, fetchImpl } = runtime({ MAX_DAILY_JPYC: '3' }, execFileImpl);
    expect((await active.walletStatus({})).limits).toMatchObject({ dailyJpyc: '3', dailyLimitSource: 'configured' });
    expect(decode(await active.callTool('wallet_init', {}))).toEqual({ ok: false, error: 'wallet_init_requires_keystore_mode' });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it('keeps atomic daily reservations across independent runtimes sharing the same ledger', async () => {
    const first = runtime({ MAX_SESSION_JPYC: '2' });
    const second = runtime({ MAX_SESSION_JPYC: '2' });
    const results = (await Promise.all([pay(first.active), pay(second.active)])).map(decode);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.find((result) => result.ok === false)?.reasons).toContain('daily_limit_exceeded');
    expect(first.paidFetch.mock.calls.length + second.paidFetch.mock.calls.length).toBe(1);
    expect((await first.active.walletStatus({})).limits.dailySpentJpyc).toBe('2');
    expect((await second.active.walletStatus({})).limits.dailySpentJpyc).toBe('2');
  });

  it('blocks a signature that finishes after the UTC daily boundary', async () => {
    const execFileImpl: ExecFile = (bin, args, options, callback) => signingChild()(bin, args, options,
      (error, stdout, stderr) => {
        vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
        callback(error, stdout, stderr);
      });
    const { active, paidFetch } = runtime({}, execFileImpl);
    expect(decode(await pay(active)).reasons).toContain('daily_authorization_crosses_utc_day');
    expect(paidFetch).not.toHaveBeenCalled();
    expect((await active.walletStatus({})).limits.dailySpentJpyc).toBe('0');
  });

  it('shares the status/executor store and blocks payment when reservation persistence fails', async () => {
    const key = `${account.address.toLowerCase()}:2026-09-25`;
    const spendStore = { load: vi.fn(async (_key: string) => '0'), save: vi.fn(async () => { throw new Error(secret); }) };
    const { active, paidFetch } = runtime({}, signingChild(), undefined, { spendStore });
    expect((await active.walletStatus({})).limits.dailySpentJpyc).toBe('0');
    const result = await pay(active);
    expect(decode(result).reasons).toContain('daily_spend_unavailable');
    expect(spendStore.load.mock.calls.every((args) => args[0] === key)).toBe(true);
    expect(spendStore.save).toHaveBeenCalledOnce();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('fails closed on corrupt spend storage without inspecting an existing keystore', async () => {
    const directory = join(home, '.openpay-x402');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'wallet.json'), 'do-not-read-or-replace');
    await writeFile(join(directory, 'spend.json'), '{broken');
    const execFileImpl = signingChild();
    const { active, paidFetch } = runtime({}, execFileImpl);
    expect(await active.walletStatus({})).toMatchObject({ signerMode: 'metamask', walletError: null, limits: { dailySpentJpyc: null } });
    expect(decode(await pay(active)).reasons).toContain('daily_spend_unavailable');
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'wallet.json'), 'utf8')).toBe('do-not-read-or-replace');
  });
});

describe('Metamask wallet_prove (purchase-history binding)', () => {
  const nonce = `0x${'ab'.repeat(32)}` as Hex;
  function proveRuntime(metamaskExecFile: ExecFile) {
    const now = Math.floor(Date.now() / 1000);
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe(`https://open-pay.jp/api/agent/proof/challenge?address=${account.address}`);
      return json({ nonce, issuedAt: now, expiresAt: now + 300 });
    });
    return { ...runtime({}, metamaskExecFile, undefined, { fetchImpl }), fetchImpl };
  }

  it('signs the OpenPay Agent Proof through the CLI on polygon and returns the bind link', async () => {
    const execFileImpl = signingChild();
    const { active } = proveRuntime(execFileImpl);
    const result = decode(await active.callTool('wallet_prove', {}));
    expect(result).toMatchObject({ ok: true, address: account.address });
    expect(String(result.bindUrl)).toMatch(new RegExp(`^https://open-pay\\.jp/agent\\?address=${account.address}#proof=`));
    expect(execFileImpl).toHaveBeenCalledOnce();
    const args = execFileImpl.mock.calls[0][1];
    expect(args.slice(0, 5)).toEqual(['wallet', 'sign-typed-data', '--chain-id', '137', '--payload']);
    expect(args.slice(6)).toEqual(['--intent', 'OpenPay wallet proof (no payment)', '--wait', '--wallet-timeout', '20', '--json']);
    const signed = JSON.parse(args[5]);
    expect(signed).toMatchObject({
      domain: { name: 'OpenPay Agent Proof', version: '1', chainId: 137 },
      primaryType: 'Proof',
      message: { address: account.address, purpose: 'bind-purchase-history', audience: 'https://open-pay.jp', nonce },
    });
    expect(signed.message.expiresAt).toBe(String(Number(signed.message.issuedAt) + 300));
    const proof = JSON.parse(Buffer.from(String(result.bindUrl).split('#proof=')[1], 'base64url').toString());
    expect(proof).toMatchObject({ v: 1, address: account.address, nonce });
    expect(proof.signature).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it.each([
    ['denial', child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'REJECTED' } })), 'metamask_denied'],
    ['login', child('', Object.assign(new Error(secret), { code: 1 }), JSON.stringify({ ok: false, error: { code: 'AUTH_FAILED', message: secret } })), 'metamask_login_required'],
    ['pending', child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'AWAITING_MFA', pollingId: secret } })), 'metamask_approval_pending'],
    ['missing executable', child('', Object.assign(new Error(`spawn ${secret}`), { code: 'ENOENT' })), 'metamask_not_found'],
    ['signature by another wallet', signingChild(wrongAccount), 'proof_signing_failed'],
    ['non-JSON output', child(secret), 'proof_signing_failed'],
  ])('returns a fixed code on %s without leaking child output', async (_label, execFileImpl, code) => {
    const { active } = proveRuntime(execFileImpl);
    const result = await active.callTool('wallet_prove', {});
    expect(decode(result)).toEqual({ ok: false, error: code });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(execFileImpl).toHaveBeenCalledOnce();
  });
});

describe('Metamask startup validation', () => {
  it.each([' metamask', 'metamask ', 'METAMASK'])('requires the exact mode name: %s', (mode) => {
    const execFileImpl = signingChild();
    expect(() => runtime({ SIGNER_MODE: mode }, execFileImpl)).toThrow(/SIGNER_MODE/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });
  it.each(['METAMASK_AGENT_ADDRESS'])('rejects missing or blank %s at startup without echoing values or falling back', (name) => {
    const execFileImpl = signingChild();
    for (const value of [undefined, '', '   ']) {
      expect(() => runtime({ [name]: value, BUYER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }, execFileImpl))
        .toThrow(new RegExp(`^${name} is required when SIGNER_MODE=metamask$`));
    }
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('returns a fixed startup error for an invalid address', () => {
    expect(() => runtime({ METAMASK_AGENT_ADDRESS: secret })).toThrow(/^METAMASK_AGENT_ADDRESS must be an EVM address when SIGNER_MODE=metamask$/);
  });

  it.each(['/tmp/metamask', './metamask', 'metamask --debug', 'metamask;env', '../metamask', 'metamask\\bin'])('rejects non-PATH executable names: %s', (bin) => {
    expect(() => runtime({ MM_BIN: bin })).toThrow(/^MM_BIN must be a PATH executable name$/);
  });

  it('rejects a relative ledger directory at startup without creating it', async () => {
    expect(() => runtime({ OPENPAY_X402_HOME: './metamask-state' })).toThrow(/^wallet_home_not_absolute$/);
    expect(await readdir(home)).toEqual([]);
  });
});

describe('MetaMask envelope and error containment', () => {
  const failure = (code: number | string | null, extra = {}) => Object.assign(new Error(secret), { code, ...extra });
  const envelope = (code: string) => JSON.stringify({ ok: false, error: { code, message: secret, hint: secret } });

  it.each([
    'AUTH_FAILED', 'AUTH_ERROR', 'TOKEN_INVALID', 'TOKEN_REFRESH_FAILED', 'NO_AUTH_TOKEN', 'NO_PROJECT_ID', 'SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'REFRESH_CLI_TOKEN_FAILED',
    'TOKEN_NOT_FOUND', 'RATE_LIMITED',
    'PERMISSION_DENIED', 'WALLET_POLICY_APPROVAL_REJECTED', 'TRADING_MODE_APPROVAL_REJECTED',
    '__proto__', 'constructor', 'DENIED', 'PENDING', 'LOGIN', 'unknown',
  ])('contains stderr code %s on exit 1', async (code) => {
    const execFileImpl = child('', failure(1), envelope(code));
    const { active, paidFetch } = runtime({}, execFileImpl);
    const result = await pay(active);
    const expected = ['AUTH_FAILED', 'AUTH_ERROR', 'TOKEN_INVALID', 'TOKEN_REFRESH_FAILED', 'NO_AUTH_TOKEN', 'NO_PROJECT_ID', 'SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'REFRESH_CLI_TOKEN_FAILED'].includes(code)
      ? 'metamask_login_required' : 'metamask_sign_failed';
    expect(decode(result)).toMatchObject({ ok: false, error: expected });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['byok', { mode: 'byok', status: 'SIGNED' }, 'metamask_sign_failed'],
    ['missing mode', { status: 'SIGNED' }, 'metamask_sign_failed'],
    ['null signature', { mode: 'server', status: 'SIGNED', signature: null }, 'metamask_sign_failed'],
    ...['EVALUATING', 'AWAITING_MFA', 'SIGNING'].map((status): [string, Record<string, unknown>, string] => [status, { mode: 'server', status, pollingId: secret }, 'metamask_approval_pending']),
    ...['REJECTED', 'BLOCKED'].map((status): [string, Record<string, unknown>, string] => [status, { mode: 'server', status }, 'metamask_denied']),
    ...['EXPIRED', 'CANCELLED', 'FAILED', 'SIGNING_FAILED'].map((status): [string, Record<string, unknown>, string] => [status, { mode: 'server', status }, 'metamask_sign_failed']),
    ...['EXPIRED', 'CANCELLED', 'FAILED', 'SIGNING_FAILED'].map((status): [string, Record<string, unknown>, string] => [`${status} with pollingId`, { mode: 'server', status, pollingId: secret }, 'metamask_sign_failed']),
    ['polling only', { mode: 'server', pollingId: secret }, 'metamask_approval_pending'],
    ['missing status', { mode: 'server' }, 'metamask_sign_failed'],
  ])('rejects %s even with an otherwise valid signature', async (_label, data, code) => {
    const signature = await account.signTypedData(typedData());
    const execFileImpl = child(JSON.stringify({ ok: true, data: { signature, ...data } }));
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(new RegExp(`^${code}$`));
  });

  it.each([
    ['exit 0 ok:false stdout', null, envelope('AUTH_FAILED'), '', 'metamask_sign_failed'],
    ['exit 0 ok:false stderr', null, '', envelope('AUTH_FAILED'), 'metamask_login_required'],
    ['missing executable', failure('ENOENT'), '', secret, 'metamask_not_found'],
    ['overflow', failure('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'), '', envelope('AUTH_FAILED'), 'metamask_sign_failed'],
    ['signal', failure(1, { signal: 'SIGTERM' }), '', envelope('AUTH_FAILED'), 'metamask_sign_failed'],
    ['killed', failure(null, { killed: true }), '', envelope('AUTH_FAILED'), 'metamask_sign_failed'],
    ['malformed stderr', failure(1), '', secret, 'metamask_sign_failed'],
    ['non-JSON stdout', null, secret, '', 'metamask_sign_failed'],
    ['NDJSON', null, '{}\n{}', '', 'metamask_sign_failed'],
    ['unrecognized envelope', failure(1), '', JSON.stringify({ error: { code: 'AUTH_FAILED' } }), 'metamask_sign_failed'],
  ])('%s never exposes child output', async (_label, error, stdout, stderr, code) => {
    const { active, paidFetch } = runtime({}, child(stdout as string, error as ChildError | null, stderr as string));
    const result = await pay(active);
    expect(decode(result)).toMatchObject({ ok: false, error: code });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it('prioritizes an AUTH_FAILED stderr envelope over valid SIGNED stdout on exit 0', async () => {
    const signature = await account.signTypedData(typedData());
    const execFileImpl = child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'SIGNED', signature } }), null, envelope('AUTH_FAILED'));
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^metamask_login_required$/);
  });

  it.each([
    ['AUTH_FAILED', 'metamask_login_required'],
    ['JOB_TIMEOUT', 'metamask_approval_pending'],
    ['RATE_LIMITED', 'metamask_sign_failed'],
  ])('parses an intent echo followed by a pretty JSON %s envelope on exit 1', async (code, expected) => {
    const stderr = `Intent: OpenPay x402 payment\n${JSON.stringify({ ok: false, error: { code, message: secret } }, null, 2)}\n`;
    const execFileImpl = child('', failure(1), stderr);
    await expect(createMetamaskSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(new RegExp(`^${expected}$`));
  });

  it('returns the signature when stderr only carries the intent echo (mm 7.0.0 success shape)', async () => {
    const { active, paidFetch } = runtime({}, signingChild());
    const result = await pay(active);
    expect(decode(result)).toMatchObject({ status: 200 });
    expect(paidFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores non-envelope stderr noise and still judges stdout on exit 0', async () => {
    const execFileImpl = child(JSON.stringify({ ok: true, data: { mode: 'server', status: 'AWAITING_MFA', pollingId: secret } }), null, `Intent: ${secret}\nwarning: ${secret}\n`);
    const { active, paidFetch } = runtime({}, execFileImpl);
    const result = await pay(active);
    expect(decode(result)).toMatchObject({ ok: false, error: 'metamask_approval_pending' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it('rejects exit 1 with valid SIGNED output and never falls back to an env key or Steward', async () => {
    const execFileImpl: ExecFile = (bin, args, options, callback) => signingChild()(bin, args, options,
      (_error, stdout) => callback(failure(1), stdout, ''));
    const { active, paidFetch } = runtime({ BUYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, STEWARD_URL: 'https://unused.test', STEWARD_SIGNER_SECRET: secret }, execFileImpl);
    expect(decode(await pay(active))).toMatchObject({ ok: false, error: 'metamask_sign_failed' });
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it('contains native exceptions and releases the adapter queue after failure', async () => {
    const execFileImpl = signingChild().mockImplementationOnce(() => { throw new Error(secret); });
    const signer = createMetamaskSigner(env(), { execFileImpl });
    const first = signer.signTypedData(typedData());
    const second = signer.signTypedData(typedData());
    await expect(first).rejects.toThrow(/^metamask_sign_failed$/);
    await expect(second).resolves.toBe(await account.signTypedData(typedData()));
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the fallback intent for another primary type', async () => {
    const execFileImpl = signingChild();
    const data = typedData();
    await createMetamaskSigner(env(), { execFileImpl }).signTypedData({ ...data, primaryType: 'Other', types: { Other: data.types.ReceiveWithAuthorization } } as unknown as typeof data);
    expect(execFileImpl.mock.calls[0][1][7]).toBe('OpenPay signature');
    expect(execFileImpl.mock.calls[0][0]).toBe('mm');
  });

  it.each(['MM_CLI_TOKEN', 'MM_MNEMONIC', 'MM_PASSWORD'])('refuses presence of %s without reading it', (key) => {
    for (const value of [undefined, '', secret]) {
      expect(() => runtime({ [key]: value })).toThrow(/^MM_CLI_TOKEN, MM_MNEMONIC and MM_PASSWORD must not be set for SIGNER_MODE=metamask$/);
    }
    const config = Object.defineProperty(env(), key, { get() { throw new Error(secret); } });
    expect(() => createMetamaskSigner(config, { execFileImpl: signingChild() })).toThrow(/^MM_CLI_TOKEN, MM_MNEMONIC and MM_PASSWORD must not be set for SIGNER_MODE=metamask$/);
  });

  it('serializes concurrent wallet_prove and pay on the same adapter', async () => {
    let release!: () => void;
    const execFileImpl = signingChild().mockImplementationOnce((bin, args, options, callback) => {
      release = () => { signingChild()(bin, args, options, callback); };
      return fakeChild();
    });
    const now = Math.floor(Date.now() / 1000);
    const { active } = runtime({}, execFileImpl, undefined, {
      fetchImpl: async (url: unknown, init?: RequestInit) => {
        if (String(url).includes('/proof/challenge')) return json({ nonce: `0x${'ab'.repeat(32)}`, issuedAt: now, expiresAt: now + 300 });
        return new Headers(init?.headers).has('X-PAYMENT') ? json({ answer: 'demo' }) : json({ accepts: [accept()] }, 402);
      },
    });
    const proof = active.callTool('wallet_prove', {});
    await vi.waitFor(() => expect(execFileImpl).toHaveBeenCalledOnce());
    const payment = pay(active);
    // Allow the payment's asynchronous guards/store work to reach the signer queue.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(execFileImpl).toHaveBeenCalledOnce();
    release();
    expect(decode(await proof).ok).toBe(true);
    expect(decode(await payment).status).toBe(200);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls.map((call) => call[1][7])).toEqual(['OpenPay wallet proof (no payment)', 'OpenPay x402 payment']);
  });
});

describe('MetaMask adapter mutex', () => {
  it('does not start a queued signature before the first callback and verification finish', async () => {
    let release!: () => void;
    const execFileImpl = signingChild().mockImplementationOnce((bin, args, options, callback) => {
      release = () => { signingChild()(bin, args, options, callback); };
      return fakeChild();
    });
    const signer = createMetamaskSigner(env(), { execFileImpl });
    const first = signer.signTypedData(typedData());
    const second = signer.signTypedData(typedData(137));
    await Promise.resolve();
    expect(execFileImpl).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBe(await account.signTypedData(typedData()));
    await expect(second).resolves.toBe(await account.signTypedData(typedData(137)));
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('releases its own queue on deadline and ignores the timed-out callback', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const stuck = fakeChild();
    const execFileImpl = signingChild().mockImplementationOnce(() => stuck);
    const signer = createMetamaskSigner(env(), { execFileImpl });
    const first = signer.signTypedData(typedData());
    const rejected = expect(first).rejects.toThrow(/^metamask_approval_pending$/);
    await vi.advanceTimersByTimeAsync(29_999);
    const second = signer.signTypedData(typedData(137));
    expect(execFileImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await expect(second).resolves.toBe(await account.signTypedData(typedData(137)));
    execFileImpl.mock.calls[0][3](null, JSON.stringify({ ok: true, data: {
      mode: 'server', status: 'SIGNED', signature: await account.signTypedData(typedData()),
    } }), '');
    await expect(first).rejects.toThrow(/^metamask_approval_pending$/);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
