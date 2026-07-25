import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';

const routeMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
  resolveStatus: vi.fn(),
  statusRateLimit: vi.fn(),
  kvGet: vi.fn(),
  kvSetNxGet: vi.fn(),
  kvEval: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock('@/app/api/facilitator/verify/route', () => ({
  POST: routeMocks.verify,
}));
vi.mock('@/app/api/facilitator/settle/route', () => ({
  POST: routeMocks.settle,
}));
vi.mock('@/lib/x402/facilitatorStatus', () => ({
  resolveFacilitatorPaymentStatus: routeMocks.resolveStatus,
}));
vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({
  checkFacilitatorStatusRateLimit: routeMocks.statusRateLimit,
}));
vi.mock('@/lib/kv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
  return {
    ...actual,
    kvGet: routeMocks.kvGet,
    kvSetNxGet: routeMocks.kvSetNxGet,
    kvEval: routeMocks.kvEval,
  };
});

const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const TX_HASH = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`;

type PaidRoute = { GET: (req: Request) => Promise<Response> };

function paymentPayload() {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:80002',
    payload: {
      signature: SIGNATURE,
      authorization: {
        from: PAYER,
        validAfter: '0',
        validBefore: '9999999999',
        intentSalt: `0x${'22'.repeat(32)}`,
      },
    },
  };
}

function paymentHeader(): string {
  return Buffer.from(JSON.stringify(paymentPayload()), 'utf8').toString('base64');
}

function req(path: string, xPayment?: string): Request {
  return new Request(`http://test.local${path}`, {
    headers: xPayment ? { 'X-PAYMENT': xPayment } : undefined,
  });
}

async function load(flag = '1'): Promise<{ demo: PaidRoute; stores: PaidRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', flag);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.resetModules();
  const demo = (await import('@/app/api/paid/demo/route')) as PaidRoute;
  const stores = (await import('@/app/api/paid/stores/route')) as PaidRoute;
  return { demo, stores };
}

