import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { getAddress } from 'viem';

// 受け渡し API の入口の堅牢化 (第 7 回レビュー PR15: X3・C7・X2)。回数制限は scope ごとに実際に数えて、
// 「何回目で止まるか」「本文を読む前に止まるか」を固定する。

const hold = vi.hoisted(() => ({
  enabled: true,
  counts: new Map<string, number>(),
  deny: new Set<string>(),
  ipCalls: [] as { scope: string; key: string | null; max: number; windowSec: number }[],
  readCalls: [] as { key: string; max: number; windowSec: number }[],
  mac: (m: string) => '' as string | null,
}));

hold.mac = (m: string) => createHmac('sha256', 'route-test-secret-'.repeat(3)).update(m).digest('hex');

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableStoreGasWallet() {
        return hold.enabled;
      },
    },
  };
});
// IP は要求のヘッダ (x-test-ip) から・バケットは見分けがつく文字列に (HMAC の秘密値を要らなくする)。
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: (req: Request) => req.headers.get('x-test-ip'),
  hashIpBucket: (ip: string | null) => (ip ? `h(${ip})` : null),
}));
vi.mock('@/lib/relay/relayGuards', () => {
  const bump = (key: string, max: number) => {
    const n = (hold.counts.get(key) ?? 0) + 1;
    hold.counts.set(key, n);
    return n <= max;
  };
  return {
    checkIpRateLimit: vi.fn(async (scope: string, key: string | null, max: number, windowSec: number) => {
      hold.ipCalls.push({ scope, key, max, windowSec });
      if (hold.deny.has(scope)) return false;
      return key === null ? true : bump(`ip:${scope}:${key}`, max);
    }),
    checkReadRateLimit: vi.fn(async (key: string, max: number, windowSec: number) => {
      hold.readCalls.push({ key, max, windowSec });
      return bump(`read:${key}`, max);
    }),
  };
});
vi.mock('@/lib/storeHandoffDeps', () => ({
  handoffDeps: () => ({ mac: hold.mac }),
  resolveDeps: () => ({}),
}));
vi.mock('@/lib/storeHandoffResolve', () => ({
  resolveStoreHandoff: vi.fn(async () => ({ ok: true, state: 'pending' })),
}));
vi.mock('@/lib/storeHandoff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storeHandoff')>();
  return {
    ...actual,
    createHandoffSession: vi.fn(async () => ({
      ok: true,
      id: 'AAAAAAAAAAAAAAAAAAAAAA',
      token: 'ab'.repeat(32),
      expiresAt: 1,
    })),
    recordHandoffTx: vi.fn(async () => ({ ok: true, txHash: `0x${'ef'.repeat(32)}` })),
  };
});

import { POST as createPost } from '@/app/api/register/handoff/route';
import { POST as txPost } from '@/app/api/register/handoff/[id]/tx/route';
import { POST as resolvePost } from '@/app/api/register/handoff/resolve/route';
import { createHandoffSession, handoffTokenFor, newHandoffId, recordHandoffTx } from '@/lib/storeHandoff';
import { resolveStoreHandoff } from '@/lib/storeHandoffResolve';

const ID = newHandoffId({ mac: hold.mac, randomBytes: (n) => Buffer.alloc(n, 3) })!;
const TOKEN = handoffTokenFor(ID, hold.mac)!;
const FAKE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const OTHER_SHOP = getAddress('0x0000000000000000000000000000000000000abc');
const TX = `0x${'ef'.repeat(32)}`;
const nonceOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const paramsOf = (id: string) => ({ params: Promise.resolve({ id }) });

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://open-pay.jp/api/register/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-ip': '198.51.100.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const resolveBody = (nonce: string) => ({
  chainId: 137,
  from: OTHER_SHOP,
  merchant: SHOP,
  merchantValue: '1000000000000000000',
  validBefore: '2000000000',
  intentSalt: `0x${'11'.repeat(32)}`,
  nonce,
  forwarder: OTHER_SHOP,
  feeReceiver: OTHER_SHOP,
});

beforeEach(() => {
  hold.enabled = true;
  hold.counts.clear();
  hold.deny.clear();
  hold.ipCalls.length = 0;
  hold.readCalls.length = 0;
  vi.mocked(createHandoffSession).mockClear();
  vi.mocked(recordHandoffTx).mockClear();
  vi.mocked(resolveStoreHandoff).mockClear();
});

