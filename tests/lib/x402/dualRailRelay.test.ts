// dual-rail リレー (/api/x402/relay/*) の unit テスト。
// 検証の柱: (1) flag OFF で完全 inert (404)・CDP 鍵なしは 503、(2) 掲載メタは registry の
// 登録値のみから注入され呼び出し body 由来の値が facilitator へ流れない (catalog poisoning 防止)、
// (3) facilitator の判定 body は素通し・障害 (5xx) は 503。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';

const state = vi.hoisted(() => ({
  flags: { enableX402DualRail: true, enableX402Facilitator: true },
  cdpAuth: { keyId: 'k', keySecret: 's' } as
    | { keyId: string; keySecret: string }
    | undefined,
  rateLimited: false,
  resource: null as unknown,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (t, p) =>
        p in state.flags
          ? state.flags[p as keyof typeof state.flags]
          : (t as Record<string | symbol, unknown>)[p],
    }),
  };
});

vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    network: 'base',
    payTo: '0x00000000000000000000000000000000000000FE',
    testMode: false,
    get vanillaFacilitator() {
      return { url: 'https://cdp.example', cdpAuth: state.cdpAuth };
    },
    arcGateway: { enabled: false },
  },
}));

vi.mock('@/lib/x402/cdpJwt', () => ({
  generateCdpJwt: () => 'test-jwt',
}));

const ledger = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/lib/x402/settleLedger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/settleLedger')>()),
  recordSettleLedgerAfterResponse: ledger.record,
}));

vi.mock('@/lib/x402/registry', () => ({
  getResource: vi.fn(async () => state.resource),
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => !state.rateLimited),
}));

import {
  handleDualRailRelay,
  handleDualRailRequirements,
} from '@/lib/x402/dualRailRelay';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { logger } from '@/lib/logger';
import { getResource } from '@/lib/x402/registry';

const SELLER = getAddress('0x1111111111111111111111111111111111111111');
const SELLER_USDC = getAddress('0x2222222222222222222222222222222222222222');
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    merchant: SELLER,
    url: 'https://seller.example/api/data',
    description: 'Seller paid data API',
    priceJpyc: '10',
    category: 'api',
    payTo: SELLER,
    network: 'eip155:137',
    active: true,
    createdAt: 1,
    usdc: { payTo: SELLER_USDC, priceUsd: '0.005', serviceName: 'Seller Data' },
    ...over,
  };
}

// v1 X-PAYMENT ヘッダ (base64 JSON)。network は v1 命名 'base'。
function v1Header(network = 'base'): string {
  return Buffer.from(
    JSON.stringify({
      scheme: 'exact',
      network,
      payload: { authorization: {}, signature: '0xsig' },
    }),
    'utf8',
  ).toString('base64');
}

