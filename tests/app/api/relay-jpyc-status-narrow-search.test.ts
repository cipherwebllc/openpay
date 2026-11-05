// @vitest-environment node
// 第 9 回レビュー A-3 (PR #999): relay status の署名なしの照会 (lookup=nonce + validBefore) が、RPC の範囲制限で
// 直近 10,000 ブロックの 1 回の検索を拒まれたとき、本物の relayProvider.findAuthorizationUsedTransactionHash →
// authorizationUsedLookup (小分けの探索) → statusLookupBudget (チェーン単位の予算) を通って解決することを固定する。
// 差し替えるのはチェーン (viem の client)・KV (メモリ)・IP limiter / idempotency・flag だけ。
//   (a) 下限ちょうど (validBefore − 1230 秒) のブロックのログも見つける
//   (b) 小分けの探索の上限 (問い合わせ 60 回) を使い切ったら indeterminate (RPC は上限で止まる)
//   (c) チェーン単位の予算を使い切ったら小分けの探索を始めず indeterminate (窓が無いときと同じ)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAbi, type Address, type Hex } from 'viem';

const TX = `0x${'ab'.repeat(32)}` as Hex;
const FROM = '0x1111111111111111111111111111111111111111' as Address;
const MERCHANT = '0x4444444444444444444444444444444444444444' as Address;
const NONCE = `0x${'11'.repeat(32)}` as Hex;
const VALUE = 1_000_000_000_000_000_000n;
const T0 = 1_800_000_000n;
// Polygon と同じ 2 秒ごとのブロック
const ts = (n: bigint) => T0 + n * 2n;

const chainState = vi.hoisted(() => ({
  latest: 20_700n,
  /** 1 回の getLogs で許すブロック数 (無料枠の RPC の範囲制限)。 */
  maxRange: 100n,
  /** 対象の AuthorizationUsed ログがあるブロック。 */
  logBlock: 20_000n,
  token: '0x0000000000000000000000000000000000000000' as Address,
  calls: { getLogs: 0, getBlock: 0 },
}));

const kv = vi.hoisted(() => ({
  configured: true,
  store: new Map<string, { value: string; expiresAt: number | null }>(),
  /** 次の SET を書かずに失敗させる (応答の喪失・保存の障害)。 */
  failNextSet: false,
}));

const EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async () => true, // authorizationState: 使用済み
      getBlockNumber: async () => chainState.latest,
      getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
        chainState.calls.getBlock += 1;
        const n = args.blockTag === 'latest' ? chainState.latest : args.blockNumber!;
        return { number: n, timestamp: ts(n) };
      },
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        chainState.calls.getLogs += 1;
        if (toBlock - fromBlock + 1n > chainState.maxRange) {
          throw new Error(`eth_getLogs is limited to a ${chainState.maxRange} block range`);
        }
        return chainState.logBlock >= fromBlock && chainState.logBlock <= toBlock
          ? [{ transactionHash: TX }]
          : [];
      },
      getTransactionReceipt: async () => ({
        status: 'success',
        logs: [
          {
            address: chainState.token,
            topics: actual.encodeEventTopics({
              abi: EVENTS,
              eventName: 'AuthorizationUsed',
              args: { authorizer: FROM, nonce: NONCE },
            }),
            data: '0x',
          },
          {
            address: chainState.token,
            topics: actual.encodeEventTopics({
              abi: EVENTS,
              eventName: 'Transfer',
              args: { from: FROM, to: MERCHANT },
            }),
            data: actual.encodeAbiParameters([{ type: 'uint256' }], [VALUE]),
          },
        ],
      }),
    }),
  };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableJpycEip3009: true } };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// 本物の finder (relayProvider) を使う。provider だけ有効にする (env の秘密鍵に頼らない)。