beforeEach(() => {
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
  routeMocks.resolveStatus.mockReset();
  routeMocks.statusRateLimit.mockReset();
  routeMocks.kvGet.mockReset();
  routeMocks.kvSetNxGet.mockReset();
  routeMocks.kvEval.mockReset();
  routeMocks.store.clear();
  routeMocks.resolveStatus.mockResolvedValue({
    ok: true,
    chainId: 80002,
    payer: PAYER,
    state: 'unused',
  });
  routeMocks.statusRateLimit.mockResolvedValue(true);
  routeMocks.kvGet.mockImplementation(async (key: string) => ({
    ok: true,
    value: routeMocks.store.get(key) ?? null,
  }));
  routeMocks.kvSetNxGet.mockImplementation(
    async (key: string, value: string) => {
      const current = routeMocks.store.get(key);
      if (current !== undefined) return { ok: true, value: current };
      routeMocks.store.set(key, value);
      return { ok: true, value: null };
    },
  );
  routeMocks.kvEval.mockImplementation(
    async (script: string, keys: string[], args: string[]) => {
      const currentRaw = routeMocks.store.get(keys[0]);
      if (script.includes("redis.call('DEL', KEYS[1])")) {
        if (currentRaw === undefined) return { ok: true, value: 0 };
        const current = JSON.parse(currentRaw) as Record<string, unknown>;
        if (
          current.state !== 'pending' ||
          current.scope !== args[0] ||
          current.resource !== args[1] ||
          current.credential !== args[2] ||
          current.ownerToken !== args[3]
        ) {
          return { ok: true, value: -1 };
        }
        routeMocks.store.delete(keys[0]);
        return { ok: true, value: 1 };
      }
      if (currentRaw === undefined) return { ok: true, value: [0, ''] };
      const current = JSON.parse(currentRaw) as Record<string, unknown>;
      if (
        current.scope !== args[0] ||
        current.resource !== args[1] ||
        current.credential !== args[2]
      ) {
        return { ok: true, value: [-1, ''] };
      }
      if (current.state === 'settled') {
        return { ok: true, value: [2, currentRaw] };
      }
      current.state = 'settled';
      current.settlement = JSON.parse(args[3]) as unknown;
      const promoted = JSON.stringify(current);
      routeMocks.store.set(keys[0], promoted);
      return { ok: true, value: [1, promoted] };
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('first-party paid x402 routes', () => {
  it('flag OFF → 404', async () => {
    const { demo, stores } = await load('');
    expect((await demo.GET(req('/api/paid/demo'))).status).toBe(404);
    expect((await stores.GET(req('/api/paid/stores'))).status).toBe(404);
  });

  it('payment header なし → 402 + forwarder-split accepts', async () => {
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{
        resource: string;
        maxAmountRequired: string;
        extra: { openpay: { merchant: string; merchantValue: string; feeValue: string } };
      }>;
    };
    expect(body.accepts).toHaveLength(1);
    const pr = body.accepts[0];
    expect(pr.resource).toBe('https://open-pay.jp/api/paid/demo');
    expect(pr.extra.openpay.merchant).toBe(SELLER);
    expect(pr.extra.openpay.merchantValue).toBe((1n * 10n ** 18n).toString());
    expect(pr.extra.openpay.feeValue).toBe((2n * 10n ** 18n).toString());
    expect(pr.maxAmountRequired).toBe((3n * 10n ** 18n).toString());
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('不正 X-PAYMENT → 402', async () => {
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo', 'not-json'));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('invalid_payment_payload');
  });

  it('verify が invalid → 402 + accepts を返し settle しない', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: false, invalidReason: 'signature_mismatch' }),
    );
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo', paymentHeader()));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; accepts: unknown[] };
    expect(body.error).toBe('signature_mismatch');
    expect(body.accepts).toHaveLength(1);
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('正しい payment → verify→settle 後に demo JSON + X-PAYMENT-RESPONSE', async () => {
    routeMocks.verify.mockResolvedValue(NextResponse.json({ isValid: true, payer: PAYER }));
    routeMocks.settle.mockImplementation(
      async () => NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { demo } = await load();
    const res = await demo.GET(req('/api/paid/demo', paymentHeader()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; paidAt: string; payer: string };
    expect(body.message).toBe('Payment verified — welcome to the x402 + JPYC rail.');
    expect(body.payer).toBe(PAYER);
    expect(Date.parse(body.paidAt)).not.toBeNaN();
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);

    const sentVerify = (await routeMocks.verify.mock.calls[0][0].json()) as {
      paymentPayload: unknown;
      paymentRequirements: { resource: string };
    };
    expect(sentVerify.paymentPayload).toEqual(paymentPayload());
    expect(sentVerify.paymentRequirements.resource).toBe(
      'https://open-pay.jp/api/paid/demo',
    );
    const paymentResponse = JSON.parse(
      Buffer.from(res.headers.get('x-payment-response') ?? '', 'base64').toString('utf8'),
    );
    expect(paymentResponse).toMatchObject({ success: true, transaction: TX_HASH, payer: PAYER });
  });

  it('settle の broadcast 前 rate limit は所有 claim を解放し、同じ正規 payment を再試行できる', async () => {
    routeMocks.verify.mockImplementation(
      async () => NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle
      .mockResolvedValueOnce(
        NextResponse.json(
          {
            success: false,
            errorReason: 'rate_limited',
            network: 'eip155:80002',
            payer: PAYER,
          },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        NextResponse.json({
          success: true,
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        }),
      );
    const { demo } = await load();
    const header = paymentHeader();

    const limited = await demo.GET(req('/api/paid/demo', header));
    expect(limited.status).toBe(429);
    expect((await limited.json()).errorReason).toBe('rate_limited');
    expect(routeMocks.store.size).toBe(0);

    const retried = await demo.GET(req('/api/paid/demo', header));
    expect(retried.status).toBe(200);
    expect(routeMocks.verify).toHaveBeenCalledTimes(2);
    expect(routeMocks.settle).toHaveBeenCalledTimes(2);
    expect(routeMocks.kvSetNxGet).toHaveBeenCalledTimes(2);
  });

  it('settle pending 後の同一 X-PAYMENT 再アクセス → on-chain settled を確認して二重 settle せず再配信', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    const { demo } = await load();
    const header = paymentHeader();

    const first = await demo.GET(req('/api/paid/demo', header));
    expect(first.status).toBe(202);
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);

    const pendingWrite = routeMocks.kvSetNxGet.mock.calls.find(
      ([, raw]) => JSON.parse(raw as string).state === 'pending',
    );
    expect(pendingWrite).toBeTruthy();
    const [deliveryKey, pendingRaw, pendingTtl] = pendingWrite!;
    expect(pendingTtl).toBe(1800);

    routeMocks.resolveStatus.mockResolvedValue({
      ok: true,
      chainId: 80002,
      payer: PAYER,
      state: 'settled',
      txHash: TX_HASH,
    });

    const recovered = await demo.GET(req('/api/paid/demo', header));
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).message).toBe(
      'Payment verified — welcome to the x402 + JPYC rail.',
    );
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
    expect(routeMocks.resolveStatus).toHaveBeenCalledWith(
      JSON.parse(pendingRaw as string).facilitatorBody,
    );
    expect(routeMocks.statusRateLimit).toHaveBeenCalledTimes(1);

    const settledRecord = JSON.parse(
      routeMocks.store.get(deliveryKey as string) ?? '{}',
    ) as { state?: string };
    expect(settledRecord.state).toBe('settled');
    expect(routeMocks.kvEval).toHaveBeenCalledTimes(1);
    const paymentResponse = JSON.parse(
      Buffer.from(
        recovered.headers.get('x-payment-response') ?? '',
        'base64',
      ).toString('utf8'),
    );
    expect(paymentResponse).toEqual({
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    });
  });

  it('settled 配信レコードがあれば facilitator を再実行せず同じ成功ヘッダで再配信', async () => {
    const settlement = {
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
      receipt: { signature: `0x${'33'.repeat(65)}` },
    };
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(NextResponse.json(settlement));
    const { demo } = await load();
    const header = paymentHeader();
    expect((await demo.GET(req('/api/paid/demo', header))).status).toBe(200);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    vi.stubEnv('X402_PAY_TO_ADDRESS', 'invalid-after-settlement');
    const res = await demo.GET(req('/api/paid/demo', header));
    expect(res.status).toBe(200);
    expect(routeMocks.resolveStatus).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        Buffer.from(
          res.headers.get('x-payment-response') ?? '',
          'base64',
        ).toString('utf8'),
      ),
    ).toEqual(settlement);
  });

  it('pending 配信レコードの on-chain 状態が indeterminate → settle へ再投入せず 202', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    const { demo } = await load();
    const header = paymentHeader();
    expect((await demo.GET(req('/api/paid/demo', header))).status).toBe(202);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    routeMocks.resolveStatus.mockResolvedValue({
      ok: true,
      chainId: 80002,
      payer: PAYER,
      state: 'indeterminate',
    });
    const res = await demo.GET(req('/api/paid/demo', header));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      success: false,
      errorReason: 'pending',
      transaction: null,
      network: 'eip155:80002',
      payer: PAYER,
    });
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('pending 配信レコードの on-chain 状態が unused でも再 settle せず 202', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    const { demo } = await load();
    const header = paymentHeader();
    expect((await demo.GET(req('/api/paid/demo', header))).status).toBe(202);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    routeMocks.resolveStatus.mockResolvedValue({
      ok: true,
      chainId: 80002,
      payer: PAYER,
      state: 'unused',
    });
    const res = await demo.GET(req('/api/paid/demo', header));

    expect(res.status).toBe(202);
    expect((await res.json()).errorReason).toBe('pending');
    expect(routeMocks.resolveStatus).toHaveBeenCalledTimes(1);
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('pending status の一時障害でも再 settle せず 202', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    const { demo } = await load();
    const header = paymentHeader();
    expect((await demo.GET(req('/api/paid/demo', header))).status).toBe(202);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    routeMocks.resolveStatus.mockRejectedValue(new Error('RPC unavailable'));
    const res = await demo.GET(req('/api/paid/demo', header));

    expect(res.status).toBe(202);
    expect((await res.json()).errorReason).toBe('pending');
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('同一 payment の並行 claim は先行 request だけが settle し、後続は 202 で待つ', async () => {
    routeMocks.verify.mockImplementation(
      async () => NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockImplementation(
      async () => NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { demo } = await load();
    const header = paymentHeader();

    const responses = await Promise.all([
      demo.GET(req('/api/paid/demo', header)),
      demo.GET(req('/api/paid/demo', header)),
    ]);

    expect(responses.map((res) => res.status).sort()).toEqual([200, 202]);
    expect(routeMocks.verify).toHaveBeenCalledTimes(2);
    expect(routeMocks.kvSetNxGet).toHaveBeenCalledTimes(2);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
    expect(routeMocks.resolveStatus).not.toHaveBeenCalled();
  });

  it('pending status の内部照会も公開 status と共有する IP limiter で止める', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        },
        { status: 202 },
      ),
    );
    const { demo } = await load();
    const header = paymentHeader();
    expect((await demo.GET(req('/api/paid/demo', header))).status).toBe(202);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    routeMocks.statusRateLimit.mockResolvedValue(false);
    const limited = await demo.GET(req('/api/paid/demo', header));

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      ok: false,
      error: 'ip_rate_limited',
    });
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(routeMocks.resolveStatus).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('同じ payment の別 resource replay は verify/status/settle/content より前に 402 で拒否する', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { demo, stores } = await load();
    const header = paymentHeader();
    expect((await demo.GET(req('/api/paid/demo', header))).status).toBe(200);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    const replay = await stores.GET(req('/api/paid/stores', header));

    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe('payment_invalid');
    expect(routeMocks.resolveStatus).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('同じ payment の別 query replay は content を返さず 402 で拒否する', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { demo } = await load();
    const header = paymentHeader();
    expect(
      (await demo.GET(req('/api/paid/demo?q=alpha', header))).status,
    ).toBe(200);

    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    const replay = await demo.GET(req('/api/paid/demo?q=beta', header));

    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe('payment_invalid');
    expect(routeMocks.resolveStatus).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('JSON field order/whitespace/base64 が違っても同じ payment は別 resource を解錠しない', async () => {
    routeMocks.verify.mockResolvedValue(
      NextResponse.json({ isValid: true, payer: PAYER }),
    );
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { demo, stores } = await load();
    expect(
      (await demo.GET(req('/api/paid/demo', paymentHeader()))).status,
    ).toBe(200);

    const payload = paymentPayload();
    const reordered = {
      payload: {
        authorization: {
          intentSalt: payload.payload.authorization.intentSalt,
          validBefore: payload.payload.authorization.validBefore,
          from: payload.payload.authorization.from,
          validAfter: payload.payload.authorization.validAfter,
        },
        signature: payload.payload.signature,
      },
      network: payload.network,
      scheme: payload.scheme,
      x402Version: payload.x402Version,
    };
    const alternateHeader = Buffer.from(
      `\n  ${JSON.stringify(reordered, null, 4)}\n`,
      'utf8',
    ).toString('base64');
    routeMocks.verify.mockClear();
    routeMocks.settle.mockClear();
    const replay = await stores.GET(
      req('/api/paid/stores', alternateHeader),
    );

    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe('payment_invalid');
    expect(routeMocks.resolveStatus).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('/api/paid/stores は ExploreEntry の公開 JSON を返す', async () => {
    routeMocks.verify.mockResolvedValue(NextResponse.json({ isValid: true, payer: PAYER }));
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:80002',
        payer: PAYER,
      }),
    );
    const { stores } = await load();
    const res = await stores.GET(req('/api/paid/stores', paymentHeader()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; category: string; url: string; description?: unknown }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toMatchObject({
      name: 'JPYC EX',
      category: 'exchange',
      url: 'https://jpyc.co.jp/',
    });
    expect(body.items[0].description).toBeUndefined();
  });

  it('402 チャレンジの accepts は x402scan v1 payable-index 用 outputSchema を含む (verify body は不変)', async () => {
    const { demo } = await load();
    const res = await demo.GET(new Request('https://open-pay.jp/api/paid/demo'));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{ outputSchema?: { input?: { type: string; method: string; discoverable: boolean } } }>;
    };
    const schema = body.accepts[0]?.outputSchema;
    expect(schema?.input).toEqual({ type: 'http', method: 'GET', discoverable: true });
  });
});
