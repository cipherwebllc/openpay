// 既存 first-party 有料 route の **wire を byte 単位で凍結する golden fixture**。
//
// なぜ意味比較では足りないか (2026-07-30 計画レビューの指摘):
// tests/app/api/paid-first-party.test.ts は JSON を意味比較しており、キー順・数値の文字列表現・
// base64 ヘッダの中身・error 文字列といった **wire の実体**が変わっても green のまま通る。
// x402 は「買い手クライアントが 402 を機械解釈して署名する」プロトコルなので、キー順以外の
// 些細な差でも外部クライアント (x402-fetch / @x402/fetch / 自社 SDK / MCP) の互換を壊し得る。
//
// 本 fixture は creator store (plans/creator-store-v3.md) が予定する paid route の内部分割
// (descriptor 化) を **挙動 byte 不変**で行うための安全網。リファクタでこのテストが落ちたら、
// それは「互換を壊した」ことの証明であり、期待値を更新して通してはいけない。
// 期待値の更新が正当なのは、**wire 仕様を意図的に変える PR** のときだけ (その場合は理由を
// commit に書き、SDK/MCP の互換影響を同時に検証する)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: routeMocks.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: routeMocks.settle }));
vi.mock('@/lib/x402/facilitatorStatus', () => ({
  resolveFacilitatorPaymentStatus: routeMocks.resolveStatus,
}));
vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({
  checkFacilitatorStatusRateLimit: routeMocks.statusRateLimit,
}));
// KV は in-memory 実装で「構成済み」にする (redelivery/claim を本来の経路で通し、
// KV 未構成の fail-open ではなく **通常の成功経路の wire** を凍結する)。
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
// redelivery identity は from/validAfter/validBefore/intentSalt + signature を要求する
// (lib/x402/paymentRedelivery.canonicalPaymentParts)。intentSalt が identity の一部である
// = creator store v3 が「server 発行 salt で商品を束縛する」設計の裏付けでもある。
const INTENT_SALT = `0x${'cd'.repeat(32)}`;

type PaidRoute = { GET: (req: Request) => Promise<Response> };

function paymentPayload(): unknown {
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
        intentSalt: INTENT_SALT,
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

async function load(): Promise<{ demo: PaidRoute; stores: PaidRoute }> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_SHOPS_API', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.resetModules();
  return {
    demo: (await import('@/app/api/paid/demo/route')) as PaidRoute,
    stores: (await import('@/app/api/paid/stores/route')) as PaidRoute,
  };
}

/** 応答の wire 実体 (status / 関係ヘッダ / 生 body 文字列) を 1 つの決定的な形にまとめる。 */
async function wireOf(res: Response): Promise<{
  status: number;
  cacheControl: string | null;
  contentType: string | null;
  paymentRequired: string | null;
  paymentResponse: string | null;
  xPaymentResponse: string | null;
  body: string;
}> {
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control'),
    contentType: res.headers.get('content-type'),
    paymentRequired: res.headers.get('PAYMENT-REQUIRED'),
    paymentResponse: res.headers.get('PAYMENT-RESPONSE'),
    xPaymentResponse: res.headers.get('X-PAYMENT-RESPONSE'),
    body: await res.text(),
  };
}

