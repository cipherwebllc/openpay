// @vitest-environment node
// 第 7 回レビュー PR27 の Codex 指摘 4 件 (「KV helper は throw しない」の反例) を、本物の lib/kv の transport を通して
// 呼出側の応答で固定する。どれも main と同じ応答 (limiter は通す・API は 503 / storage_error) になること。
// 呼出側の catch (波及を断つ隔離・掟 13) と lib/kv の no-throw の改善の、どちらか一方だけでもこの応答になる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warnThrows: false,
  randomThrows: false,
  sessionToken: 'ab'.repeat(32),
}));

vi.mock('@/lib/logger', () => {
  const warn = vi.fn(() => {
    if (h.warnThrows) throw new Error('sentry transport down');
  });
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } };
});
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((size: number) => {
      if (h.randomThrows) throw new Error('entropy source unavailable');
      return actual.randomBytes(size);
    }) as typeof actual.randomBytes,
  };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: h.sessionToken }) }),
}));
vi.mock('@/lib/tokens', () => ({
  defaultDeploymentForSymbol: () => ({
    symbol: 'jpyc',
    address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    chainId: 137,
  }),
}));
vi.mock('@/lib/relay/forwarderConfig', () => ({ jpycForwarderFor: () => null }));

const KV_URL = 'https://counterexample-kv.test';
const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const HASHED_IP = 'a'.repeat(64);
const fetchMock = vi.fn();
let etherscanCalls = 0;

/** KV への往復には reply を返し、Etherscan には空の履歴を返す。 */
function kvReplies(reply: () => unknown): void {
  fetchMock.mockImplementation((input: string | URL) => {
    if (String(input).startsWith('https://api.etherscan.io/')) {
      etherscanCalls += 1;
      return Promise.resolve(Response.json({ status: '0', message: 'No transactions found', result: [] }));
    }
    return reply();
  });
}

beforeEach(() => {
  // 期限の失敗の警告は 1 instance 10 分に 1 回までなので、test ごとに lib/kv を読み直す。
  vi.resetModules();
  h.warnThrows = false;
  h.randomThrows = false;
  etherscanCalls = 0;
  fetchMock.mockReset();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', KV_URL);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'counterexample-token');
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('ETHERSCAN_API_KEY', 'counterexample-etherscan-key');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Codex 1: INCR 成功・EXPIRE NX 失敗の警告出力 (logger) が投げる', () => {
  const expireFailed = (count: number) => () =>
    Promise.resolve(new Response(JSON.stringify([{ result: count }, { error: 'ERR injected' }])));

  it('checkIpRateLimit (relay・SIWE 等の入口) は 500 にせず通す', async () => {
    h.warnThrows = true;
    kvReplies(expireFailed(1));
    const { checkIpRateLimit } = await import('@/lib/relay/relayGuards');
    await expect(checkIpRateLimit('relay-admission', HASHED_IP, 120, 60)).resolves.toBe(true);
    const { logger } = await import('@/lib/logger');
    expect(logger.warn).toHaveBeenCalledWith('kv.incr_expire_failed', { detail: 'ERR injected' });
  });

  it('取得できた超過の判定は捨てない (lib/kv が警告の例外を隔離して数を返す)', async () => {
    h.warnThrows = true;
    kvReplies(expireFailed(121));
    const { checkIpRateLimit } = await import('@/lib/relay/relayGuards');
    await expect(checkIpRateLimit('relay-admission', HASHED_IP, 120, 60)).resolves.toBe(false);
  });

  it('Agent Activity の共有 API 予算は閲覧を止めない', async () => {
    h.warnThrows = true;
    kvReplies(expireFailed(1));
    const { fetchAgentActivity } = await import('@/lib/agent/activityServer');
    await expect(fetchAgentActivity(`0x${'1'.repeat(40)}`)).resolves.toMatchObject({ ok: true });
    expect(etherscanCalls).toBe(1);
  });
});

