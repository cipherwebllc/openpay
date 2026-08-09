// POST /api/order/notify (受注リレー書込) を実ルートで検証。
// flag OFF=404 / handle 束縛 / txHash 冪等 / on-chain 検証 (pass/fail/rpc) / KV 必須 (mainnet) /
// レート制限。chains/tokens は実値 (chainId=137)・verifyJpycTransferToOnChain と KV は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const JPYC = 10n ** 18n;
const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x1111111111111111111111111111111111111111';
const CUSTOMER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TXHASH = `0x${'a'.repeat(64)}`;
const SECOND_TXHASH = `0x${'b'.repeat(64)}`;
const FEE_TXHASH = `0x${'f'.repeat(64)}`;
const STATUS_TOKEN = 'p'.repeat(43); // 顧客生成の status トークン (43 文字 base64url = 有効形式)

// 注意: vi.hoisted は top-level const より先に走るため、ここで MERCHANT/JPYC を参照すると TDZ。
// 初期値は安全なリテラル/null にし、実値は beforeEach で設定する。
const hold = vi.hoisted(() => ({
  enableOrderRelay: true,
  enableOrderPickup: true, // 顧客向け注文状況の逆引きポインタ保存のゲート
  enablePushNotify: true,
  enableMobileOrderFee: true,
  feeReceiver: '0x1111111111111111111111111111111111111111',
  feeReceiverConfigured: true,
  isMainnet: false,
  handle: { ok: true, record: null } as
    | { ok: true; record: { config: { to: string }; storefront?: unknown } | null }
    | { ok: false },
  rateAllowed: true,
  // 受注一覧の保持ポリシー検証用 (掟 14 隣接: /guide/start が「直近 200 件・最後の
  // 注文から 72 時間」と開示しているため、実装側の上限と TTL 張り直しを固定する)。
  ltrimCalls: [] as unknown[][],
  expireCalls: [] as unknown[][],
  kvConfigured: true,
  claimValue: 'OK' as 'OK' | null, // pending nx クレーム: 'OK'=fresh, null=衝突 (既存マーカーあり)
  usedMarker: 'done' as 'pending' | 'done' | null, // 衝突時に kvGet(usedKey) が返す既存マーカー
  pointerSetFails: false, // true で order:sv: の kvSet が ok:false を返す (ポインタ保存失敗の emulate)
  listValues: [] as string[],
  feeUsedKeys: new Set<string>(),
  evalResults: [] as { value: number; replacement?: string }[],
  verify: { ok: true, value: 10n ** 18n } as
    | {
        ok: true;
        value: bigint;
        receiptFrom?: string;
        directValue?: bigint;
        merchantSource?: string;
        sameSourceFeeValue?: bigint;
      }
    | { ok: false; reason: string },
  feePairVerify: {
    ok: true,
    value: 10n ** 18n,
    blockNumber: 2n,
  } as
    | { ok: true; value: bigint; blockNumber: bigint }
    | { ok: false; reason: string },
  feePairVerifyQueue: [] as (
    | { ok: true; value: bigint; blockNumber: bigint }
    | { ok: false; reason: string }
  )[],
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
      get enableMobileOrderFee() {
        return hold.enableMobileOrderFee;
      },
      get feeReceiver() {
        return hold.feeReceiver;
      },
      get feeReceiverConfigured() {
        return hold.feeReceiverConfigured;
      },
    },
  };
});
const verifySpy = vi.hoisted(() => vi.fn());
const feePairVerifySpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycTransferToOnChain: (...a: unknown[]) => {
    verifySpy(...a);
    return Promise.resolve(hold.verify);
  },
  verifyJpycStandardFeePairOnChain: (...a: unknown[]) => {
    feePairVerifySpy(...a);
    return Promise.resolve(
      hold.feePairVerifyQueue.shift() ?? hold.feePairVerify,
    );
  },
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
const lrangeSpy = vi.hoisted(() => vi.fn());
const evalSpy = vi.hoisted(() => vi.fn());
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
    hold.listValues.unshift(a[1] as string);
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvLrange: (...a: unknown[]) => {
    lrangeSpy(...a);
    return Promise.resolve({ ok: true, value: [...hold.listValues] });
  },
  kvEval: (...a: unknown[]) => {
    evalSpy(...a);
    const script = a[0] as string;
    const keys = a[1] as string[];
    const args = a[2] as string[];
    const forced = hold.evalResults.shift();
    if (forced) {
      if (forced.replacement !== undefined) {
        const index = hold.listValues.indexOf(args[0]);
        if (index >= 0) hold.listValues[index] = forced.replacement;
      }
      return Promise.resolve({ ok: true, value: forced.value });
    }
    if (script.includes("redis.call('LPUSH'")) {
      const claimed =
        !hold.feeUsedKeys.has(keys[1]) &&
        !hold.feeUsedKeys.has(keys[2]);
      if (claimed) hold.feeUsedKeys.add(keys[1]);
      hold.listValues.unshift(claimed ? args[1] : args[0]);
      return Promise.resolve({ ok: true, value: claimed ? 1 : 0 });
    }
    const index = hold.listValues.indexOf(args[0]);
    if (index < 0) return Promise.resolve({ ok: true, value: 0 });
    if (
      hold.feeUsedKeys.has(keys[1]) ||
      hold.feeUsedKeys.has(keys[2])
    ) {
      return Promise.resolve({ ok: true, value: -1 });
    }
    hold.feeUsedKeys.add(keys[1]);
    hold.listValues[index] = args[1];
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvLtrim: (...args: unknown[]) => {
    hold.ltrimCalls.push(args);
    return Promise.resolve({ ok: true, value: 'OK' });
  },
  kvExpire: (...args: unknown[]) => {
    hold.expireCalls.push(args);
    return Promise.resolve({ ok: true, value: 1 });
  },
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

function partialOrderRaw(
  txHash = TXHASH,
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    orderId: `order-${txHash.slice(-4)}`,
    items: [{ name: 'ブレンド', qty: 2, price: '500' }],
    table: 'テーブル 5',
    amount: (970n * JPYC).toString(),
    txHash,
    chainId: 80002,
    from: CUSTOMER,
    ts: 1_700_000_000_000,
    fulfilled: false,
    feeUncollected: true,
    feeExpectedAmount: (30n * JPYC - 1n).toString(),
    feeExpectedAmountAlt: (30n * JPYC).toString(),
    ...over,
  });
}