vi.mock('@/lib/relay/relayProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relayProvider')>()),
  PROVIDER: 'self-host',
}));
vi.mock('@/lib/relay/relayGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relayGuards')>()),
  checkIpRateLimit: async () => true,
  readIdempotency: async () => ({ state: 'missing' }),
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => null,
}));
vi.mock('@/lib/jpycEip3009', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jpycEip3009')>()),
  recoverTransferAuthorizationSigner: async () => FROM,
}));
// KV はメモリ (SET NX EX・INCR + 初回の期限・「自分の値のときだけ消す」EVAL)。期限は Date.now (偽の時計) で切れる。
vi.mock('@/lib/kv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kv')>();
  const live = (key: string) => {
    const e = kv.store.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      kv.store.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    ...actual,
    isKvConfigured: () => kv.configured,
    kvSet: async (key: string, value: string, opts: { nx?: boolean; ttlSec?: number } = {}) => {
      if (kv.failNextSet) {
        kv.failNextSet = false;
        return { ok: false, reason: 'http_error' };
      }
      if (opts.nx && live(key)) return { ok: true, value: null };
      kv.store.set(key, { value, expiresAt: opts.ttlSec ? Date.now() + opts.ttlSec * 1000 : null });
      return { ok: true, value: 'OK' };
    },
    kvIncr: async (key: string, opts?: { initialTtlSec: number }) => {
      const e = live(key);
      const next = Number(e?.value ?? '0') + 1;
      kv.store.set(key, {
        value: String(next),
        expiresAt: e?.expiresAt ?? (opts ? Date.now() + opts.initialTtlSec * 1000 : null),
      });
      return { ok: true, value: next };
    },
    // 予算で断ったときの解放に使う script (RELEASE_PAYMENT_CLAIM_IF_OWNED) だけを受け付ける
    kvEval: async (script: string, keys: string[], args: string[]) => {
      if (script !== RELEASE_PAYMENT_CLAIM_IF_OWNED) throw new Error(`unexpected script: ${script}`);
      if (live(keys[0])?.value !== args[0]) return { ok: true, value: 0 };
      kv.store.delete(keys[0]);
      return { ok: true, value: 1 };
    },
  };
});

import { POST } from '@/app/api/relay/jpyc/status/route';
import { RELEASE_PAYMENT_CLAIM_IF_OWNED } from '@/lib/paymentClaim';
import { jpycAddressFor } from '@/lib/relay/relayProvider';
import {
  NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE,
  narrowSearchBudgetKey,
  narrowSearchOnceKey,
} from '@/lib/relay/statusLookupBudget';

// 署名の期限: 対象のログのブロックの時刻 + 照会の窓 (1230 秒)。ログは窓の下限ちょうどにある。
const VALID_BEFORE = ts(chainState.logBlock) + 1230n;

function req(body: unknown) {
  return new Request('http://localhost/api/relay/jpyc/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify(body),
  });
}
const nonceLookup = (nonce: Hex = NONCE, validBefore: bigint = VALID_BEFORE) =>
  req({ lookup: 'nonce', chainId: 80002, from: FROM, nonce, validBefore: validBefore.toString() });
const signedLookup = () =>
  req({
    chainId: 80002,
    from: FROM,
    to: MERCHANT,
    value: VALUE.toString(),
    validAfter: '0',
    validBefore: VALID_BEFORE.toString(),
    nonce: NONCE,
    signature: `0x${'2'.repeat(130)}`,
  });
const otherNonce = (i: number) => `0x${(i + 1).toString(16).padStart(64, 'e')}` as Hex;

