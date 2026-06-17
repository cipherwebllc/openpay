// POST /api/order/notify (受注リレー書込) を実ルートで検証。
// flag OFF=404 / handle 束縛 / txHash 冪等 / on-chain 検証 (pass/fail/rpc) / KV 必須 (mainnet) /
// レート制限。chains/tokens は実値 (chainId=137)・verifyJpycTransferToOnChain と KV は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const JPYC = 10n ** 18n;
const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x1111111111111111111111111111111111111111';
const CUSTOMER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TXHASH = `0x${'a'.repeat(64)}`;

// 注意: vi.hoisted は top-level const より先に走るため、ここで MERCHANT/JPYC を参照すると TDZ。
// 初期値は安全なリテラル/null にし、実値は beforeEach で設定する。
const hold = vi.hoisted(() => ({
  enableOrderRelay: true,
  isMainnet: false,
  handle: { ok: true, record: null } as
    | { ok: true; record: { config: { to: string }; storefront?: unknown } | null }
    | { ok: false },
  rateAllowed: true,
  kvConfigured: true,
  claimValue: 'OK' as 'OK' | null, // kvSet nx: 'OK'=first, null=duplicate
  verify: { ok: true, value: 10n ** 18n } as
    | { ok: true; value: bigint }
    | { ok: false; reason: string },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    get isMainnet() {
      return hold.isMainnet;
    },
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return hold.enableOrderRelay;
      },
    },
  };
});
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycTransferToOnChain: vi.fn(async () => hold.verify),
}));
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: vi.fn(async () => hold.handle),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkRateLimit: vi.fn(async () => hold.rateAllowed),
}));
vi.mock('@/lib/relay/relayRoute', () => ({ anonymizeIp: () => 'ip-1' }));

const lpushSpy = vi.hoisted(() => vi.fn());
const delSpy = vi.hoisted(() => vi.fn());
const setSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  kvSet: (...a: unknown[]) => {
    setSpy(...a);
    return Promise.resolve({ ok: true, value: hold.claimValue });
  },
  kvDel: (...a: unknown[]) => {
    delSpy(...a);
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvLpush: (...a: unknown[]) => {
    lpushSpy(...a);
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvLtrim: () => Promise.resolve({ ok: true, value: 'OK' }),
  kvExpire: () => Promise.resolve({ ok: true, value: 1 }),
}));

import { POST } from '@/app/api/order/notify/route';

function req(body: unknown, query = '?h=alice'): Request {
  return new Request(`http://localhost/api/order/notify${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function goodBody(over: Record<string, unknown> = {}) {
  return {
    token: 'jpyc',
    txHash: TXHASH,
    merchant: MERCHANT,
    chainId: 80002, // polygonAmoy (testnet 環境で JPYC deployment が解決する)
    items: [{ name: 'ブレンド', qty: 2, price: '500' }],
    description: 'テーブル 5',
    from: CUSTOMER,
    orderId: 'oid-1',
    ...over,
  };
}

beforeEach(() => {
  hold.enableOrderRelay = true;
  hold.isMainnet = false;
  hold.handle = { ok: true, record: { config: { to: MERCHANT }, storefront: {} } };
  hold.rateAllowed = true;
  hold.kvConfigured = true;
  hold.claimValue = 'OK';
  hold.verify = { ok: true, value: JPYC };
  lpushSpy.mockClear();
  delSpy.mockClear();
  setSpy.mockClear();
});

describe('POST /api/order/notify', () => {
  it('flag OFF → 404', async () => {
    hold.enableOrderRelay = false;
    expect((await POST(req(goodBody()))).status).toBe(404);
  });

  it('?h= 無し → 400 (handle 必須)', async () => {
    const res = await POST(req(goodBody(), ''));
    expect(res.status).toBe(400);
  });

  it('token != jpyc → 400', async () => {
    expect((await POST(req(goodBody({ token: 'usdc' })))).status).toBe(400);
  });

  it('txHash 不正 → 400', async () => {
    expect((await POST(req(goodBody({ txHash: '0xnope' })))).status).toBe(400);
  });

  it('handle.config.to != merchant → 403 (書込スプーフ拒否)', async () => {
    hold.handle = { ok: true, record: { config: { to: OTHER }, storefront: {} } };
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(403);
    expect(lpushSpy).not.toHaveBeenCalled();
  });

  it('handle 不在 → 404', async () => {
    hold.handle = { ok: true, record: null };
    expect((await POST(req(goodBody()))).status).toBe(404);
  });

  it('レート制限 → 429', async () => {
    hold.rateAllowed = false;
    expect((await POST(req(goodBody()))).status).toBe(429);
  });

  it('mainnet + KV 未設定 → 503 (fail-open 封じ)', async () => {
    hold.isMainnet = true;
    hold.kvConfigured = false;
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    expect(lpushSpy).not.toHaveBeenCalled();
  });

  it('重複 txHash (nx クレーム失敗) → 200 duplicate・再追加しない', async () => {
    hold.claimValue = null; // 既存キー
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
    expect(lpushSpy).not.toHaveBeenCalled();
  });

  it('on-chain 検証 失敗 (amount_too_low) → 422・クレーム解放・未保存', async () => {
    hold.verify = { ok: false, reason: 'amount_too_low' };
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(422);
    expect(delSpy).toHaveBeenCalled(); // usedKey 解放
    expect(lpushSpy).not.toHaveBeenCalled();
  });

  it('on-chain 検証 rpc_error → 503 (retryable)', async () => {
    hold.verify = { ok: false, reason: 'rpc_error' };
    expect((await POST(req(goodBody()))).status).toBe(503);
  });

  it('正常: 検証成功 → 実着金額を権威保存 (kvLpush)・冪等鍵は txHash のみ', async () => {
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    // 冪等クレームは txHash のみ (merchant/items を含めない)。
    expect(setSpy).toHaveBeenCalledWith(
      `order:used:80002:${TXHASH}`,
      expect.any(String),
      expect.objectContaining({ nx: true }),
    );
    // 受注を merchant のリストへ。保存値は実着金 (verify.value)・table は description 由来。
    expect(lpushSpy).toHaveBeenCalledTimes(1);
    const [listKey, raw] = lpushSpy.mock.calls[0] as [string, string];
    expect(listKey).toBe(`order:list:${MERCHANT.toLowerCase()}`);
    const stored = JSON.parse(raw);
    expect(stored.amount).toBe(JPYC.toString()); // 実着金 (権威)
    expect(stored.table).toBe('テーブル 5');
    expect(stored.items).toEqual([{ name: 'ブレンド', qty: 2, price: '500' }]);
  });

  it('standard mode (merchantTxHash) も txHash として受理', async () => {
    const body = goodBody();
    delete (body as Record<string, unknown>).txHash;
    (body as Record<string, unknown>).merchantTxHash = TXHASH;
    expect((await POST(req(body))).status).toBe(200);
  });
});