describe('X3: tx の記録は、端末の要求か (id の HMAC とトークン) を本文より先に確かめる', () => {
  it('偽の id は本文を読まず・回数制限 (KV) にも触れず 404', async () => {
    const req = post({ txHash: TX, pad: 'x'.repeat(8000) }, { 'x-store-handoff-token': TOKEN });
    const res = await txPost(req, paramsOf(FAKE_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(req.bodyUsed).toBe(false);
    expect(hold.ipCalls).toHaveLength(0);
    expect(recordHandoffTx).not.toHaveBeenCalled();
  });

  it('トークンが無い・違う要求は本文を読まず 403', async () => {
    const variants: Record<string, string>[] = [
      {},
      { 'x-store-handoff-token': 'cd'.repeat(32) },
      { 'x-store-handoff-token': 'nope' },
    ];
    for (const headers of variants) {
      const req = post({ txHash: TX }, headers);
      const res = await txPost(req, paramsOf(ID));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'bad_token' });
      expect(req.bodyUsed).toBe(false);
    }
    expect(hold.ipCalls).toHaveLength(0);
    expect(recordHandoffTx).not.toHaveBeenCalled();
  });

  it('本物の id とトークンは IP ごとの回数制限 → 本文 → 記録 (記録の応答はそのまま)', async () => {
    const res = await txPost(post({ txHash: TX }, { 'x-store-handoff-token': TOKEN }), paramsOf(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: TX });
    expect(hold.ipCalls).toEqual([{ scope: 'store-handoff-tx', key: 'h(198.51.100.7)', max: 60, windowSec: 60 }]);
    expect(vi.mocked(recordHandoffTx).mock.calls[0].slice(0, 3)).toEqual([ID, TOKEN, { txHash: TX }]);
  });

  it('回数制限を超えたら本文を読まずに 429・大きすぎる本文は 413', async () => {
    hold.deny.add('store-handoff-tx');
    const limited = post({ txHash: TX }, { 'x-store-handoff-token': TOKEN });
    const res = await txPost(limited, paramsOf(ID));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(limited.bodyUsed).toBe(false);
    hold.deny.clear();
    const big = await txPost(post({ txHash: TX, pad: 'x'.repeat(5000) }, { 'x-store-handoff-token': TOKEN }), paramsOf(ID));
    expect(big.status).toBe(413);
    expect(recordHandoffTx).not.toHaveBeenCalled();
  });
});

describe('C7: 結論の照会 (resolve) は flag を止めた後も答え、店内の同じ IP の複数のお客様を 429 にしない', () => {
  it('flag を止めた後も結論の照会には答える (読むだけ・資金を動かさない)', async () => {
    hold.enabled = false;
    const res = await resolvePost(post(resolveBody(nonceOf(1))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'pending' });
    expect(resolveStoreHandoff).toHaveBeenCalledTimes(1);
    // 新しい受け渡しを作る入口は止まったまま。
    expect((await createPost(post({ chainId: 137, merchant: SHOP, amount: '1' }))).status).toBe(404);
  });

  it('同じ IP のお客様 3 人 (5 秒おき) と店の端末 (10 秒おき) が 1 分照会し続けても 429 にならない', async () => {
    const statuses: number[] = [];
    for (let t = 0; t < 12; t++) {
      for (const customer of [1, 2, 3]) {
        statuses.push((await resolvePost(post(resolveBody(nonceOf(customer))))).status);
      }
      if (t % 2 === 0) statuses.push((await resolvePost(post(resolveBody(nonceOf(1))))).status);
    }
    expect(statuses).toHaveLength(42);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('IP の上限 (60 回/分) は本文を読む前に数える', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await resolvePost(post(resolveBody(nonceOf(100 + i))))).status).toBe(200);
    }
    const req = post(resolveBody(nonceOf(999)));
    const res = await resolvePost(req);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(req.bodyUsed).toBe(false);
    expect(hold.ipCalls[0]).toEqual({ scope: 'store-handoff-resolve', key: 'h(198.51.100.7)', max: 60, windowSec: 60 });
  });

  it('1 件の支払い (nonce) ごとにも数える: 同じ IP の同じ nonce は 31 回目で 429 (大文字小文字は同じ)・別の nonce は通る', async () => {
    const nonce = `0x${'ab'.repeat(32)}`;
    for (let i = 0; i < 30; i++) {
      const n = i % 2 === 0 ? nonce : nonce.toUpperCase().replace('0X', '0x');
      expect((await resolvePost(post(resolveBody(n)))).status).toBe(200);
    }
    const res = await resolvePost(post(resolveBody(nonce)));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(resolveStoreHandoff).toHaveBeenCalledTimes(30);
    // 鍵は作成 API の店ごとの枠 (X2) と同じ型: IP バケットと nonce の組。nonce だけの枠 (rl:read) は使わない。
    expect(hold.readCalls).toHaveLength(0);
    expect(hold.ipCalls.filter((c) => c.scope === 'store-handoff-resolve-nonce')[0]).toEqual({
      scope: 'store-handoff-resolve-nonce',
      key: `h(198.51.100.7):${nonce}`,
      max: 30,
      windowSec: 60,
    });
    expect((await resolvePost(post(resolveBody(nonceOf(7))))).status).toBe(200);
  });

  it('第三者が別の IP から対象の nonce を名指しして枠を使い切っても、正規の (別の IP の) 照会は通る', async () => {
    // オンチェーンの Settled から nonce は誰でも読める。nonce だけで数えると、第三者が毎分 30 回送るだけで
    // お客様の画面と店の端末の照会が 429 になり、決済済みでも「確認中」に留まる (Codex P2)。
    const nonce = `0x${'cd'.repeat(32)}`;
    for (let i = 0; i < 40; i++) {
      await resolvePost(post(resolveBody(nonce), { 'x-test-ip': '203.0.113.66' }));
    }
    expect(resolveStoreHandoff).toHaveBeenCalledTimes(30);
    // お客様 (携帯回線) と店の端末 (店内 Wi-Fi) は別の IP から同じ nonce を照会する。
    for (const ip of ['198.51.100.7', '192.0.2.10']) {
      const res = await resolvePost(post(resolveBody(nonce), { 'x-test-ip': ip }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, state: 'pending' });
    }
    expect(resolveStoreHandoff).toHaveBeenCalledTimes(32);
  });

  it('IP が分からない (バケット null) ときは nonce の枠も KV に触れず通す (IP の枠と同じ流儀)', async () => {
    const nonce = `0x${'ab'.repeat(32)}`;
    for (let i = 0; i < 31; i++) {
      expect((await resolvePost(post(resolveBody(nonce), { 'x-test-ip': '' }))).status).toBe(200);
    }
    expect(hold.readCalls).toHaveLength(0);
    expect(hold.ipCalls.every((c) => c.key === null)).toBe(true);
    expect(resolveStoreHandoff).toHaveBeenCalledTimes(31);
  });

  it('形の違う nonce は nonce の回数制限を使わず、判定 (400 を返す本体) に任せる', async () => {
    await resolvePost(post(resolveBody('0x12')));
    expect(hold.readCalls).toHaveLength(0);
    expect(hold.ipCalls.map((c) => c.scope)).toEqual(['store-handoff-resolve']);
    expect(resolveStoreHandoff).toHaveBeenCalledTimes(1);
  });
});