function post(path: string, body: unknown): Request {
  return new Request(`https://open-pay.jp/api/x402/relay/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function reqGet(resourceId?: string): Request {
  const q = resourceId === undefined ? '' : `?resourceId=${resourceId}`;
  return new Request(`https://open-pay.jp/api/x402/relay/requirements${q}`);
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  state.flags.enableX402DualRail = true;
  state.flags.enableX402Facilitator = true;
  state.cdpAuth = { keyId: 'k', keySecret: 's' };
  state.rateLimited = false;
  state.resource = record();
  fetchMock.mockReset();
  ledger.record.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function facilitatorReplies(status: number, body: unknown) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('dualRailRelay gate', () => {
  it.each(['enableX402DualRail', 'enableX402Facilitator'] as const)(
    'flag OFF (%s) → 404 (完全 inert)',
    async (flag) => {
      state.flags[flag] = false;
      const res = await handleDualRailRelay(
        post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
        'verify',
      );
      expect(res.status).toBe(404);
      const reqs = await handleDualRailRequirements(reqGet('res-1'));
      expect(reqs.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('CDP 鍵なし → 503 (fallback facilitator へ黙って流さない)', async () => {
    state.cdpAuth = undefined;
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'relay_unconfigured' });
  });

  it.each(['verify', 'settle'] as const)('%s: rate limit 超過 → 429 (掲載も facilitator も読まない)', async (action) => {
    state.rateLimited = true;
    const res = await handleDualRailRelay(
      post(action, { resourceId: 'res-1', paymentHeader: v1Header() }),
      action,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(checkIpRateLimit).toHaveBeenCalledExactlyOnceWith('x402-dual-rail', null, 60, 60);
    expect(getResource).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dualRailRelay resolveTarget (登録リソース限定)', () => {
  it.each([
    ['未登録', null],
    ['無効化済', record({ active: false })],
    ['モデレーション hidden', record({ hidden: true })],
    ['USDC 面なし (JPYC のみ出品)', record({ usdc: undefined })],
  ])('%s → 404 resource_not_found', async (_label, resource) => {
    state.resource = resource;
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'resource_not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resourceId 欠落/型不正 → 400', async () => {
    const res = await handleDualRailRelay(
      post('verify', { paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_resource_id' });
  });
});

describe('dualRailRequirements', () => {
  it.each([undefined, '', 'a'.repeat(101)])('invalid resource ID %j skips the KV limiter and lookup', async (id) => {
    const res = await handleDualRailRequirements(reqGet(id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_resource_id' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(getResource).not.toHaveBeenCalled();
  });

  it('valid unknown resource ID reaches the lookup without the KV limiter', async () => {
    state.resource = null;
    const res = await handleDualRailRequirements(reqGet('a'.repeat(100)));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'resource_not_found' });
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(getResource).toHaveBeenCalledExactlyOnceWith('a'.repeat(100));
  });

  it('valid resource ID is served even while the verify/settle limiter is denying', async () => {
    // verify / settle が 429 になる状態でも、requirements は制限を呼ばずに要件を返す。
    state.rateLimited = true;
    const res = await handleDualRailRequirements(reqGet('res-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).resourceId).toBe('res-1');
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(getResource).toHaveBeenCalledExactlyOnceWith('res-1');
  });

  it('登録値から USDC 要件一式を返す (payTo=出品者・Base USDC・atomic 変換)', async () => {
    const res = await handleDualRailRequirements(reqGet('res-1'));
    expect(res.status).toBe(200);
    // edge に置かない: 409 の後の取り直しが古い要件を受け取ると、価格を変えた後の USDC 決済が止まり続ける
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.resourceId).toBe('res-1');
    expect(body.v1Accepts).toMatchObject({
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '5000', // $0.005 → 6 桁 atomic
      resource: 'https://seller.example/api/data',
      payTo: SELLER_USDC,
      asset: BASE_USDC,
    });
    expect(body.v2Accept.network).toBe('eip155:8453');
    expect(body.v2Accept.amount).toBe('5000');
    // paymentRequiredHeader はそのまま PAYMENT-REQUIRED に載せられる完成形。
    const decoded = JSON.parse(
      Buffer.from(body.paymentRequiredHeader as string, 'base64').toString('utf8'),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe('https://seller.example/api/data');
    expect(decoded.resource.serviceName).toBe('Seller Data');
    expect(decoded.accepts).toEqual([body.v2Accept]);
    expect(decoded.extensions.bazaar.schema).toBeDefined(); // CDP は schema 無しを掲載拒否
  });

  it('resourceId なし → 400', async () => {
    const res = await handleDualRailRequirements(reqGet());
    expect(res.status).toBe(400);
  });
});

describe('dualRailRelay verify/settle', () => {
  it('支払いヘッダなし / 形不一致 → 400 invalid_payment_payload (facilitator 不着)', async () => {
    for (const body of [
      { resourceId: 'res-1' },
      { resourceId: 'res-1', paymentHeader: v1Header('polygon') }, // network 不一致
      { resourceId: 'res-1', paymentHeader: 'not-base64-json' },
    ]) {
      const res = await handleDualRailRelay(post('verify', body), 'verify');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payment_payload' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('JSON でない body → 400', async () => {
    const res = await handleDualRailRelay(
      new Request('https://open-pay.jp/api/x402/relay/verify', {
        method: 'POST',
        body: 'not-json',
      }),
      'verify',
    );
    expect(res.status).toBe(400);
  });

  it('verify: 判定 body を素通しし、wire は registry の登録値だけを載せる', async () => {
    facilitatorReplies(200, { isValid: true, payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('verify', {
        resourceId: 'res-1',
        paymentHeader: v1Header(),
        // 呼び出し側が掲載メタを差し込もうとしても無視される (catalog poisoning 防止)。
        resource: { url: 'https://evil.example/spam', description: 'spam' },
      }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: '0xabc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cdp.example/verify');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-jwt',
    );
    const wire = JSON.parse(init.body as string);
    expect(wire.x402Version).toBe(2);
    expect(wire.paymentPayload.resource.url).toBe('https://seller.example/api/data');
    expect(wire.paymentPayload.resource.description).toBe('Seller paid data API');
    expect(wire.paymentPayload.resource.serviceName).toBe('Seller Data');
    expect(wire.paymentPayload.accepted.payTo).toBe(SELLER_USDC);
    expect(wire.paymentPayload.extensions.bazaar).toBeDefined();
    expect(JSON.stringify(wire)).not.toContain('evil.example');
  });

  it('verify: CDP の 4xx 判定 body (isValid:false) も素通し (障害と混同しない)', async () => {
    facilitatorReplies(400, { isValid: false, invalidReason: 'invalid_payload' });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      isValid: false,
      invalidReason: 'invalid_payload',
    });
  });

  it('settle: /settle に届き success body を素通し', async () => {
    facilitatorReplies(200, { success: true, transaction: '0xtx', payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, transaction: '0xtx' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://cdp.example/settle',
    );
    // 運営台帳: 出品者の payTo・登録 URL・USDC 表示単位で 1 行。
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][0]).toMatchObject({
      source: 'usdc-dual-rail',
      resource: 'https://seller.example/api/data',
      payer: '0xabc',
      payTo: SELLER_USDC,
      amount: '0.005',
      asset: 'USDC',
      tx: '0xtx',
    });
  });

  it('verify では台帳に書かない (settle 成功だけ)', async () => {
    facilitatorReplies(200, { isValid: true, payer: '0xabc' });
    await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('B14: CDP settle 409 + success:true returns 503 without forwarding success or recording settlement', async () => {
    facilitatorReplies(409, { success: true, transaction: '0xtx', payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdp.example/settle');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.has('PAYMENT-RESPONSE')).toBe(false);
    expect(res.headers.has('X-PAYMENT-RESPONSE')).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  // 2026-11-24 Sentry: CDP が判定の形でない 400 (要求そのものを断った) を返したとき、「使えない」(503) として理由なしで
  // 記録していた。断られたとして理由を記録し、verify はお金を動かさないので判定の形で返す。
  const CDP_REJECT = { errorType: 'invalid_request', errorMessage: 'paymentPayload.payload is invalid', correlationId: 'c-1' };

  it('verify: CDP が判定の形でない 400 で断ったら、200 + isValid:false で返し、理由を記録する', async () => {
    const warn = vi.spyOn(logger, 'warn');
    facilitatorReplies(400, CDP_REJECT);
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: false, invalidReason: 'unexpected_verify_error' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(warn).toHaveBeenCalledWith('x402.dualrail.facilitator_rejected', {
      action: 'verify',
      resourceId: 'res-1',
      status: 400,
      reason: 'errorType=invalid_request errorMessage=paymentPayload.payload is invalid',
    });
    expect(warn).not.toHaveBeenCalledWith('x402.dualrail.facilitator_unavailable', expect.anything());
  });

  it('settle: CDP が判定の形でない 400 で断っても、応答は従来どおり 503 (送金前と言い切れない)・理由は記録する', async () => {
    const warn = vi.spyOn(logger, 'warn');
    facilitatorReplies(400, CDP_REJECT);
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
    expect(res.headers.has('PAYMENT-RESPONSE')).toBe(false);
    expect(res.headers.has('X-PAYMENT-RESPONSE')).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'x402.dualrail.facilitator_rejected',
      expect.objectContaining({ action: 'settle', status: 400 }),
    );
  });

  async function rejectedReason(body: unknown): Promise<string> {
    const warn = vi.spyOn(logger, 'warn');
    warn.mockClear();
    facilitatorReplies(422, body);
    await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    const call = warn.mock.calls.find(([msg]) => msg === 'x402.dualrail.facilitator_rejected');
    return (call?.[1] as { reason: string }).reason;
  }

  it('断った理由は語の項目と文の項目だけを短く記録し、body の残りは記録しない', async () => {
    const address = `0x${'cd'.repeat(20)}`;
    const reason = await rejectedReason({
      errorType: 'invalid_request',
      error: 'bad\nsignature', // 語の形でない → 記録しない
      errorMessage: `payer ${address} ${'x'.repeat(400)}`,
      paymentPayload: { signature: `0x${'ab'.repeat(65)}` },
    });
    expect(reason.startsWith(`errorType=invalid_request errorMessage=payer ${address} xxx`)).toBe(true);
    expect(reason).not.toContain('bad');
    expect(reason).not.toContain('paymentPayload');
    expect(reason.length).toBe(200);
  });

  it.each([
    ['0x の付いた署名', `0x${'ab'.repeat(65)}`],
    ['0x の無い長い 16 進', 'ab'.repeat(48)],
    ['0X と大文字', `0X${'CD'.repeat(40)}`],
  ])('65 桁以上の 16 進は伏せる (%s)', async (_label, hex) => {
    const reason = await rejectedReason({ errorMessage: `bad value ${hex} end` });
    expect(reason).toBe('errorMessage=bad value [redacted] end');
  });

  it.each([
    ['JSON の引用', 'invalid paymentPayload: {"payload":{"reference":"order-17"}}', 'errorMessage=invalid paymentPayload:'],
    ['配列の引用', 'unexpected fields [reference, memo]', 'errorMessage=unexpected fields'],
    ['引用符', 'bad reference "order-17" in payload', 'errorMessage=bad reference'],
    ['引用の無い説明', 'paymentPayload.payload is invalid', 'errorMessage=paymentPayload.payload is invalid'],
  ])('文の項目は最初の引用より前だけを記録する (%s)', async (_label, message, expected) => {
    expect(await rejectedReason({ errorMessage: message })).toBe(expected);
  });

  it('200 字の切れ目にまたがる署名も、切る前に伏せる (先頭だけが残らない)', async () => {
    const hex = 'ab'.repeat(65);
    const reason = await rejectedReason({ errorMessage: `${'x'.repeat(170)} ${hex} tail` });
    expect(reason).toBe(`errorMessage=${'x'.repeat(170)} [redacted] tail`);
    expect(reason).not.toContain('abab');
  });

  it.each([408, 425, 429])('CDP の一時的な %s は「断られた」とせず、従来どおり 503 (あとでやり直せる)', async (status) => {
    const warn = vi.spyOn(logger, 'warn');
    warn.mockClear();
    facilitatorReplies(status, { errorType: 'rate_limit_exceeded' });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
    expect(warn).toHaveBeenCalledWith('x402.dualrail.facilitator_unavailable', {
      action: 'verify',
      resourceId: 'res-1',
      error: `facilitator /verify HTTP ${status}`,
    });
    expect(warn).not.toHaveBeenCalledWith('x402.dualrail.facilitator_rejected', expect.anything());
  });

  it('記録できる理由が無ければ no_reason', async () => {
    expect(await rejectedReason({ errorType: 'has space', errorMessage: '{"only":"quoted"}' })).toBe('no_reason');
  });

  it('verify: 否定と肯定が混ざった 4xx は判定として素通しせず、固定の isValid:false で返す', async () => {
    facilitatorReplies(409, { isValid: false, success: true });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: false, invalidReason: 'unexpected_verify_error' });
  });

  it('settle: 否定と肯定が混ざった 4xx は 503 で、台帳にも支払いの応答ヘッダにも進まない', async () => {
    facilitatorReplies(409, { success: false, isValid: true, transaction: '0xtx' });
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
    expect(res.headers.has('PAYMENT-RESPONSE')).toBe(false);
    expect(res.headers.has('X-PAYMENT-RESPONSE')).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('facilitator 5xx は従来どおり「使えない」として記録する (断られたとは記録しない)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    facilitatorReplies(502, { errorType: 'bad_gateway' });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'verify',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
    expect(warn).toHaveBeenCalledWith('x402.dualrail.facilitator_unavailable', {
      action: 'verify',
      resourceId: 'res-1',
      error: 'facilitator /verify HTTP 502',
    });
    expect(warn).not.toHaveBeenCalledWith('x402.dualrail.facilitator_rejected', expect.anything());
  });

  it('facilitator 5xx → 503 (判定なしを成功にも失敗にも見せない)', async () => {
    facilitatorReplies(500, { error: 'boom' });
    const res = await handleDualRailRelay(
      post('settle', { resourceId: 'res-1', paymentHeader: v1Header() }),
      'settle',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable' });
  });

  it('v2 PAYMENT-SIGNATURE ヘッダも受理する (accepted は要件一式と一致)', async () => {
    // 出品者は requirements の v2Accept をそのまま 402 に載せ、購入者 client がそれを
    // accepted に写して支払う — その round-trip を再現する。
    const reqs = await handleDualRailRequirements(reqGet('res-1'));
    const { v2Accept } = await reqs.json();
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: v2Accept,
        payload: { authorization: {}, signature: '0xsig' },
      }),
      'utf8',
    ).toString('base64');
    facilitatorReplies(200, { isValid: true, payer: '0xabc' });
    const res = await handleDualRailRelay(
      post('verify', { resourceId: 'res-1', paymentSignatureHeader: header }),
      'verify',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: '0xabc' });
  });
});


describe('seller-pinned relay snapshot', () => {
  it.each(['verify', 'settle'] as const)('%s refuses a recipient edit after requirements were pinned', async (action) => {
    const face = await (await handleDualRailRequirements(reqGet('res-1'))).json();
    state.resource = record({ usdc: { ...record().usdc, payTo: SELLER } });
    const res = await handleDualRailRelay(post(action, {
      resourceId: 'res-1', paymentHeader: v1Header(), paymentRequirements: face.v1Accepts,
    }), action);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'requirements_mismatch' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('uses the registry snapshot for verify and settle and refuses a later price change', async () => {
    const face = await (await handleDualRailRequirements(reqGet('res-1'))).json();
    const body = { resourceId: 'res-1', paymentHeader: v1Header(), paymentRequirements: face.v1Accepts };
    facilitatorReplies(200, { isValid: true });
    expect((await handleDualRailRelay(post('verify', body), 'verify')).status).toBe(200);
    facilitatorReplies(200, { success: true });
    expect((await handleDualRailRelay(post('settle', body), 'settle')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    state.resource = record({ usdc: { ...record().usdc, priceUsd: '1' } });
    expect((await handleDualRailRelay(post('settle', body), 'settle')).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


describe('relay money-field comparison', () => {
  it.each(['verify', 'settle'] as const)('%s ignores display metadata changes but uses registry metadata', async (action) => {
    const face = await (await handleDualRailRequirements(reqGet('res-1'))).json();
    state.resource = record({ description: 'Updated description', url: 'https://seller.example/new' });
    facilitatorReplies(200, action === 'verify' ? { isValid: true } : { success: true });
    const res = await handleDualRailRelay(post(action, {
      resourceId: 'res-1', paymentHeader: v1Header(), paymentRequirements: face.v1Accepts,
    }), action);
    expect(res.status).toBe(200);
    const wire = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(wire.paymentPayload.resource.description).toBe('Updated description');
    expect(wire.paymentPayload.resource.url).toBe('https://seller.example/new');
    expect(wire.paymentRequirements.payTo).toBe(SELLER_USDC);
  });

  it.each(['payTo', 'maxAmountRequired', 'asset', 'network', 'scheme'])('still rejects changed %s before facilitator I/O', async (field) => {
    const face = await (await handleDualRailRequirements(reqGet('res-1'))).json();
    const res = await handleDualRailRelay(post('verify', {
      resourceId: 'res-1', paymentHeader: v1Header(),
      paymentRequirements: { ...face.v1Accepts, [field]: 'substituted' },
    }), 'verify');
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
