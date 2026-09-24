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
const { createKovaSigner } = await import(pathToFileURL(resolve('packages/x402-mcp/src/kova-signer.mjs')).href) as {
  createKovaSigner: (env: Record<string, string | undefined>, options: { execFileImpl: ExecFile }) => {
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
  home = await mkdtemp(join(tmpdir(), 'x402-kova-'));
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
    HOME: home, SIGNER_MODE: 'kova', KOVA_WALLET: 'small-wallet', KOVA_AGENT_ADDRESS: account.address,
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

function child(stdout: string, error: ChildError | null = null, stderr = secret) {
  return vi.fn<ExecFile>((_bin, _args, _options, callback) => {
    callback(error, stdout, stderr);
    return fakeChild();
  });
}

function signingChild(signer = account) {
  return vi.fn<ExecFile>((_bin, args, _options, callback) => {
    void signer.signTypedData(JSON.parse(args[7])).then(
      (signature) => callback(null, JSON.stringify({ ok: true, data: { signature }, debug: secret }), secret),
      (error) => callback(error, '', secret),
    );
    return fakeChild();
  });
}

function runtime(overrides: Record<string, string | undefined> = {}, kovaExecFile: ExecFile = signingChild(), network = 'eip155:137', extra = {}) {
  const paidFetch = vi.fn();
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const payment = new Headers(init?.headers).get('X-PAYMENT');
    if (!payment) return json({ accepts: [accept(network)] }, 402);
    paidFetch(JSON.parse(Buffer.from(payment, 'base64').toString()));
    return json({ answer: 'demo' });
  });
  const active = createToolRuntime({
    env: env(overrides), kovaExecFile, fetchImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    nowSec: () => Math.floor(Date.now() / 1000), ...extra,
  });
  return { active, fetchImpl, paidFetch };
}
const pay = (active: Runtime, maxTotalJpyc = '2') => active.callTool('x402_pay', { url: resource, maxTotalJpyc });