describe('X2: 受け渡しの作成は IP の回数制限 → 本文 → 店ごとの回数制限 (同じ IP の中で店ごと)', () => {
  const create = (merchant: string, ip = '198.51.100.7') =>
    createPost(post({ chainId: 137, merchant, amount: '1000000000000000000' }, { 'x-test-ip': ip }));

  it('同じ店のレジ 3 台が同じ公開 IP から 1 分に 25 会計しても QR を作れる', async () => {
    for (let i = 0; i < 25; i++) expect((await create(SHOP)).status).toBe(200);
    expect(createHandoffSession).toHaveBeenCalledTimes(25);
  });

  it('同じ IP・同じ店は 31 回目で 429 (受取先の大文字小文字は同じ店)・同じ IP の別の店は作れる', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await create(i % 2 === 0 ? SHOP : SHOP.toLowerCase())).status).toBe(200);
    }
    const res = await create(SHOP);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(createHandoffSession).toHaveBeenCalledTimes(30);
    expect((await create(OTHER_SHOP)).status).toBe(200);
    expect(hold.ipCalls.filter((c) => c.scope === 'store-handoff-create-merchant')[0]).toEqual({
      scope: 'store-handoff-create-merchant',
      key: `h(198.51.100.7):${SHOP.toLowerCase()}`,
      max: 30,
      windowSec: 60,
    });
  });

  it('別の IP から店の受取先を名指しして作り続けても、その店の IP からは作れる (第三者が店の QR を止められない)', async () => {
    for (let i = 0; i < 31; i++) await create(SHOP, '203.0.113.9');
    expect((await create(SHOP, '203.0.113.9')).status).toBe(429);
    expect((await create(SHOP)).status).toBe(200);
  });

  it('IP の上限 (60 回/分) は本文を読む前に数える', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await create(i < 30 ? SHOP : OTHER_SHOP)).status).toBe(200);
    }
    const req = post({ chainId: 137, merchant: getAddress('0x0000000000000000000000000000000000000def'), amount: '1' });
    const res = await createPost(req);
    expect(res.status).toBe(429);
    expect(req.bodyUsed).toBe(false);
    expect(hold.ipCalls[0]).toEqual({ scope: 'store-handoff-create', key: 'h(198.51.100.7)', max: 60, windowSec: 60 });
  });

  it('受取先が形の違う本文は店ごとの回数制限を使わず、本体 (400 を返す) に任せる', async () => {
    await createPost(post({ chainId: 137, merchant: 'nope', amount: '1' }));
    expect(hold.ipCalls.map((c) => c.scope)).toEqual(['store-handoff-create']);
    expect(createHandoffSession).toHaveBeenCalledTimes(1);
  });
});
