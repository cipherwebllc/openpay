// POST /api/order/notify (受注リレー書込) を実ルートで検証。
// flag OFF=404 / handle 束縛 / txHash 冪等 / on-chain 検証 (pass/fail/rpc) / KV 必須 (mainnet) /
// レート制限。chains/tokens は実値 (chainId=137)・verifyJpycTransferToOnChain と KV は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const JPYC = 10n ** 18n;
const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x1111111111111111111111111111111111111111';
const CUSTOMER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TXHASH = `0x${'a'.repeat(64)}`;
const STATUS_TOKEN = 'p'.repeat(43); // 顧客生成の status トークン (43 文字 base64url = 有効形式)

// 注意: vi.hoisted は top-level const より先に走るため、ここで MERCHANT/JPYC を参照すると TDZ。
// 初期値は安全なリテラル/null にし、実値は beforeEach で設定する。
const hold = vi.hoisted(() => ({
  enableOrderRelay: true,
  enableOrderPickup: true, // 顧客向け注文状況の逆引きポインタ保存のゲート
  enablePushNotify: true,
  isMainnet: false,
  handle: { ok: true, record: null } as
    | { ok: true; record: { config: { to: string }; storefront?: unknown } | null }
    | { ok: false },
  rateAllowed: true,
  kvConfigured: true,
  claimValue: 'OK' as 'OK' | null, // pending nx クレーム: 'OK'=fresh, null=衝突 (既存マーカーあり)
  usedMarker: 'done' as 'pending' | 'done' | null, // 衝突時に kvGet(usedKey) が返す既存マーカー
  pointerSetFails: false, // true で order:sv: の kvSet が ok:false を返す (ポインタ保存失敗の emulate)
  verify: { ok: true, value: 10n ** 18n } as
    | { ok: true; value: bigint }
    | { ok: false; reason: string },
}));