describe('Kova signer adapter', () => {
  it.each([[137, 'polygon'], [80002, 'polygon-amoy']] as const)('serializes bigint losslessly, selects %s, and verifies the original typed-data', async (chainId, chain) => {
    const execFileImpl = signingChild();
    const wallet = 'wallet ; $(never-run)';
    const signer = createKovaSigner(env({ KOVA_WALLET: wallet, KOVA_BIN: 'kova-test' }), { execFileImpl });
    const data = typedData(chainId);
    const signature = await signer.signTypedData({ ...data, credential: secret } as typeof data);
    expect(signature).toBe(await account.signTypedData(data));
    expect(signer).toMatchObject({ mode: 'custom', address: account.address });
    const [bin, args, options] = execFileImpl.mock.calls[0];
    expect(bin).toBe('kova-test');
    expect(args.slice(0, 7)).toEqual(['sign', 'typed-data', '--name', wallet, '--chain', chain, '--data']);
    expect(args).toHaveLength(8);
    expect(JSON.parse(args[7])).toEqual({
      ...data, message: { ...data.message, value: data.message.value.toString(), validAfter: '0', validBefore: '1800000600' },
    });
    expect(args[7]).not.toContain(secret);
    expect(data.message.value).toBe(12345678901234567890123456789n);
    expect(options).toEqual({
      shell: false, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8',
      env: env({ KOVA_WALLET: wallet, KOVA_BIN: 'kova-test' }),
    });
  });

  it('defaults to kova and only reads a Kova credential getter when forwarding child env', async () => {
    const execFileImpl = signingChild();
    const credential = vi.fn(() => secret);
    const config = Object.defineProperty(env(), 'KOVA_CREDENTIAL', { get: credential, enumerable: true });
    const { active } = runtime({}, execFileImpl, undefined, { env: config });
    await active.walletStatus({});
    expect(credential).not.toHaveBeenCalled();
    const result = await pay(active);
    expect(decode(result).status).toBe(200);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(execFileImpl.mock.calls[0][0]).toBe('kova');
    expect(credential).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.calls[0][2].env.KOVA_CREDENTIAL).toBe(secret);
    expect(execFileImpl.mock.calls[0][1].join(' ')).not.toContain(secret);
  });

  it('excludes OpenPay secrets before reading getters and forwards only the supplied env own keys', async () => {
    vi.stubEnv('KOVA_PARENT_ONLY', 'not-in-injected-env');
    const inherited = Object.defineProperty({}, 'INHERITED_ONLY', { get() { throw new Error(secret); }, enumerable: true });
    const config = Object.assign(Object.create(inherited), env({ KOVA_CREDENTIAL: secret, PATH: '/kova/bin', CUSTOM: 'keep' }));
    for (const key of ['BUYER_PRIVATE_KEY', 'STEWARD_API_KEY', 'STEWARD_SIGNER_SECRET', 'STEWARD_URL', 'STEWARD_TENANT', 'STEWARD_AGENT_ID', 'STEWARD_AGENT_ADDRESS', 'STEWARD_SIGNER_ID', 'STEWARD_FUTURE_SECRET']) {
      Object.defineProperty(config, key, { get() { throw new Error(secret); }, enumerable: true });
    }
    const execFileImpl = signingChild();
    await createKovaSigner(config, { execFileImpl }).signTypedData(typedData());
    expect(execFileImpl.mock.calls[0][2].env).toEqual(env({ KOVA_CREDENTIAL: secret, PATH: '/kova/bin', CUSTOM: 'keep' }));
    expect(execFileImpl.mock.calls[0][2].env).not.toHaveProperty('KOVA_PARENT_ONLY');
  });

  it('filters stray OpenPay secrets on the MCP path while retaining Kova and other env values', async () => {
    const execFileImpl = signingChild();
    const { active } = runtime({
      BUYER_PRIVATE_KEY: `0x${'2'.repeat(64)}`, STEWARD_API_KEY: 'openpay-secret',
      STEWARD_SIGNER_SECRET: 'openpay-secret', STEWARD_URL: 'https://unused.test',
      STEWARD_CUSTOM: 'openpay-secret', KOVA_CREDENTIAL: secret, PATH: '/kova/bin', CUSTOM: 'keep',
    }, execFileImpl);
    expect(decode(await pay(active)).status).toBe(200);
    expect(execFileImpl.mock.calls[0][2].env).toEqual(env({ KOVA_CREDENTIAL: secret, PATH: '/kova/bin', CUSTOM: 'keep' }));
  });

  it.each([1, 8453, 80001])('rejects unsupported chain %s before launching the CLI', async (chainId) => {
    const execFileImpl = signingChild();
    await expect(createKovaSigner(env(), { execFileImpl }).signTypedData(typedData(chainId))).rejects.toThrow(/^kova_sign_failed$/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('rejects the wrong signer without disabling subsequent verification', async () => {
    const good = await account.signTypedData(typedData());
    const bad = await wrongAccount.signTypedData(typedData());
    const execFileImpl = child(JSON.stringify({ ok: true, data: { signature: bad } }));
    const signer = createKovaSigner(env(), { execFileImpl });
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
    execFileImpl.mockImplementation(child(JSON.stringify({ ok: true, data: { signature: good } })));
    await expect(signer.signTypedData(typedData())).resolves.toBe(good);
    execFileImpl.mockImplementation(child(JSON.stringify({ ok: true, data: { signature: bad } })));
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
  });

  it('verifies each response against that call\'s original typed-data', async () => {
    const signature = await account.signTypedData(typedData());
    const execFileImpl = child(JSON.stringify({ ok: true, data: { signature } }));
    const signer = createKovaSigner(env(), { execFileImpl });
    await expect(signer.signTypedData(typedData())).resolves.toBe(signature);
    const data = typedData();
    await expect(signer.signTypedData({ ...data, message: { ...data.message, nonce: `0x${'b'.repeat(64)}` } })).rejects.toThrow(/^kova_sign_failed$/);
  });

  it('rejects a newline appended to an otherwise valid signature', async () => {
    const signature = `${await account.signTypedData(typedData())}\n`;
    const execFileImpl = child(JSON.stringify({ ok: true, data: { signature } }));
    await expect(createKovaSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
  });

  it.each([
    `0x${'a'.repeat(128)}`, `0x${'a'.repeat(132)}`, 'a'.repeat(130),
    `0x${'g'.repeat(130)}`, `0x${'0'.repeat(130)}`, `0x${'a'.repeat(130)}\n`,
  ])('rejects malformed/invalid signature %# without recoveryId repair', async (signature) => {
    const execFileImpl = child(JSON.stringify({ ok: true, data: { signature, recoveryId: 27 } }));
    await expect(createKovaSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
  });

  it('still validates signature length after the first signature was verified', async () => {
    const execFileImpl = signingChild();
    const signer = createKovaSigner(env(), { execFileImpl });
    await signer.signTypedData(typedData());
    execFileImpl.mockImplementation(child(JSON.stringify({ ok: true, data: { signature: '0x1234' } })));
    await expect(signer.signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
  });
});

describe('Kova child failures through the SDK and MCP tool output', () => {
  const denied = JSON.stringify({ ok: false, error: { code: 'POLICY_DENIED', message: secret }, credential: secret });
  const failure = (code: number | string | null, extra = {}) => Object.assign(new Error(`command ${secret}`), { code, ...extra });
  it.each([
    ['denial with exit 0', null, denied, 'kova_policy_denied'],
    ['denial with exit 1', failure(1), denied, 'kova_policy_denied'],
    ['non-JSON', null, secret, 'kova_sign_failed'],
    ['unknown code', failure(1), JSON.stringify({ ok: false, error: { code: secret } }), 'kova_sign_failed'],
    ['timeout despite denial JSON', failure(null, { killed: true, signal: 'SIGTERM' }), denied, 'kova_sign_failed'],
    ['output overflow despite denial JSON', failure('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'), denied, 'kova_sign_failed'],
    ['missing executable', failure('ENOENT'), secret, 'kova_not_found'],
    ['signal', failure(1, { signal: 'SIGTERM' }), denied, 'kova_sign_failed'],
    ['unrecognized denial envelope', failure(1), JSON.stringify({ error: { code: 'POLICY_DENIED' } }), 'kova_sign_failed'],
  ])('%s is fixed and never sends a payment or exposes child output', async (_label, error, stdout, code) => {
    const execFileImpl = child(stdout as string, error as ChildError | null);
    const { active, paidFetch } = runtime({ BUYER_PRIVATE_KEY: `0x${'2'.repeat(64)}` }, execFileImpl);
    const result = await pay(active);
    expect(result.isError).toBe(true);
    expect(decode(result)).toEqual(code === 'kova_policy_denied'
      ? { ok: false, error: code, message: 'Kova の policy で拒否されました' }
      : code === 'kova_not_found'
        ? { ok: false, error: code, message: 'Kova CLI が見つかりません' }
        : { ok: false, error: code });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(paidFetch).not.toHaveBeenCalled();
    expect(execFileImpl).toHaveBeenCalledOnce();
  });

  it('rejects nonzero exit even with a valid success JSON and signature', async () => {
    const execFileImpl: ExecFile = (bin, args, options, callback) => signingChild()(bin, args, options,
      (_error, stdout) => callback(failure(1), stdout, secret));
    const { active, paidFetch } = runtime({}, execFileImpl);
    expect(decode(await pay(active))).toEqual({ ok: false, error: 'kova_sign_failed' });
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it('contains synchronous native exceptions including command/environment text', async () => {
    const { active, paidFetch } = runtime({}, () => { throw new Error(`KOVA_CREDENTIAL=${secret} kova sign typed-data --data ${secret}`); });
    expect(decode(await pay(active))).toEqual({ ok: false, error: 'kova_sign_failed' });
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it('does not fall back to a configured env key on a signer-address mismatch', async () => {
    const { active, paidFetch } = runtime({ BUYER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }, signingChild(wrongAccount));
    expect(decode(await pay(active))).toEqual({ ok: false, error: 'kova_sign_failed' });
    expect(paidFetch).not.toHaveBeenCalled();
  });
});

describe('Kova child lifetime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(fixedNow);
  });

  it('kills a SIGTERM-ignoring child and rejects at 30 seconds even without an exit callback', async () => {
    const stuck = fakeChild(); // No callback, including on SIGTERM or SIGKILL.
    const execFileImpl = vi.fn<ExecFile>(() => stuck);
    const signer = createKovaSigner(env(), { execFileImpl });
    const pending = signer.signTypedData(typedData());
    const rejected = expect(pending).rejects.toThrow(/^kova_sign_failed$/);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stuck.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(execFileImpl.mock.calls[0][2].killSignal).toBe('SIGKILL');
    expect(stuck.kill).toHaveBeenCalledOnce();
    expect(stuck.kill).toHaveBeenCalledWith('SIGKILL');
    expect(stuck.stdin.end).toHaveBeenCalledOnce();
    // Late output cannot turn a timed-out signature into success.
    execFileImpl.mock.calls[0][3](null, JSON.stringify({ ok: true, data: { signature: await account.signTypedData(typedData()) } }), secret);
    await expect(pending).rejects.toThrow(/^kova_sign_failed$/);
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
    expect(decode(await first)).toEqual({ ok: false, error: 'kova_sign_failed' });
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
    await expect(createKovaSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
    expect(execFileImpl.mock.results[0].value.stdin.end).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.results[0].value.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains stdin errors and kills the child without leaking the stream error', async () => {
    const broken = fakeChild(() => broken.stdin.emit('error', new Error(secret)));
    const execFileImpl = vi.fn<ExecFile>(() => broken);
    await expect(createKovaSigner(env(), { execFileImpl }).signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
    expect(broken.kill).toHaveBeenCalledOnce();
    expect(broken.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still rejects on deadline when the OS kill attempt throws', async () => {
    const stuck = fakeChild();
    stuck.kill.mockImplementation(() => { throw new Error(secret); });
    const rejected = expect(createKovaSigner(env(), { execFileImpl: () => stuck }).signTypedData(typedData())).rejects.toThrow(/^kova_sign_failed$/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Kova mode and daily ledger wiring', () => {
  it.each([['eip155:137', 'polygon'], ['eip155:80002', 'polygon-amoy']])('maps public kova to SDK guards and chooses the CLI chain from %s', async (network, chain) => {
    const execFileImpl = signingChild();
    const { active, paidFetch } = runtime({}, execFileImpl, network);
    expect(active.config.signerMode).toBe('steward');
    expect(await active.walletStatus({})).toMatchObject({
      signerMode: 'kova', address: account.address, chain: 'polygon', jpycBalance: null,
      limits: { dailyJpyc: '100', dailyLimitSource: 'default_kova' },
    });
    expect(decode(await pay(active)).status).toBe(200);
    expect(paidFetch).toHaveBeenCalledOnce();
    expect(paidFetch.mock.calls[0][0]).toMatchObject({ network, payload: { authorization: { from: account.address } } });
    expect(execFileImpl.mock.calls[0][1][5]).toBe(chain);
    expect(JSON.parse(execFileImpl.mock.calls[0][1][7]).domain.chainId).toBe(Number(network.split(':')[1]));
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
    expect((await active.walletStatus({})).limits).toMatchObject({ dailyJpyc: '2', dailySpentJpyc: '0', dailyLimitSource: 'default_kova' });
    expect(decode(await pay(active)).status).toBe(200);
    expect((await active.walletStatus({})).limits).toMatchObject({ dailySpentJpyc: '2', sessionSpentJpyc: '2' });
    const ledger = JSON.parse(await readFile(join(directory, 'spend.json'), 'utf8'));
    const key = `${account.address.toLowerCase()}:2026-09-25`;
    expect(ledger[key]).toBe(String(2n * unit));
    expect(Object.keys(ledger).filter((key) => !key.startsWith('__'))).toEqual([key]);
    const execFileImpl = signingChild();
    const restarted = runtime({ ...overrides, KOVA_WALLET: 'another-name', KOVA_AGENT_ADDRESS: account.address.toLowerCase() }, execFileImpl, 'eip155:80002');
    expect(decode(await pay(restarted.active)).reasons).toContain('daily_limit_exceeded');
    expect((await restarted.active.walletStatus({})).limits).toMatchObject({ dailySpentJpyc: '2', sessionSpentJpyc: '0' });
    expect(execFileImpl).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
    expect((await restarted.active.walletStatus({})).limits.dailySpentJpyc).toBe('0');
    expect(decode(await pay(restarted.active)).status).toBe(200);
    expect(await readdir(directory)).not.toContain('wallet.json');
    await expect(readFile(join(home, '.kova/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (customHome) await expect(readdir(join(home, '.openpay-x402'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports configured daily caps and rejects unsupported wallet tools without executing anything', async () => {
    const execFileImpl = signingChild();
    const { active, fetchImpl } = runtime({ MAX_DAILY_JPYC: '3' }, execFileImpl);
    expect((await active.walletStatus({})).limits).toMatchObject({ dailyJpyc: '3', dailyLimitSource: 'configured' });
    expect(decode(await active.callTool('wallet_init', {}))).toEqual({ ok: false, error: 'wallet_init_requires_keystore_mode' });
    expect(decode(await active.callTool('wallet_prove', {}))).toEqual({ ok: false, error: 'signer_mode_unsupported' });
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
    expect(await active.walletStatus({})).toMatchObject({ signerMode: 'kova', walletError: null, limits: { dailySpentJpyc: null } });
    expect(decode(await pay(active)).reasons).toContain('daily_spend_unavailable');
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'wallet.json'), 'utf8')).toBe('do-not-read-or-replace');
  });
});

describe('Kova startup validation', () => {
  it.each([' kova', 'kova ', 'KOVA'])('requires the exact mode name: %s', (mode) => {
    const execFileImpl = signingChild();
    expect(() => runtime({ SIGNER_MODE: mode }, execFileImpl)).toThrow(/SIGNER_MODE/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });
  it.each(['KOVA_WALLET', 'KOVA_AGENT_ADDRESS'])('rejects missing or blank %s at startup without echoing values or falling back', (name) => {
    const execFileImpl = signingChild();
    for (const value of [undefined, '', '   ']) {
      expect(() => runtime({ [name]: value, BUYER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }, execFileImpl))
        .toThrow(new RegExp(`^${name} is required when SIGNER_MODE=kova$`));
    }
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('returns a fixed startup error for an invalid address', () => {
    expect(() => runtime({ KOVA_AGENT_ADDRESS: secret })).toThrow(/^KOVA_AGENT_ADDRESS must be an EVM address when SIGNER_MODE=kova$/);
  });

  it.each(['/tmp/kova', './kova', 'kova --debug', 'kova;env', '../kova', 'kova\\bin'])('rejects non-PATH executable names: %s', (bin) => {
    expect(() => runtime({ KOVA_BIN: bin })).toThrow(/^KOVA_BIN must be a PATH executable name$/);
  });

  it('rejects a relative ledger directory at startup without creating it', async () => {
    expect(() => runtime({ OPENPAY_X402_HOME: './kova-state' })).toThrow(/^wallet_home_not_absolute$/);
    expect(await readdir(home)).toEqual([]);
  });
});