async function flushAfterTasks() {
  await Promise.all(pushNotify.afterTasks);
}

function latestStoredOrder(): Record<string, unknown> {
  return JSON.parse(hold.listValues[0]) as Record<string, unknown>;
}

beforeEach(() => {
  hold.enableOrderRelay = true;
  hold.enableOrderPickup = true;
  hold.enablePushNotify = true;
  hold.enableMobileOrderFee = true;
  hold.feeReceiver = OTHER;
  hold.feeReceiverConfigured = true;
  hold.isMainnet = false;
  hold.handle = {
    ok: true,
    record: {
      config: { to: MERCHANT },
      storefront: {
        chain: 'polygon',
        mode: 'preorder',
        feePayer: 'merchant',
      },
    },
  };
  hold.rateAllowed = true;
  hold.kvConfigured = true;
  hold.claimValue = 'OK';
  hold.usedMarker = 'done';
  hold.pointerSetFails = false;
  hold.listValues = [];
  hold.ltrimCalls = [];
  hold.expireCalls = [];
  hold.feeUsedKeys = new Set();
  hold.evalResults = [];
  hold.verify = {
    ok: true,
    value: JPYC,
    sameSourceFeeValue: JPYC,
  };
  hold.feePairVerify = { ok: true, value: JPYC, blockNumber: 2n };
  hold.feePairVerifyQueue = [];
  lpushSpy.mockClear();
  delSpy.mockClear();
  setSpy.mockClear();
  getSpy.mockClear();
  lrangeSpy.mockClear();
  evalSpy.mockClear();
  verifySpy.mockClear();
  feePairVerifySpy.mockClear();
  warnSpy.mockClear();
  pushNotify.after.mockClear();
  pushNotify.afterTasks = [];
  pushNotify.notify.mockReset();
  pushNotify.notify.mockResolvedValue(undefined);
});