beforeEach(() => {
  routeMocks.verify.mockReset();
  routeMocks.settle.mockReset();
  routeMocks.resolveStatus.mockReset();
  routeMocks.statusRateLimit.mockReset();
  routeMocks.store.clear();
  routeMocks.statusRateLimit.mockResolvedValue(true);
  // paid-first-party.test.ts と同じ in-memory KV (redelivery claim/promote を再現)。
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

describe('golden wire: 402 チャレンジ (支払いなし)', () => {
  it('/api/paid/demo の 402 が byte 単位で固定されている', async () => {
    const { demo } = await load();
    const wire = await wireOf(await demo.GET(req('/api/paid/demo')));

    expect(wire.status).toBe(402);
    expect(wire.cacheControl).toBe('no-store');
    expect(wire.contentType).toBe('application/json');
    // v1 body: キー順・数値の文字列表現・error 文字列まで固定
    expect(wire.body).toBe(
      '{"x402Version":1,"accepts":[{"scheme":"exact","network":"eip155:80002",' +
        '"maxAmountRequired":"3000000000000000000",' +
        '"resource":"https://open-pay.jp/api/paid/demo",' +
        '"description":"OpenPay x402 demo — pay 1 JPYC and unlock a signed hello.",' +
        '"mimeType":"application/json","payTo":"' +
        FORWARDER +
        '","maxTimeoutSeconds":600,"asset":"' +
        JPYC_AMOY +
        '","extra":{"name":"JPY Coin","version":"1","decimals":18,' +
        '"assetTransferMethod":"eip3009","openpay":{"mode":"forwarder-split","forwarder":"' +
        FORWARDER +
        '","merchant":"' +
        SELLER +
        '","merchantValue":"1000000000000000000","feeReceiver":"' +
        FEE_RECEIVER +
        '","feeValue":"2000000000000000000","commitVersion":' +
        '"0x7ff4e43ca5ec8a7745cdb456a45dc2f4787e1a8dc0ab9121c9941bfb1028ce89"}},' +
        '"outputSchema":{"input":{"type":"http","method":"GET","discoverable":true},' +
        '"output":{"type":"object","properties":{"message":{"type":"string",' +
        '"description":"Unlock greeting"},"paidAt":{"type":"string",' +
        '"description":"ISO timestamp of settlement"},"payer":{"type":"string",' +
        '"description":"Payer address (when available)"}},' +
        '"required":["message","paidAt"]}}}],"error":"payment_required"}',
    );
    // v2 面 (x402scan/公式クライアントが読む): base64 の中身まで固定
    expect(wire.paymentRequired).toBeTruthy();
    const v2 = JSON.parse(
      Buffer.from(wire.paymentRequired as string, 'base64').toString('utf8'),
    ) as unknown;
    expect(JSON.stringify(v2)).toBe(
      '{"x402Version":2,"resource":{"url":"https://open-pay.jp/api/paid/demo",' +
        '"description":"OpenPay x402 demo — pay 1 JPYC and unlock a signed hello.",' +
        '"mimeType":"application/json"},"accepts":[{"scheme":"exact",' +
        '"network":"eip155:80002","amount":"3000000000000000000","asset":"' +
        JPYC_AMOY +
        '","payTo":"' +
        FORWARDER +
        '","maxTimeoutSeconds":600,"extra":{"name":"JPY Coin","version":"1",' +
        '"decimals":18,"assetTransferMethod":"eip3009","openpay":{' +
        '"mode":"forwarder-split","forwarder":"' +
        FORWARDER +
        '","merchant":"' +
        SELLER +
        '","merchantValue":"1000000000000000000","feeReceiver":"' +
        FEE_RECEIVER +
        '","feeValue":"2000000000000000000","commitVersion":' +
        '"0x7ff4e43ca5ec8a7745cdb456a45dc2f4787e1a8dc0ab9121c9941bfb1028ce89"}}}],' +
        '"error":"payment_required","extensions":{"bazaar":{"info":{' +
        '"input":{"type":"http","method":"GET","discoverable":true},' +
        '"output":{"type":"object","properties":{"message":{"type":"string",' +
        '"description":"Unlock greeting"},"paidAt":{"type":"string",' +
        '"description":"ISO timestamp of settlement"},"payer":{"type":"string",' +
        '"description":"Payer address (when available)"}},' +
        '"required":["message","paidAt"]}}}}}',
    );
  });

  it('/api/paid/stores の 402 は価格 5 JPYC + 手数料 2 JPYC = 7 の総額で固定', async () => {
    const { stores } = await load();
    const wire = await wireOf(await stores.GET(req('/api/paid/stores')));
    expect(wire.status).toBe(402);
    expect(wire.cacheControl).toBe('no-store');
    // 金額 3 点 (総額/売り手/手数料) の文字列表現を固定
    expect(wire.body).toContain('"maxAmountRequired":"7000000000000000000"');
    expect(wire.body).toContain('"merchantValue":"5000000000000000000"');
    expect(wire.body).toContain('"feeValue":"2000000000000000000"');
    expect(wire.body).toContain('"resource":"https://open-pay.jp/api/paid/stores"');
    expect(wire.body.endsWith('"error":"payment_required"}')).toBe(true);
  });
});

describe('golden wire: verify 不合格 (402 + 理由)', () => {
  it('invalidReason が wire の error に載り、accepts を併記する', async () => {
    const { demo } = await load();
    routeMocks.verify.mockResolvedValue(
      new Response(
        JSON.stringify({ isValid: false, invalidReason: 'insufficient_balance' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const wire = await wireOf(await demo.GET(req('/api/paid/demo', paymentHeader())));

    expect(wire.status).toBe(402);
    expect(wire.cacheControl).toBe('no-store');
    expect(wire.body.startsWith('{"x402Version":1,"accepts":[{"scheme":"exact"')).toBe(true);
    expect(wire.body.endsWith('"error":"insufficient_balance"}')).toBe(true);
    // 402 応答には outputSchema を含めない (verify 後の accepts は facilitator 用の素の形)
    expect(wire.body).not.toContain('outputSchema');
    // v2 ヘッダも同じ error を持つ
    const v2 = JSON.parse(
      Buffer.from(wire.paymentRequired as string, 'base64').toString('utf8'),
    ) as { error: string; x402Version: number };
    expect(v2.x402Version).toBe(2);
    expect(v2.error).toBe('insufficient_balance');
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });
});

describe('golden wire: settle 成功 (200 + 決済応答ヘッダ)', () => {
  it('本文と 2 系統の決済応答ヘッダが byte 単位で固定されている', async () => {
    const { stores } = await load();
    routeMocks.verify.mockResolvedValue(
      new Response(JSON.stringify({ isValid: true, payer: PAYER }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    routeMocks.settle.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          transaction: TX_HASH,
          network: 'eip155:80002',
          payer: PAYER,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const wire = await wireOf(await stores.GET(req('/api/paid/stores', paymentHeader())));

    expect(wire.status).toBe(200);
    expect(wire.cacheControl).toBe('no-store');
    // 有料コンテンツの形 (items 配列) が壊れていないこと
    const body = JSON.parse(wire.body) as { items: { name: string }[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);

    // 決済応答は v1 (X-PAYMENT-RESPONSE) と v2 (PAYMENT-RESPONSE) の両方で、同じ内容。
    const decodeHeader = (raw: string | null): unknown =>
      JSON.parse(Buffer.from(raw as string, 'base64').toString('utf8'));
    const expected = {
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    };
    expect(decodeHeader(wire.xPaymentResponse)).toEqual(expected);
    expect(decodeHeader(wire.paymentResponse)).toEqual(expected);
    // 両ヘッダの base64 が同一文字列であること (エンコード経路の一致)
    expect(wire.xPaymentResponse).toBe(wire.paymentResponse);
  });
});

describe('golden wire: settle 失敗 / flag OFF', () => {
  it('settle 失敗は 402 + errorReason で、コンテンツを 1 byte も返さない', async () => {
    const { stores } = await load();
    routeMocks.verify.mockResolvedValue(
      new Response(JSON.stringify({ isValid: true, payer: PAYER }), { status: 200 }),
    );
    routeMocks.settle.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, errorReason: 'forwarder_reverted' }),
        { status: 200 },
      ),
    );
    const wire = await wireOf(await stores.GET(req('/api/paid/stores', paymentHeader())));
    expect(wire.status).toBe(402);
    expect(wire.body.endsWith('"error":"forwarder_reverted"}')).toBe(true);
    expect(wire.body).not.toContain('"items"');
    expect(wire.xPaymentResponse).toBeNull();
    expect(wire.paymentResponse).toBeNull();
  });

  it('flag OFF は 404 {"error":"not_found"} で固定 (完全 inert)', async () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '');
    vi.resetModules();
    const demo = (await import('@/app/api/paid/demo/route')) as PaidRoute;
    const wire = await wireOf(await demo.GET(req('/api/paid/demo')));
    expect(wire.status).toBe(404);
    expect(wire.body).toBe('{"error":"not_found"}');
    expect(wire.cacheControl).toBe('no-store');
  });
});