describe('Codex 2: LRANGE の応答が配列でない ({"result":{}})', () => {
  it('チップのメッセージ一覧は空と区別して null (API は 503)', async () => {
    kvReplies(() => Promise.resolve(new Response('{"result":{}}')));
    const { listTipMessages } = await import('@/lib/tipMessages');
    await expect(listTipMessages(OWNER)).resolves.toBeNull();
  });
});

describe('Codex 3: challenge の乱数生成 (randomBytes) が投げる', () => {
  it('storage_error を返し、nonce を保存しない', async () => {
    h.randomThrows = true;
    kvReplies(() => Promise.resolve(new Response('{"result":null}')));
    const { issueAgentProofChallenge } = await import('@/lib/agent/proof');
    await expect(issueAgentProofChallenge(OWNER.toLowerCase())).resolves.toEqual({ ok: false, reason: 'storage_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- Codex 2 回目: 型検証の掛け漏れ (数値・SET の 'OK'・EVAL の応答) ---
const reply = (body: string) => () => Promise.resolve(new Response(body));

describe('Codex 2-1: 単発 INCR の応答が数値でない', () => {
  it('{"result":{}} で read limiter は KV 障害と同じく通す (拒否に化けない)', async () => {
    kvReplies(reply('{"result":{}}'));
    const { checkReadRateLimit } = await import('@/lib/relay/relayGuards');
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(true);
  });

  it('toString / valueOf の無い object でも、read limiter と relay の日次予算は大小比較で投げない', async () => {
    kvReplies(reply('{"result":{"toString":null,"valueOf":null}}'));
    const { checkReadRateLimit, checkGasBudget } = await import('@/lib/relay/relayGuards');
    await expect(checkReadRateLimit('logpay:unknown', 60, 60)).resolves.toBe(true);
    // 日次予算は INCR 失敗と同じ fail-open (数えていないので refund もしない)。
    await expect(checkGasBudget(137)).resolves.toEqual({ allowed: true, consumed: false, refundToken: null });
  });
});

describe('Codex 2-2: SET NX の応答が "OK" でも null でもない', () => {
  it('relay の idempotency claim を「取れた」(first) と読まず、fail-safe の duplicate にする', async () => {
    kvReplies(reply('{"result":{}}'));
    const { makeIdempotency } = await import('@/lib/relay/relayGuards');
    const { claimIdempotency } = makeIdempotency('relay:idem:');
    await expect(claimIdempotency(137, `0x${'1'.repeat(40)}`, `0x${'2'.repeat(64)}`)).resolves.toEqual({
      status: 'duplicate',
      txHash: null,
    });
  });
});

describe('Codex 2-3: pending intent の列挙 (EVAL) の応答が配列でない', () => {
  it.each(['{"result":{}}', '{"result":"x"}', '{"result":[1]}'])(
    '%s で reconcilePendingPurchases は TypeError で落ちず storage を返す',
    async (body) => {
      kvReplies(reply(body));
      const { reconcilePendingPurchases } = await import('@/lib/x402/purchaseIntent');
      await expect(reconcilePendingPurchases({ now: 1_800_000_000_000 })).resolves.toBe('storage');
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('正当な空の列挙 ([]) は storage にしない', async () => {
    kvReplies(reply('{"result":[]}'));
    const { reconcilePendingPurchases } = await import('@/lib/x402/purchaseIntent');
    await expect(reconcilePendingPurchases({ now: 1_800_000_000_000 })).resolves.toMatchObject({ checked: 0 });
  });
});

describe('Codex 4: KV の送信が文字列化できない値で reject する (errInfo の String(Object.create(null)))', () => {
  it('Agent 購入履歴のセッションは private な 503 (storage_error)', async () => {
    kvReplies(() => Promise.reject(Object.create(null)));
    const { purchasesSession } = await import('@/lib/agent/purchasesHttp');
    const result = await purchasesSession();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toEqual({ reason: 'storage_error' });
    expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