describe('POST /api/order/notify', () => {
  // /guide/start が「直近 200 件を保持・一覧全体は最後の注文から 72 時間で消える」と
  // 開示している。その 2 点は実装のこの 2 呼び出しに依存するため固定する
  // (TTL を張り直さなくなると「最後の注文から」が嘘になる)。
  it('受注保存ごとに 上限 200 件で trim し TTL 72h を張り直す (開示との整合)', async () => {
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect(hold.ltrimCalls).toHaveLength(1);
    expect(hold.ltrimCalls[0].slice(1)).toEqual([0, 199]);
    expect(hold.expireCalls).toHaveLength(1);
    expect(hold.expireCalls[0][1]).toBe(72 * 60 * 60);
  });

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

  it('done duplicate + 正当な fee tx → 保存済み期待額で検証し未収フラグを原子解除', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.listValues = [partialOrderRaw()];
    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH, feeAmount: '1' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    await flushAfterTasks();

    expect(feePairVerifySpy).toHaveBeenCalledTimes(1);
    expect(feePairVerifySpy.mock.calls[0][0]).toMatchObject({
      merchantTxHash: TXHASH,
      feeTxHash: FEE_TXHASH,
      expected: {
        merchant: MERCHANT,
        merchantValue: 970n * JPYC,
        feeReceiver: OTHER,
        feeMinValue: 30n * JPYC - 1n,
        feeAlternateValue: 30n * JPYC,
      },
    });
    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [, keys, args] = evalSpy.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(keys).toEqual([
      `order:list:${MERCHANT.toLowerCase()}`,
      `payment:claimed:80002:${FEE_TXHASH}`,
      `billing:settled:80002:${FEE_TXHASH}`,
    ]);
    expect(args[0]).toContain('"feeUncollected":true');
    expect(args[1]).not.toContain('feeUncollected');
    expect(args[1]).not.toContain('feeExpectedAmount');
    expect(args[2]).toBe('r:order');
    expect(JSON.parse(hold.listValues[0])).toMatchObject({ fulfilled: false });
  });

  it('保存後に storefront が 3%→1% へ変わっても保存済み 3% obligation を減額しない', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.listValues = [partialOrderRaw()];
    hold.handle = {
      ok: true,
      record: {
        config: { to: MERCHANT },
        storefront: {
          chain: 'polygon',
          mode: 'storefront',
          feePayer: 'merchant',
        },
      },
    };

    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(res.status).toBe(200);
    await flushAfterTasks();

    expect(feePairVerifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({
          feeMinValue: 30n * JPYC - 1n,
        }),
      }),
    );
    expect(JSON.parse(hold.listValues[0])).not.toHaveProperty(
      'feeUncollected',
    );
  });

  it('保存後に feeConfig が null へ変わっても fee hash があれば保存済み obligation を回収', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.enableMobileOrderFee = false;
    hold.listValues = [partialOrderRaw()];

    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(res.status).toBe(200);
    await flushAfterTasks();

    expect(feePairVerifySpy).toHaveBeenCalledTimes(1);
    expect(feePairVerifySpy.mock.calls[0][0]).toMatchObject({
      expected: { feeMinValue: 30n * JPYC - 1n },
    });
    expect(evalSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-an-amount'],
    ['zero', '0'],
  ])(
    'feeExpectedAmount %s の旧/壊れ未収レコードは badge を消さず no-op',
    async (_label, feeExpectedAmount) => {
      hold.claimValue = null;
      hold.usedMarker = 'done';
      const raw = partialOrderRaw(TXHASH, { feeExpectedAmount });
      hold.listValues = [raw];

      const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
      expect(res.status).toBe(200);
      await flushAfterTasks();

      expect(feePairVerifySpy).not.toHaveBeenCalled();
      expect(evalSpy).not.toHaveBeenCalled();
      expect(hold.listValues).toEqual([raw]);
      expect(JSON.parse(hold.listValues[0])).toHaveProperty(
        'feeUncollected',
        true,
      );
    },
  );

  it('fresh POST が feeTxHash を含む場合も既存応答後の after で未収を解除', async () => {
    hold.verify = {
      ok: true,
      value: 970n * JPYC,
      receiptFrom: CUSTOMER,
      directValue: 970n * JPYC,
    };

    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orderId: 'oid-1' });
    await flushAfterTasks();

    expect(feePairVerifySpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hold.listValues[0])).not.toHaveProperty(
      'feeUncollected',
    );
  });

  it('done duplicate の feeTxHash が不正・検証不成立なら未収フラグを解除しない', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    const raw = partialOrderRaw();
    hold.listValues = [raw];

    const invalid = await POST(req(goodBody({ feeTxHash: '0xnope' })));
    expect(invalid.status).toBe(200);
    await flushAfterTasks();
    expect(feePairVerifySpy).not.toHaveBeenCalled();
    expect(evalSpy).not.toHaveBeenCalled();
    expect(hold.listValues).toEqual([raw]);

    pushNotify.afterTasks = [];
    hold.feePairVerify = { ok: false, reason: 'amount_too_low' };
    const unverified = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(unverified.status).toBe(200);
    await flushAfterTasks();
    expect(feePairVerifySpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(hold.listValues).toEqual([raw]);
  });

  it('broadcast 直後の tx_not_found は after 内で bounded retry して同じ fee hash を回復', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.listValues = [partialOrderRaw()];
    hold.feePairVerifyQueue = [
      { ok: false, reason: 'tx_not_found' },
      { ok: true, value: 30n * JPYC, blockNumber: 2n },
    ];

    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(res.status).toBe(200);
    await flushAfterTasks();

    expect(feePairVerifySpy).toHaveBeenCalledTimes(2);
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hold.listValues[0])).not.toHaveProperty(
      'feeUncollected',
    );
  });

  it.each(['payer_mismatch', 'fee_before_merchant'])(
    '無関係な fee receipt (%s) では未収フラグを解除しない',
    async (reason) => {
      hold.claimValue = null;
      hold.usedMarker = 'done';
      const raw = partialOrderRaw();
      hold.listValues = [raw];
      hold.feePairVerify = { ok: false, reason };

      const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, duplicate: true });
      await flushAfterTasks();

      expect(feePairVerifySpy).toHaveBeenCalledTimes(1);
      expect(evalSpy).not.toHaveBeenCalled();
      expect(hold.listValues).toEqual([raw]);
      expect(warnSpy).toHaveBeenCalledWith(
        'order.notify.fee_reconcile_verify_failed',
        expect.objectContaining({ reason }),
      );
    },
  );

  it('同じ fee tx は別注文の未収解除へ replay できない', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.listValues = [partialOrderRaw(), partialOrderRaw(SECOND_TXHASH)];

    await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    await flushAfterTasks();
    pushNotify.afterTasks = [];
    await POST(
      req(goodBody({ txHash: SECOND_TXHASH, feeTxHash: FEE_TXHASH })),
    );
    await flushAfterTasks();

    const first = JSON.parse(hold.listValues[0]);
    const second = JSON.parse(hold.listValues[1]);
    expect(first.feeUncollected).toBeUndefined();
    expect(first.feeExpectedAmount).toBeUndefined();
    expect(first.feeExpectedAmountAlt).toBeUndefined();
    expect(second.feeUncollected).toBe(true);
    expect(second.feeExpectedAmount).toBe(
      (30n * JPYC - 1n).toString(),
    );
    expect(second.feeExpectedAmountAlt).toBe((30n * JPYC).toString());
    expect(evalSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'order.notify.fee_reconcile_replay',
      expect.objectContaining({ chainId: 80002, merchant: MERCHANT }),
    );
  });

  it('global claim 導入前の billing:settled tx も同一 Lua で未収解除へ流用拒否', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    const raw = partialOrderRaw();
    hold.listValues = [raw];
    hold.feeUsedKeys.add(`billing:settled:80002:${FEE_TXHASH}`);

    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(res.status).toBe(200);
    await flushAfterTasks();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hold.listValues[0])).toHaveProperty(
      'feeUncollected',
      true,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'order.notify.fee_reconcile_replay',
      expect.objectContaining({ chainId: 80002 }),
    );
  });

  it('未収解除 CAS 競合時は再読込し、同時の fulfilled 更新を保持する', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'done';
    const raw = partialOrderRaw();
    const fulfilledRaw = partialOrderRaw(TXHASH, { fulfilled: true });
    hold.listValues = [raw];
    hold.evalResults = [{ value: 0, replacement: fulfilledRaw }];

    await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    await flushAfterTasks();

    expect(evalSpy).toHaveBeenCalledTimes(2);
    const stored = JSON.parse(hold.listValues[0]);
    expect(stored.fulfilled).toBe(true);
    expect(stored.feeUncollected).toBeUndefined();
    expect(stored.feeExpectedAmount).toBeUndefined();
    expect(stored.feeExpectedAmountAlt).toBeUndefined();
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

  it('pending 409 の feeTxHash も after reconciliation に渡し、保存済み受注を回復', async () => {
    hold.claimValue = null;
    hold.usedMarker = 'pending';
    hold.listValues = [partialOrderRaw()];

    const res = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'processing' });
    await flushAfterTasks();

    expect(feePairVerifySpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hold.listValues[0])).not.toHaveProperty(
      'feeUncollected',
    );
  });

  it('二段ロック: pending 失効後 (used キー不在) の再 POST は fresh クレームされ保存される (P1-F: 復旧可能)', async () => {
    // maxDuration タイムアウトで pending が自然失効した後の再送を emulate: nx クレームが再び成功する。
    hold.claimValue = 'OK'; // pending 失効済 = キー不在 → 新規クレーム成立
    hold.verify = {
      ok: true,
      value: 1000n * JPYC,
      sameSourceFeeValue: 100n * JPYC,
    };
    const res = await POST(req(goodBody()));
    await flushAfterTasks();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orderId: 'oid-1' });
    expect(getSpy).not.toHaveBeenCalled(); // fresh クレームゆえ done/pending 読み分けに入らない
    expect(hold.listValues).toHaveLength(1); // 正規注文が保存される (72h 消失しない)
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
    hold.verify = {
      ok: true,
      value: 1000n * JPYC,
      sameSourceFeeValue: 100n * JPYC,
    };
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
    expect(evalSpy).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('LPUSH'"),
      [
        `order:list:${MERCHANT.toLowerCase()}`,
        `payment:claimed:80002:${TXHASH}`,
        `billing:settled:80002:${TXHASH}`,
      ],
      expect.any(Array),
    );
    const stored = latestStoredOrder();
    expect(stored.amount).toBe((1000n * JPYC).toString()); // 実着金 (権威)
    expect(stored.table).toBe('テーブル 5');
    expect(stored.items).toEqual([{ name: 'ブレンド', qty: 2, price: '500' }]);
    expect('amountMismatch' in stored).toBe(false);
    expect('amountUnchecked' in stored).toBe(false);
    expect('feeUncollected' in stored).toBe(false);
    expect('feeExpectedAmount' in stored).toBe(false);
    expect(pushNotify.after).toHaveBeenCalledTimes(1);
    expect(pushNotify.notify).toHaveBeenCalledWith(MERCHANT, 'order');
  });

  it.each([
    ['false', { feeUncollected: false, feeAmount: '1' }],
    ['omit', { feeAmount: '1' }],
    ['numeric one', { feeUncollected: 1, feeAmount: '1' }],
  ])(
    'standard merchant leg は body %s poisoning に依存せず店舗設定から未収額を保存',
    async (_label, poison) => {
      hold.verify = {
        ok: true,
        value: 970n * JPYC,
        receiptFrom: CUSTOMER,
        directValue: 970n * JPYC,
      };
      const res = await POST(req(goodBody(poison)));
      expect(res.status).toBe(200);
      const stored = latestStoredOrder();
      expect(stored.feeUncollected).toBe(true);
      // gross=1000 JPYC の 3% と net=970 JPYC は床除算境界で 1 wei 衝突する。
      expect(stored.feeExpectedAmount).toBe(
        (30n * JPYC - 1n).toString(),
      );
      expect(stored.feeExpectedAmountAlt).toBe((30n * JPYC).toString());
    },
  );

  it('storefront 1% の gross=1000→net=990 は minimum/minimum+1を保存し正規10 JPYCを受理', async () => {
    hold.handle = {
      ok: true,
      record: {
        config: { to: MERCHANT },
        storefront: {
          chain: 'polygon',
          mode: 'storefront',
        },
      },
    };
    hold.verify = {
      ok: true,
      value: 990n * JPYC,
      receiptFrom: CUSTOMER,
      directValue: 990n * JPYC,
    };

    const created = await POST(req(goodBody()));
    expect(created.status).toBe(200);
    expect(latestStoredOrder()).toMatchObject({
      feeExpectedAmount: (10n * JPYC - 1n).toString(),
      feeExpectedAmountAlt: (10n * JPYC).toString(),
    });

    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.feePairVerify = {
      ok: true,
      value: 10n * JPYC,
      blockNumber: 2n,
    };
    pushNotify.afterTasks = [];
    const reconciled = await POST(req(goodBody({ feeTxHash: FEE_TXHASH })));
    expect(reconciled.status).toBe(200);
    await flushAfterTasks();
    expect(latestStoredOrder()).not.toHaveProperty('feeUncollected');
    expect(feePairVerifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({
          feeMinValue: 10n * JPYC - 1n,
          feeAlternateValue: 10n * JPYC,
        }),
      }),
    );
  });

  it('同一 receipt の inline fee を原子 claim し、別注文の未収解除へ二重利用させない', async () => {
    hold.verify = {
      ok: true,
      value: 970n * JPYC,
      merchantSource: CUSTOMER,
      sameSourceFeeValue: 30n * JPYC,
    };

    const inline = await POST(
      req(goodBody({ txHash: FEE_TXHASH, orderId: 'inline-order' })),
    );
    expect(inline.status).toBe(200);
    expect(hold.feeUsedKeys).toContain(
      `payment:claimed:80002:${FEE_TXHASH}`,
    );
    expect(latestStoredOrder().feeUncollected).toBeUndefined();
    const inlineScript = evalSpy.mock.calls[0][0] as string;
    expect(inlineScript.indexOf("redis.call('LPUSH'")).toBeLessThan(
      inlineScript.indexOf("redis.call('SET'"),
    );
    expect(inlineScript.indexOf("redis.call('SET'")).toBeLessThan(
      inlineScript.indexOf("redis.call('LSET'"),
    );

    // 注文 A は先に merchant leg だけ確定して未収。上の inline receipt を feeTxHash として再提出する。
    hold.claimValue = null;
    hold.usedMarker = 'done';
    hold.listValues = [partialOrderRaw(TXHASH)];
    pushNotify.afterTasks = [];
    const replay = await POST(
      req(goodBody({ txHash: TXHASH, feeTxHash: FEE_TXHASH })),
    );
    expect(replay.status).toBe(200);
    await flushAfterTasks();

    expect(latestStoredOrder()).toMatchObject({
      feeUncollected: true,
      feeExpectedAmount: (30n * JPYC - 1n).toString(),
      feeExpectedAmountAlt: (30n * JPYC).toString(),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'order.notify.fee_reconcile_replay',
      expect.objectContaining({ chainId: 80002 }),
    );
  });

  it('店舗負担でも第2 gross preimage が無い net は minimum 1候補だけを保存', async () => {
    hold.verify = {
      ok: true,
      value: 970n * JPYC + 1n,
      receiptFrom: CUSTOMER,
      directValue: 970n * JPYC + 1n,
    };

    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    const stored = latestStoredOrder();
    expect(stored.feeExpectedAmount).toBe((30n * JPYC).toString());
    expect(stored.feeExpectedAmountAlt).toBeUndefined();
  });

  it('customer 負担は direct merchant 全額から exact fee を保存', async () => {
    hold.handle = {
      ok: true,
      record: {
        config: { to: MERCHANT },
        storefront: {
          chain: 'polygon',
          mode: 'preorder',
          feePayer: 'customer',
        },
      },
    };
    hold.verify = {
      ok: true,
      value: 1000n * JPYC,
      receiptFrom: CUSTOMER,
      directValue: 1000n * JPYC,
    };

    await POST(req(goodBody({ feeUncollected: false, feeAmount: '1' })));
    const stored = latestStoredOrder();
    expect(stored.feeExpectedAmount).toBe((30n * JPYC).toString());
    expect(stored.feeExpectedAmountAlt).toBeUndefined();
  });

  it('receipt.from と Transfer.from が違う helper/4337 支払いも fee 無しなら未収扱い', async () => {
    hold.verify = {
      ok: true,
      value: 970n * JPYC,
      receiptFrom: CUSTOMER,
      directValue: 969n * JPYC,
    };

    await POST(
      req(goodBody({ feeUncollected: true, feeAmount: (30n * JPYC).toString() })),
    );
    const stored = latestStoredOrder();
    expect(stored.feeUncollected).toBe(true);
    expect(stored.feeExpectedAmount).toBe(
      (30n * JPYC - 1n).toString(),
    );
    expect(stored.feeExpectedAmountAlt).toBe((30n * JPYC).toString());
  });

  it('merchant 着金と同じ source が同一 receipt で期待 fee を払う relay/batch は徴収済み', async () => {
    hold.verify = {
      ok: true,
      value: 970n * JPYC,
      merchantSource: '0x2222222222222222222222222222222222222222',
      sameSourceFeeValue: 30n * JPYC - 1n,
    };

    await POST(req(goodBody({ feeUncollected: true, feeAmount: '1' })));
    const stored = latestStoredOrder();
    expect('feeUncollected' in stored).toBe(false);
    expect('feeExpectedAmount' in stored).toBe(false);
  });

  it('mobile fee flag OFF は direct standard merchant leg でも未収フィールドを足さない', async () => {
    hold.enableMobileOrderFee = false;
    hold.verify = {
      ok: true,
      value: 970n * JPYC,
      receiptFrom: CUSTOMER,
      directValue: 970n * JPYC,
    };

    await POST(req(goodBody({ feeUncollected: true })));
    const stored = latestStoredOrder();
    expect('feeUncollected' in stored).toBe(false);
    expect('feeExpectedAmount' in stored).toBe(false);
  });

  it('金額不一致 advisory: dust receipt でも拒否せず ok:true で保存し amountMismatch を立てる', async () => {
    hold.verify = { ok: true, value: JPYC }; // declared=1000 JPYC, receipt=1 JPYC
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orderId: 'oid-1' });
    expect(hold.listValues).toHaveLength(1);
    const stored = latestStoredOrder();
    expect(stored.amount).toBe(JPYC.toString());
    expect(stored.amountMismatch).toBe(true);
    expect('amountUnchecked' in stored).toBe(false);
  });

  it('pickupAt (preorder・near-future ms) を保存・窓外/不正は除外 (Phase 4)', async () => {
    const at = Date.now() + 30 * 60 * 1000; // 30 分後 (near-future 窓内)
    await POST(req(goodBody({ pickupAt: at })));
    const stored = latestStoredOrder();
    expect(stored.pickupAt).toBe(at);
    // 負値は除外。
    setSpy.mockClear();
    await POST(req(goodBody({ txHash: `0x${'d'.repeat(64)}`, pickupAt: -5 })));
    expect('pickupAt' in latestStoredOrder()).toBe(false);
    // 窓外 (1年後) も除外 (極端値で受注表示を汚さない)。
    setSpy.mockClear();
    await POST(
      req(goodBody({ txHash: `0x${'e'.repeat(64)}`, pickupAt: Date.now() + 365 * 24 * 3600 * 1000 })),
    );
    expect('pickupAt' in latestStoredOrder()).toBe(false);
  });

  it('customerMemo を sanitize して保存し、超過は 120 字に切り詰め・不正値は除外', async () => {
    await POST(req(goodBody({ customerMemo: '  卵\u0000\nなし  ' })));
    let stored = latestStoredOrder();
    expect(stored.customerMemo).toBe('卵なし');

    setSpy.mockClear();
    await POST(
      req(goodBody({ txHash: `0x${'d'.repeat(64)}`, customerMemo: 'あ'.repeat(130) })),
    );
    stored = latestStoredOrder();
    expect(stored.customerMemo).toBe('あ'.repeat(120));

    setSpy.mockClear();
    await POST(req(goodBody({ txHash: `0x${'e'.repeat(64)}`, customerMemo: 42 })));
    stored = latestStoredOrder();
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