const pushNotify = vi.hoisted(() => ({
  after: vi.fn(),
  afterTasks: [] as Promise<unknown>[],
  notify: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: ResponseInit = {}) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
  },
  after: (cb: () => unknown) => {
    pushNotify.after(cb);
    try {
      pushNotify.afterTasks.push(Promise.resolve(cb()));
    } catch (e) {
      pushNotify.afterTasks.push(Promise.reject(e));
    }
  },
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
      get enableOrderPickup() {
        return hold.enableOrderPickup;
      },
      get enablePushNotify() {
        return hold.enablePushNotify;
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
const getSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  kvSet: (...a: unknown[]) => {
    setSpy(...a);
    if (hold.pointerSetFails && String(a[0]).startsWith('order:sv:')) {
      return Promise.resolve({ ok: false, reason: 'network_error' });
    }
    // done 昇格 (order:used:*, 値 'done'・ttl なし) は常に成功させる。pending nx クレーム / pointer は
    // hold.claimValue に従う (nx: 'OK'=fresh / null=衝突)。
    if (String(a[0]).startsWith('order:used:') && a[1] === 'done') {
      return Promise.resolve({ ok: true, value: 'OK' });
    }
    return Promise.resolve({ ok: true, value: hold.claimValue });
  },
  // 衝突時 (nx 失敗) の既存マーカー読取り。used キーは hold.usedMarker を返す。
  kvGet: (...a: unknown[]) => {
    getSpy(...a);
    if (String(a[0]).startsWith('order:used:')) {
      return Promise.resolve({ ok: true, value: hold.usedMarker });
    }
    return Promise.resolve({ ok: true, value: null });
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
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/push/notify', () => ({
  notifyPaymentReceived: (...args: unknown[]) => pushNotify.notify(...args),
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

async function flushAfterTasks() {
  await Promise.all(pushNotify.afterTasks);
}

beforeEach(() => {
  hold.enableOrderRelay = true;
  hold.enableOrderPickup = true;
  hold.enablePushNotify = true;
  hold.isMainnet = false;
  hold.handle = { ok: true, record: { config: { to: MERCHANT }, storefront: {} } };
  hold.rateAllowed = true;
  hold.kvConfigured = true;
  hold.claimValue = 'OK';
  hold.usedMarker = 'done';
  hold.pointerSetFails = false;
  hold.verify = { ok: true, value: JPYC };
  lpushSpy.mockClear();
  delSpy.mockClear();
  setSpy.mockClear();
  getSpy.mockClear();
  warnSpy.mockClear();
  pushNotify.after.mockClear();
  pushNotify.afterTasks = [];
  pushNotify.notify.mockReset();
  pushNotify.notify.mockResolvedValue(undefined);
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

  it('二段ロック: 昇格済 (done) マーカーで衝突 → 200 duplicate・再追加しない (P1-E: 無期限リプレイ拒否)', async () => {
    hold.claimValue = null; // pending nx クレーム衝突 (既存マーカーあり)
    hold.usedMarker = 'done'; // 検証+保存済の恒久ブロック
    const res = await POST(req(goodBody()));
    await flushAfterTasks();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
    expect(getSpy).toHaveBeenCalledWith(`order:used:80002:${TXHASH}`); // done/pending 読み分け
    expect(lpushSpy).not.toHaveBeenCalled();
    expect(pushNotify.after).not.toHaveBeenCalled();
    expect(pushNotify.notify).not.toHaveBeenCalled();
  });

  it('二段ロック: pending 中の重複 POST → 409 processing・偽 duplicate を返さない (P2)', async () => {
    hold.claimValue = null; // pending nx クレーム衝突
    hold.usedMarker = 'pending'; // まだ検証中 (done へ未昇格)
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, error: 'processing' });
    expect(json.duplicate).toBeUndefined(); // 検証成功前に duplicate を偽装しない
    expect(lpushSpy).not.toHaveBeenCalled();
  });

  it('二段ロック: pending 失効後 (used キー不在) の再 POST は fresh クレームされ保存される (P1-F: 復旧可能)', async () => {
    // maxDuration タイムアウトで pending が自然失効した後の再送を emulate: nx クレームが再び成功する。
    hold.claimValue = 'OK'; // pending 失効済 = キー不在 → 新規クレーム成立
    hold.verify = { ok: true, value: 1000n * JPYC };
    const res = await POST(req(goodBody()));
    await flushAfterTasks();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orderId: 'oid-1' });
    expect(getSpy).not.toHaveBeenCalled(); // fresh クレームゆえ done/pending 読み分けに入らない
    expect(lpushSpy).toHaveBeenCalledTimes(1); // 正規注文が保存される (72h 消失しない)
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
    hold.verify = { ok: true, value: 1000n * JPYC };
    const res = await POST(req(goodBody()));
    await flushAfterTasks();
    expect(res.status).toBe(200);
    // ステージ1: pending クレームは txHash のみ (merchant/items を含めない) + **短 TTL** (自然失効で P1-F 復旧)。
    expect(setSpy).toHaveBeenCalledWith(
      `order:used:80002:${TXHASH}`,
      'pending',
      { nx: true, ttlSec: 120 },
    );
    // ステージ2: 保存確定後に done へ昇格。**ttl 引数なし = 恒久** (P1-E: 無期限リプレイを永久拒否)。
    const promote = setSpy.mock.calls.find(
      (c) => String(c[0]).startsWith('order:used:') && c[1] === 'done',
    );
    expect(promote).toBeDefined();
    expect(promote![0]).toBe(`order:used:80002:${TXHASH}`);
    expect(promote![2]).toBeUndefined(); // TTL 無し = 恒久ブロック
    // 受注を merchant のリストへ。保存値は実着金 (verify.value)・table は description 由来。
    expect(lpushSpy).toHaveBeenCalledTimes(1);
    const [listKey, raw] = lpushSpy.mock.calls[0] as [string, string];
    expect(listKey).toBe(`order:list:${MERCHANT.toLowerCase()}`);
    const stored = JSON.parse(raw);
    expect(stored.amount).toBe((1000n * JPYC).toString()); // 実着金 (権威)
    expect(stored.table).toBe('テーブル 5');
    expect(stored.items).toEqual([{ name: 'ブレンド', qty: 2, price: '500' }]);
    expect('amountMismatch' in stored).toBe(false);
    expect('amountUnchecked' in stored).toBe(false);
    expect(pushNotify.after).toHaveBeenCalledTimes(1);
    expect(pushNotify.notify).toHaveBeenCalledWith(MERCHANT, 'order');
  });

  it('金額不一致 advisory: dust receipt でも拒否せず ok:true で保存し amountMismatch を立てる', async () => {
    hold.verify = { ok: true, value: JPYC }; // declared=1000 JPYC, receipt=1 JPYC
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orderId: 'oid-1' });
    expect(lpushSpy).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(lpushSpy.mock.calls[0][1] as string);
    expect(stored.amount).toBe(JPYC.toString());
    expect(stored.amountMismatch).toBe(true);
    expect('amountUnchecked' in stored).toBe(false);
  });

  it('pickupAt (preorder・near-future ms) を保存・窓外/不正は除外 (Phase 4)', async () => {
    const at = Date.now() + 30 * 60 * 1000; // 30 分後 (near-future 窓内)
    await POST(req(goodBody({ pickupAt: at })));
    const stored = JSON.parse(lpushSpy.mock.calls[0][1] as string);
    expect(stored.pickupAt).toBe(at);
    // 負値は除外。
    lpushSpy.mockClear();
    setSpy.mockClear();
    await POST(req(goodBody({ txHash: `0x${'d'.repeat(64)}`, pickupAt: -5 })));
    expect('pickupAt' in JSON.parse(lpushSpy.mock.calls[0][1] as string)).toBe(false);
    // 窓外 (1年後) も除外 (極端値で受注表示を汚さない)。
    lpushSpy.mockClear();
    setSpy.mockClear();
    await POST(
      req(goodBody({ txHash: `0x${'e'.repeat(64)}`, pickupAt: Date.now() + 365 * 24 * 3600 * 1000 })),
    );
    expect('pickupAt' in JSON.parse(lpushSpy.mock.calls[0][1] as string)).toBe(false);
  });

  it('customerMemo を sanitize して保存し、超過は 120 字に切り詰め・不正値は除外', async () => {
    await POST(req(goodBody({ customerMemo: '  卵\u0000\nなし  ' })));
    let stored = JSON.parse(lpushSpy.mock.calls[0][1] as string);
    expect(stored.customerMemo).toBe('卵なし');

    lpushSpy.mockClear();
    setSpy.mockClear();
    await POST(
      req(goodBody({ txHash: `0x${'d'.repeat(64)}`, customerMemo: 'あ'.repeat(130) })),
    );
    stored = JSON.parse(lpushSpy.mock.calls[0][1] as string);
    expect(stored.customerMemo).toBe('あ'.repeat(120));

    lpushSpy.mockClear();
    setSpy.mockClear();
    await POST(req(goodBody({ txHash: `0x${'e'.repeat(64)}`, customerMemo: 42 })));
    stored = JSON.parse(lpushSpy.mock.calls[0][1] as string);
    expect('customerMemo' in stored).toBe(false);
  });

  it('standard mode (merchantTxHash) も txHash として受理', async () => {
    const body = goodBody();
    delete (body as Record<string, unknown>).txHash;
    (body as Record<string, unknown>).merchantTxHash = TXHASH;
    expect((await POST(req(body))).status).toBe(200);
  });

  it('statusToken あり + enableOrderPickup ON → 注文状況の逆引きポインタ保存 (order:sv:<token>=所在・nx)', async () => {
    const res = await POST(req(goodBody({ statusToken: STATUS_TOKEN })));
    expect(res.status).toBe(200);
    const svCall = setSpy.mock.calls.find((c) => String(c[0]).startsWith('order:sv:'));
    expect(svCall).toBeDefined();
    expect(svCall![0]).toBe(`order:sv:${STATUS_TOKEN}`);
    expect(JSON.parse(svCall![1] as string)).toEqual({
      merchant: MERCHANT,
      chainId: 80002,
      txHash: TXHASH,
    });
    expect(svCall![2]).toMatchObject({ nx: true });
  });

  it('ポインタ保存が KV 失敗 → 受注は 200 (fail-quiet) だが warn で surface (silent failure 防止・LARP #3)', async () => {
    hold.pointerSetFails = true;
    const res = await POST(req(goodBody({ statusToken: STATUS_TOKEN })));
    expect(res.status).toBe(200); // 受注/決済は止めない
    expect((await res.json()).ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'order.notify.pointer_failed',
      expect.objectContaining({ reason: 'network_error', merchant: MERCHANT }),
    );
  });

  it('ポインタ保存が成功 → pointer_failed の warn は出さない', async () => {
    await POST(req(goodBody({ statusToken: STATUS_TOKEN })));
    expect(warnSpy.mock.calls.some((c) => c[0] === 'order.notify.pointer_failed')).toBe(false);
  });

  it('enableOrderPickup OFF → statusToken があってもポインタを保存しない (完全 inert)', async () => {
    hold.enableOrderPickup = false;
    expect((await POST(req(goodBody({ statusToken: STATUS_TOKEN })))).status).toBe(200);
    expect(setSpy.mock.calls.some((c) => String(c[0]).startsWith('order:sv:'))).toBe(false);
  });

  it('statusToken が不正形式 → ポインタを保存しない (受注は成立)', async () => {
    expect((await POST(req(goodBody({ statusToken: 'too-short' })))).status).toBe(200);
    expect(setSpy.mock.calls.some((c) => String(c[0]).startsWith('order:sv:'))).toBe(false);
  });

  it('statusToken 無し (通常注文) → ポインタ無し (既存挙動不変)', async () => {
    await POST(req(goodBody()));
    expect(setSpy.mock.calls.some((c) => String(c[0]).startsWith('order:sv:'))).toBe(false);
  });
});
