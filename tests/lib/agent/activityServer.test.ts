import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/kv', () => ({
  isKvConfigured: vi.fn(),
  kvIncr: vi.fn(),
  kvExpire: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/tokens', () => ({ defaultDeploymentForSymbol: vi.fn() }));
vi.mock('@/lib/relay/forwarderConfig', () => ({ jpycForwarderFor: vi.fn() }));

import { fetchAgentActivity } from '@/lib/agent/activityServer';
import { isKvConfigured, kvExpire, kvIncr } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const ADDRESS = `0x5ce3${'1'.repeat(36)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const FORWARDER = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
const CONTRACT = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const NOW = Date.UTC(2026, 8, 21, 1, 2, 3, 456);
const DEPLOYMENT = {
  symbol: 'jpyc',
  displaySymbol: 'JPYC',
  name: 'JPY Coin',
  decimals: 18,
  address: CONTRACT,
  chainId: 137,
  paymasterMode: 'sponsorship',
} as const;
const mockFetch = vi.fn<typeof fetch>();

// §2.6 の Etherscan V2 の形 (logIndex 無し・payer → forwarder の総額 2 JPYC)。
function transfer(overrides: Record<string, unknown> = {}) {
  return {
    blockNumber: '75000000',
    timeStamp: '1790000000',
    hash: HASH,
    nonce: '12',
    blockHash: `0x${'c'.repeat(64)}`,
    from: ADDRESS,
    contractAddress: CONTRACT,
    to: FORWARDER.toLowerCase(),
    value: '2000000000000000000',
    tokenName: 'JPY Coin',
    tokenSymbol: 'JPYC',
    tokenDecimal: '18',
    transactionIndex: '1',
    gas: '300000',
    gasPrice: '1000000000',
    gasUsed: '180000',
    cumulativeGasUsed: '180000',
    input: 'deprecated',
    methodId: '0x00000000',
    functionName: 'settle',
    confirmations: '30',
    statusRep: '0',
    ...overrides,
  };
}

function reply(result: unknown = [transfer()], status = '1', message = 'OK') {
  mockFetch.mockImplementation(async () => Response.json({ status, message, result }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ETHERSCAN_API_KEY', 'test-etherscan-key');
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.mocked(defaultDeploymentForSymbol).mockReturnValue(DEPLOYMENT);
  vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
  vi.mocked(isKvConfigured).mockReturnValue(true);
  vi.mocked(kvIncr).mockResolvedValue({ ok: true, value: 1 });
  vi.mocked(kvExpire).mockResolvedValue({ ok: true, value: 1 });
  reply();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fetchAgentActivity', () => {
  it.each([undefined, '', ' \t\n'])('キー未設定/空白 (%j) は上流・予算を使わない', async (key) => {
    vi.stubEnv('ETHERSCAN_API_KEY', key);
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'not_configured' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(kvIncr).not.toHaveBeenCalled();
  });

  it('残高と同じ deployment を使い、137 以外は未対応 (キー未設定より優先)', async () => {
    vi.stubEnv('ETHERSCAN_API_KEY', undefined);
    vi.mocked(defaultDeploymentForSymbol).mockReturnValue({ ...DEPLOYMENT, chainId: 80002 });
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'unsupported_chain' });
    expect(defaultDeploymentForSymbol).toHaveBeenCalledWith('jpyc');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(kvIncr).not.toHaveBeenCalled();
  });

  it.each(['', ADDRESS.toUpperCase(), ADDRESS.slice(2), `${ADDRESS}\n`, `${ADDRESS}0`])(
    '内部でも不正な address (%j) を拒否する', async (address) => {
      expect(await fetchAgentActivity(address)).toEqual({ ok: false, reason: 'invalid_address' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(defaultDeploymentForSymbol).not.toHaveBeenCalled();
      expect(kvIncr).not.toHaveBeenCalled();
    },
  );

  it('forwarder 宛ての総額を out・OpenPay 経由として返す', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    reply([transfer({ hash: HASH.toUpperCase(), from: ADDRESS.toUpperCase(), to: FORWARDER })]);
    expect(await fetchAgentActivity(ADDRESS)).toEqual({
      ok: true,
      chainId: 137,
      items: [{
        key: `${HASH}:${ADDRESS}:${FORWARDER.toLowerCase()}:2000000000000000000:0`,
        hash: HASH,
        timestamp: 1790000000,
        direction: 'out',
        counterparty: FORWARDER.toLowerCase(),
        valueAtomic: '2000000000000000000',
        viaOpenPay: true,
      }],
      rawCount: 1,
      truncated: false,
      asOf: Math.floor(NOW / 1000),
    });
    expect(jpycForwarderFor).toHaveBeenCalledWith(137);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://api.etherscan.io/v2/api');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      chainid: '137', module: 'account', action: 'tokentx',
      contractaddress: CONTRACT.toLowerCase(), address: ADDRESS,
      page: '1', offset: '50', sort: 'desc', apikey: 'test-etherscan-key',
    });
    expect(init).toEqual({ signal: expect.anything(), cache: 'no-store', redirect: 'error' });
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('forwarder 未設定では viaOpenPay=false', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({
      ok: true, items: [{ direction: 'out', viaOpenPay: false }],
    });
  });

  it('deployment の address override を取得と照合の両方に使う', async () => {
    const override = `0x${'d'.repeat(40)}` as const;
    vi.mocked(defaultDeploymentForSymbol).mockReturnValue({ ...DEPLOYMENT, address: override });
    reply([transfer({ contractAddress: override })]);
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(new URL(String(mockFetch.mock.calls[0][0])).searchParams.get('contractaddress')).toBe(override);
  });

  it('直接送金・入金を区別し、自己送金を除外して上流の並びを保つ', async () => {
    reply([
      transfer({ to: OTHER, timeStamp: '1790000003' }),
      transfer({ from: FORWARDER, to: ADDRESS, timeStamp: '1790000002' }),
      transfer({ from: ADDRESS, to: ADDRESS, timeStamp: '1790000001' }),
      transfer({ from: OTHER, to: ADDRESS }),
    ]);
    const result = await fetchAgentActivity(ADDRESS);
    expect(result).toMatchObject({
      ok: true, rawCount: 4,
      items: [
        { direction: 'out', counterparty: OTHER, viaOpenPay: false, timestamp: 1790000003 },
        { direction: 'in', counterparty: FORWARDER.toLowerCase(), viaOpenPay: false, timestamp: 1790000002 },
        { direction: 'in', counterparty: OTHER, viaOpenPay: false, timestamp: 1790000000 },
      ],
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.items.map((item) => item.key.split(':').at(-1))).toEqual(['0', '1', '3']);
  });

  it('同一 hash の同値行でも key が衝突せず、別 hash は 0 から始まる', async () => {
    reply([transfer(), transfer({ hash: `0x${'b'.repeat(64)}` }), transfer()]);
    const result = await fetchAgentActivity(ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(new Set(result.items.map((item) => item.key)).size).toBe(3);
    expect(result.items.map((item) => item.key.split(':').at(-1))).toEqual(['0', '0', '1']);
  });

  it.each(['1', '0'])('正規の空配列 (status=%s) は成功', async (status) => {
    reply([], status, status === '0' ? 'No transactions found' : 'OK');
    expect(await fetchAgentActivity(ADDRESS)).toEqual({
      ok: true, chainId: 137, items: [], rawCount: 0, truncated: false, asOf: Math.floor(NOW / 1000),
    });
  });

  it.each([
    null, [], 'No transactions found', {},
    { status: 1, message: 'OK', result: [] },
    { status: '1', message: 'OK', result: {} },
    { status: '0', message: 'NOTOK', result: 'Max rate limit reached' },
    { status: '0', message: 'NOTOK', result: [] },
    { status: '0', message: 'No transactions found', result: [transfer()] },
    { status: '0', result: [] },
    { status: '2', message: 'OK', result: [] },
  ])('不正な応答形・上流エラー (%j) を空履歴にしない', async (body) => {
    mockFetch.mockResolvedValue(Response.json(body));
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([301, 429, 500])('HTTP %s は upstream', async (status) => {
    mockFetch.mockResolvedValue(Response.json({ status: '1', result: [] }, { status }));
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('不正 JSON は upstream', async () => {
    mockFetch.mockResolvedValue(new Response('<html>upstream error</html>'));
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
    expect(logger.warn).toHaveBeenCalledWith('agent.activity.upstream', { kind: 'json' });
  });

  it.each(['AbortError', 'TimeoutError'])('%s は再試行せず upstream', async (name) => {
    mockFetch.mockRejectedValue(new DOMException('timed out', name));
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { hash: '0x123' }, { hash: `${HASH}\n` }, { hash: `0x${'z'.repeat(64)}` },
    { from: '0x123' }, { to: '0x123' }, { from: `${ADDRESS}\n` },
    { value: '1.5' }, { value: '-1' }, { value: '1e18' }, { value: '' },
    { value: '9'.repeat(79) }, { value: '1\n' }, { value: 1 },
    { timeStamp: '0' }, { timeStamp: '-1' }, { timeStamp: '1.5' },
    { timeStamp: '1e9' }, { timeStamp: '9007199254740992' },
    { timeStamp: '1790000000\n' }, { timeStamp: 1790000000 },
    { contractAddress: OTHER }, { contractAddress: null },
    { from: OTHER, to: FORWARDER },
  ])('不正行 (%j) は正常行も含め全体を upstream にする', async (invalid) => {
    reply([transfer(), transfer(invalid)]);
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
  });

  it.each([null, [], 'bad row'])('行が object でない (%j) 場合も全体を拒否', async (invalid) => {
    reply([transfer(), invalid]);
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
  });

  it('78 桁の巨大額・最小単位・0・先頭 0 を文字列のまま保つ', async () => {
    const values = ['9'.repeat(78), '1', '0', '0001'];
    reply(values.map((value) => transfer({ value })));
    const result = await fetchAgentActivity(ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.items.map((item) => item.valueAtomic)).toEqual(values);
  });

  it.each([49, 50, 51])('除外前の rawCount=%i で truncated を判定', async (count) => {
    reply(Array.from({ length: count }, () => transfer({ to: ADDRESS })));
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({
      ok: true, items: [], rawCount: count, truncated: count >= 50,
    });
  });
});

describe('共有 API 予算・同時取得', () => {
  it('分 120・日 30,000 の境界は通し、UTC のキーと TTL を設定', async () => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: true, value: 120 })
      .mockResolvedValueOnce({ ok: true, value: 30_000 });
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(kvIncr).toHaveBeenNthCalledWith(1, `agent:activity:budget:m:${Math.floor(NOW / 60_000)}`);
    expect(kvIncr).toHaveBeenNthCalledWith(2, 'agent:activity:budget:d:2026-09-21');
    expect(kvExpire).toHaveBeenNthCalledWith(1, `agent:activity:budget:m:${Math.floor(NOW / 60_000)}`, 120);
    expect(kvExpire).toHaveBeenNthCalledWith(2, 'agent:activity:budget:d:2026-09-21', 172800);
  });

  it('分上限超過なら busy で上流を呼ばない', async () => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: true, value: 121 });
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'busy' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(kvIncr).toHaveBeenCalledTimes(1);
  });

  it('日上限超過なら busy で上流を呼ばない', async () => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: true, value: 1 })
      .mockResolvedValueOnce({ ok: true, value: 30_001 });
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'busy' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('KV 未設定は fail-open', async () => {
    vi.mocked(isKvConfigured).mockReturnValue(false);
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(kvIncr).not.toHaveBeenCalled();
  });

  it.each(['unconfigured', 'network_error', 'http_error', 'parse_error', 'timeout'] as const)(
    'KV の %s は fail-open', async (reason) => {
      vi.mocked(kvIncr).mockResolvedValue({ ok: false, reason });
      expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['incr', 'expire-result', 'expire-throw'])('KV 例外・TTL 障害 (%s) は fail-open', async (kind) => {
    if (kind === 'incr') vi.mocked(kvIncr).mockRejectedValue(new Error('KV down'));
    if (kind === 'expire-result') vi.mocked(kvExpire).mockResolvedValue({ ok: false, reason: 'timeout' });
    if (kind === 'expire-throw') vi.mocked(kvExpire).mockRejectedValue(new Error('KV down'));
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('分 KV が失敗しても、取得できた日上限は適用する', async () => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValueOnce({ ok: true, value: 30_001 });
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'busy' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([true, false])('同時 2 呼出しを集約し、完了 (ok=%s) 後は取得し直す', async (ok) => {
    let finish!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => { finish = resolve; });
    mockFetch.mockReturnValueOnce(held);
    const first = fetchAgentActivity(ADDRESS);
    const second = fetchAgentActivity(ADDRESS);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(kvIncr).toHaveBeenCalledTimes(2);
    finish(ok ? Response.json({ status: '1', result: [] }) : new Response('', { status: 500 }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(ok);
    reply([]);
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(kvIncr).toHaveBeenCalledTimes(4);
  });

  it('fetch 例外の後も取得し直せる', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'upstream' });
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('busy の後も取得し直せる', async () => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: true, value: 121 });
    expect(await fetchAgentActivity(ADDRESS)).toEqual({ ok: false, reason: 'busy' });
    expect(await fetchAgentActivity(ADDRESS)).toMatchObject({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('異なるアドレスは集約せず個別に予算を消費', async () => {
    reply([]);
    const results = await Promise.all([fetchAgentActivity(ADDRESS), fetchAgentActivity(OTHER)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(kvIncr).toHaveBeenCalledTimes(4);
  });
});

describe('漏洩フェンス', () => {
  it.each(['fetch', 'json', 'body', 'kv'])('%s の秘密・照会 URL・本文・照会アドレスを外に出さない', async (kind) => {
    vi.stubEnv('ETHERSCAN_API_KEY', 'SECRET');
    const url = `https://api.etherscan.io/v2/api?address=${ADDRESS}&apikey=SECRET`;
    const secretText = `PRIVATE_UPSTREAM_BODY ${url}`;
    if (kind === 'fetch') mockFetch.mockRejectedValue(new Error(secretText));
    if (kind === 'json') mockFetch.mockResolvedValue(new Response(secretText));
    if (kind === 'body') reply(secretText, '0', 'NOTOK');
    if (kind === 'kv') {
      vi.mocked(kvIncr).mockResolvedValue({ ok: false, reason: 'http_error', detail: secretText });
      reply([]);
    }
    const result = await fetchAgentActivity(ADDRESS);
    expect(result.ok).toBe(kind === 'kv');
    const exposed = JSON.stringify([result, ...Object.values(logger).map((fn) => vi.mocked(fn).mock.calls)]);
    for (const value of ['SECRET', 'PRIVATE_UPSTREAM_BODY', url, ADDRESS, 'api.etherscan.io']) {
      expect(exposed).not.toContain(value);
    }
    if (kind !== 'kv') expect(result).toEqual({ ok: false, reason: 'upstream' });
  });
});