beforeEach(() => {
  vi.stubEnv('IP_HASH_SECRET', 'status-test-secret-32-bytes-long!!');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T00:00:05Z'));
  const token = jpycAddressFor(80002);
  if (!token) throw new Error('JPYC の 80002 のアドレスが無い');
  chainState.token = token;
  chainState.maxRange = 100n;
  chainState.logBlock = 20_000n;
  chainState.calls = { getLogs: 0, getBlock: 0 };
  kv.configured = true;
  kv.store.clear();
  kv.failNextSet = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('relay status: 署名なしの照会の小分けの探索 (本物の helper と予算)', () => {
  it('(a) 窓の下限ちょうど (validBefore − 1230 秒) のブロックのログも見つけて settled', async () => {
    const res = await POST(nonceLookup());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX });
    // 1 回目 (直近 10,000 ブロック) は範囲制限で拒まれ、そのあと小分けに探した
    expect(chainState.calls.getLogs).toBeGreaterThan(1);
  });

  it('(a) 署名付き照会 (validAfter = 0) と同じブロックまで探す', async () => {
    const res = await POST(signedLookup());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('(b) 小分けの探索の上限 (問い合わせ 60 回) を使い切ったら indeterminate (RPC はそこで止まる)', async () => {
    chainState.maxRange = 10n; // 615 ブロックを 10 ずつ = 60 回を超える。ログは最後に探す最も古いブロック
    const res = await POST(nonceLookup());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
    // 1 回目の広い検索 + 小分けの探索 (ブロックの時刻とログ) 60 回まで
    expect(chainState.calls.getLogs + chainState.calls.getBlock).toBeLessThanOrEqual(61);
    expect(chainState.calls.getLogs + chainState.calls.getBlock).toBeGreaterThan(50);
  });

  it(`(c) チェーンの予算 (1 分に ${NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE} 回) を使い切ったら小分けの探索を始めず indeterminate`, async () => {
    for (let i = 0; i < NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE; i++) await POST(nonceLookup(otherNonce(i)));
    expect(kv.store.get(narrowSearchBudgetKey(80002))?.value).toBe(String(NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE));

    chainState.calls = { getLogs: 0, getBlock: 0 };
    const res = await POST(nonceLookup());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
    // 広い検索の 1 回だけで、小分けの探索 (ブロックの時刻・小さい範囲のログ) は始めていない
    expect(chainState.calls).toEqual({ getLogs: 1, getBlock: 0 });

    // 次の 1 分には予算が戻り、同じ照会が settled になる (同じ nonce の重複の抑止 30 秒も切れている)
    vi.setSystemTime(new Date('2026-11-05T00:01:05Z'));
    const next = await POST(nonceLookup());
    expect(await next.json()).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('(c) 予算で断った照会は重複の鍵を残さない (次の 1 分に入れば 30 秒を待たずに探せる)', async () => {
    vi.setSystemTime(new Date('2026-11-05T00:00:55Z'));
    for (let i = 0; i < NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE; i++) await POST(nonceLookup(otherNonce(i)));
    expect(await (await POST(nonceLookup())).json()).toEqual({ ok: true, state: 'indeterminate' });
    expect(kv.store.has(narrowSearchOnceKey(80002, FROM, NONCE))).toBe(false);

    // 断ってから 7 秒 (重複の抑止 30 秒の内側) でも、次の 1 分の予算で探す
    vi.setSystemTime(new Date('2026-11-05T00:01:02Z'));
    expect(await (await POST(nonceLookup())).json()).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('(c) 予算で断っても、並行する別の要求が置いた重複の鍵は消さない', async () => {
    for (let i = 0; i < NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE; i++) await POST(nonceLookup(otherNonce(i)));
    // 別の要求が探索中 (鍵を置いた) で、この要求の SET は応答を失った (失敗) とする
    const onceKey = narrowSearchOnceKey(80002, FROM, NONCE);
    kv.store.set(onceKey, { value: 'another-request', expiresAt: Date.now() + 30_000 });
    kv.failNextSet = true;
    expect(await (await POST(nonceLookup())).json()).toEqual({ ok: true, state: 'indeterminate' });
    expect(kv.store.get(onceKey)?.value).toBe('another-request');
  });

  it('(c) 予算を使い切っても署名付き照会は従来どおり小分けに探す (関門は署名なしの照会だけ)', async () => {
    for (let i = 0; i < NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE + 1; i++) await POST(nonceLookup(otherNonce(i)));
    const res = await POST(signedLookup());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('同じ nonce は 30 秒に 1 回だけ探す (validBefore を変えても同じ・予算も減らさない)', async () => {
    expect(await (await POST(nonceLookup())).json()).toEqual({ ok: true, state: 'settled', txHash: TX });
    chainState.calls = { getLogs: 0, getBlock: 0 };
    const again = await POST(nonceLookup(NONCE, VALID_BEFORE + 1n));
    expect(await again.json()).toEqual({ ok: true, state: 'indeterminate' });
    expect(chainState.calls).toEqual({ getLogs: 1, getBlock: 0 });
    expect(kv.store.get(narrowSearchBudgetKey(80002))?.value).toBe('1');

    vi.setSystemTime(new Date('2026-11-05T00:00:36Z'));
    expect(await (await POST(nonceLookup())).json()).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('KV が無いときは予算を見ずに探す (fail-open: 決済済みの復旧を止めない)', async () => {
    kv.configured = false;
    for (let i = 0; i < NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE + 1; i++) await POST(nonceLookup(otherNonce(i)));
    const res = await POST(nonceLookup());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: TX });
    expect(kv.store.size).toBe(0);
  });
});
