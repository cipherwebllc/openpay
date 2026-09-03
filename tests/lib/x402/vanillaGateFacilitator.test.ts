// vanillaGate の facilitator 切替フェンス (agentic.market 裁定 2026-08-16):
//   - 既定 (cdpAuth なし): 従来 URL・authorization ヘッダ無し = 挙動完全不変
//   - cdp: CDP URL + リクエストごとの Bearer JWT (uri claim が verify/settle に束縛)
// wire body は両者で同一 (掟 12: 追加のみ・応答/順序を変えない)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { generateKeyPairSync } from 'node:crypto';

vi.mock('server-only', () => ({}));

const configHold = vi.hoisted(() => ({
  vanillaFacilitator: { url: 'https://facilitator.payai.network' } as {
    url: string;
    cdpAuth?: { keyId: string; keySecret: string };
  },
}));

vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    network: 'base',
    payTo: '0x1111111111111111111111111111111111111111',
    testMode: false,
    get vanillaFacilitator() {
      return configHold.vanillaFacilitator;
    },
  },
}));

// resource 束縛 claim (B5(b)) の KV を in-memory で「構成済み」にする。
// 既定 (kv.down = false) では本来の SET NX / CAS DEL 経路を通し、down = true で
// fail-open (claim 無しで従来どおり通す) を検証する。
const kvHold = vi.hoisted(() => ({
  store: new Map<string, string>(),
  down: false,
  unconfigured: false,
  lastTtlSec: null as number | null,
}));

vi.mock('@/lib/kv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
  return {
    ...actual,
    kvSetNxGet: async (key: string, value: string, ttlSec: number) => {
      if (kvHold.unconfigured) return { ok: false, reason: 'unconfigured' as const };
      if (kvHold.down) return { ok: false, reason: 'network_error' as const };
      kvHold.lastTtlSec = ttlSec;
      const existing = kvHold.store.get(key);
      if (existing !== undefined) return { ok: true, value: existing };
      kvHold.store.set(key, value);
      return { ok: true, value: null };
    },
    kvEval: async (_script: string, keys: string[], args: string[]) => {
      if (kvHold.down) return { ok: false, reason: 'network_error' as const };
      const current = kvHold.store.get(keys[0]);
      if (current === undefined) return { ok: true, value: 0 };
      const parsed = JSON.parse(current) as {
        bindingHash: string;
        credential: string;
      };
      if (parsed.bindingHash !== args[0] || parsed.credential !== args[1]) {
        return { ok: true, value: -1 };
      }
      kvHold.store.delete(keys[0]);
      return { ok: true, value: 1 };
    },
  };
});

import { logger } from '@/lib/logger';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

function ed25519Secret(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(
    (privateKey.export({ format: 'jwk' }) as { d: string }).d,
    'base64url',
  );
  const pub = Buffer.from(
    (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  return Buffer.concat([seed, pub]).toString('base64');
}

const RESOURCE = {
  resourceUrl: 'https://open-pay.jp/api/paid/usdc/stores',
  description: 'test resource',
  price: '$0.02',
};

function v1PaymentHeader(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: '0xsig', authorization: {} },
    }),
  ).toString('base64');
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ isValid: true, payer: '0xabc', success: true, transaction: '0xtx' }),
  });
  configHold.vanillaFacilitator = { url: 'https://facilitator.payai.network' };
  kvHold.store.clear();
  kvHold.down = false;
  kvHold.unconfigured = false;
  kvHold.lastTtlSec = null;
});

async function run(): Promise<void> {
  const req = new Request(RESOURCE.resourceUrl, {
    headers: { 'x-payment': v1PaymentHeader() },
  });
  await handleVanillaPaidGet(req, RESOURCE, () =>
    NextResponse.json({ ok: true }),
  );
}

describe('vanillaGate facilitator 切替', () => {
  it('既定: 従来 URL へ・authorization ヘッダ無し (挙動不変の回帰)', async () => {
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://facilitator.payai.network/verify',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://facilitator.payai.network/settle',
    );
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers.authorization).toBeUndefined();
    }
  });

  it('cdp: CDP URL へ・verify/settle それぞれの uri claim を持つ Bearer JWT が付く', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.cdp.coinbase.com/platform/v2/x402/verify',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.cdp.coinbase.com/platform/v2/x402/settle',
    );
    const uris: string[] = [];
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers.authorization).toMatch(/^Bearer /);
      const claims = JSON.parse(
        Buffer.from(
          headers.authorization.slice(7).split('.')[1],
          'base64url',
        ).toString('utf8'),
      );
      expect(claims.iss).toBe('cdp');
      expect(claims.sub).toBe('org/key-1');
      uris.push(claims.uri);
    }
    expect(uris).toEqual([
      'POST api.cdp.coinbase.com/platform/v2/x402/verify',
      'POST api.cdp.coinbase.com/platform/v2/x402/settle',
    ]);
    // CDP へは v2 ワイヤ (2026-08-20 実測: v1 body は 400 invalid_request)。
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.x402Version).toBe(2);
    expect(body.paymentPayload.x402Version).toBe(2);
    expect(body.paymentRequirements.network).toBe('eip155:8453');
    expect(body.paymentRequirements.amount).toBe(body.paymentRequirements.amount);
    expect(typeof body.paymentRequirements.amount).toBe('string');
    expect(body.paymentRequirements.maxAmountRequired).toBeUndefined();
    expect(body.paymentPayload.accepted).toEqual(body.paymentRequirements);
    expect(body.paymentPayload.resource.url).toBe(RESOURCE.resourceUrl);
    // 署名部 (payload) は client の値をそのまま同梱
    expect(body.paymentPayload.payload.signature).toBe('0xsig');
  });

  // Bazaar カタログ登録は facilitator に送る paymentPayload.extensions から抽出される
  // (coinbase/x402 bazaar/facilitator.ts extractDiscoveryInfo)。402 応答に載せるだけでは
  // 登録されない (2026-08-20 未掲載の真因)。
  it('cdp: 宣言のある resource は verify/settle 双方の paymentPayload.extensions.bazaar を運ぶ', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    await handleVanillaPaidGet(
      req,
      { ...RESOURCE, outputSchema: { input: { type: 'http', method: 'GET' } } },
      () => NextResponse.json({ ok: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const sent = JSON.parse((call[1] as { body: string }).body) as {
        paymentPayload: {
          resource: { url: string };
          extensions: {
            bazaar: { info: Record<string, unknown>; schema: Record<string, unknown> };
          };
        };
      };
      // 抽出側は resource.url と extensions.bazaar の両方を要求する
      expect(sent.paymentPayload.resource.url).toBe(RESOURCE.resourceUrl);
      expect(sent.paymentPayload.extensions.bazaar.info).toEqual({
        input: { type: 'http', method: 'GET' },
      });
      expect(sent.paymentPayload.extensions.bazaar.schema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
    }
  });

  // 掲載カードの serviceName/tags/iconUrl は settle 時に確定する (#384 と同じ経路) ので、
  // 402 だけでなく facilitator へ送る paymentPayload.resource にも同じ値を載せる。
  it('cdp: serviceName/tags/iconUrl は verify/settle の paymentPayload.resource にも載る', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    await handleVanillaPaidGet(
      req,
      {
        ...RESOURCE,
        outputSchema: { input: { type: 'http', method: 'GET' } },
        serviceName: 'JPYC Supply by Chain',
        tags: ['jpyc', 'token-supply'],
        iconUrl: 'https://open-pay.jp/icon-512.png',
      },
      () => NextResponse.json({ ok: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const sent = JSON.parse((call[1] as { body: string }).body) as {
        paymentPayload: { resource: { url: string; serviceName?: string; tags?: string[]; iconUrl?: string } };
      };
      expect(sent.paymentPayload.resource.serviceName).toBe('JPYC Supply by Chain');
      expect(sent.paymentPayload.resource.tags).toEqual(['jpyc', 'token-supply']);
      expect(sent.paymentPayload.resource.iconUrl).toBe('https://open-pay.jp/icon-512.png');
    }
  });

  it('cdp: メタ未指定の resource は resource に serviceName/tags/iconUrl を持たない (既存 4 本の挙動不変)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    await run();
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { paymentPayload: { resource: Record<string, unknown> } };
    expect(Object.keys(sent.paymentPayload.resource).sort()).toEqual(['description', 'mimeType', 'url']);
  });

  it('cdp: 宣言のない resource は extensions を積まない (store 商品など)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    await run();
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { paymentPayload: { extensions?: unknown } };
    expect(sent.paymentPayload.extensions).toBeUndefined();
  });

  it('既定 (payai): wire body は v1 のまま (network=base・maxAmountRequired)', async () => {
    await run();
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.x402Version).toBe(1);
    expect(body.paymentRequirements.network).toBe('base');
    expect(typeof body.paymentRequirements.maxAmountRequired).toBe('string');
    expect(body.paymentPayload.accepted).toBeUndefined();
  });

  // CDP は invalid な支払いを 200 でなく 4xx + 正規の判定 body で返す (2026-08-20 本番実測)。
  it('cdp: verify 400 + isValid:false は 503 でなく 402 challenge (settle は呼ばれない)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        isValid: false,
        invalidReason: 'invalid_payload',
        payer: '0xabc',
      }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('cdp: verify 400 でも判定 body でなければ従来どおり 503', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ errorType: 'invalid_request' }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
  });

  it('cdp: verify 500 は判定 body があっても 503 (障害は fail-closed)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ isValid: false }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
  });

  it('既定 (payai): 非 2xx は従来どおり 503 (v1 挙動不変の回帰)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ isValid: false, invalidReason: 'x' }),
    });
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
  });

  it('cdp: JWT 生成が throw したら 503 (課金なし・fail-closed)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'k', keySecret: 'broken!!' },
    };
    const req = new Request(RESOURCE.resourceUrl, {
      headers: { 'x-payment': v1PaymentHeader() },
    });
    const res = await handleVanillaPaidGet(req, RESOURCE, () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// B5(b): exact scheme の verify は value >= maxAmountRequired しか見ず resource を含まない。
// 1 通の署名済み X-PAYMENT が同額・別 resource で二重解錠されるのを、resource + query
// 束縛の claim で断つ。KV は money truth ではないので障害時は fail-open。
describe('vanillaGate resource 束縛 claim', () => {
  const SUPPLY = {
    resourceUrl: 'https://open-pay.jp/api/paid/usdc/jpyc/supply',
    description: 'jpyc supply',
    price: '$0.002',
  };
  const BALANCE = {
    resourceUrl: 'https://open-pay.jp/api/paid/usdc/jpyc/balance',
    description: 'jpyc balance',
    price: '$0.002',
  };
  const SIGNATURE = `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`;
  const PAYER = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
  const NONCE = `0x${'cd'.repeat(32)}`;

  function paidHeader(signature = SIGNATURE): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: {
          signature,
          authorization: {
            from: PAYER,
            to: '0x1111111111111111111111111111111111111111',
            value: '2000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: NONCE,
          },
        },
      }),
    ).toString('base64');
  }

  // v2 (PAYMENT-SIGNATURE) 版。accepted は toV2Accept(accepts.v1Caip2) と完全一致が要る。
  // 同じ authorization なので、v1 経路と**同じ claim キー**を導かなければならない。
  function v2PaidHeader(from = PAYER): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '2000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        },
        payload: {
          signature: SIGNATURE,
          authorization: {
            from,
            to: '0x1111111111111111111111111111111111111111',
            value: '2000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: NONCE,
          },
        },
      }),
    ).toString('base64');
  }

  async function get(
    resource: typeof SUPPLY,
    opts: {
      query?: string;
      header?: string;
      v2Header?: string;
      content?: () => NextResponse;
    } = {},
  ): Promise<NextResponse> {
    const req = new Request(`${resource.resourceUrl}${opts.query ?? ''}`, {
      headers: opts.v2Header
        ? { 'PAYMENT-SIGNATURE': opts.v2Header }
        : { 'x-payment': opts.header ?? paidHeader() },
    });
    return handleVanillaPaidGet(
      req,
      resource,
      opts.content ?? (() => NextResponse.json({ ok: true })),
    );
  }

  // claim は verify の**後**なので、conflict の判定にも verify 1 回分のコストがかかる
  // (未認証の誰でも KV に 30 分キーを作れる書き込み経路を作らないための代償)。
  it('同じ authorization を別 resource へ = 2 本目は 409 (settle は呼ばれない)', async () => {
    const first = await get(SUPPLY);
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = await get(BALANCE);
    expect(second.status).toBe(409);
    // 追加されるのは verify 1 回だけ = 2 本目のコンテンツ生成も課金も起きない。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://facilitator.payai.network/verify',
    );
    const body = (await second.json()) as { error?: string };
    expect(body.error).toBe('authorization_conflict');
  });

  it('claim の TTL は再配信 cache と別定数の 30 分 (VANILLA_CLAIM_TTL_SEC)', async () => {
    await get(SUPPLY);
    expect(kvHold.lastTtlSec).toBe(1800);
  });

  it('同じ authorization を同じ resource へ再送 = 従来どおり通る (再配信の挙動不変)', async () => {
    expect((await get(SUPPLY)).status).toBe(200);
    const again = await get(SUPPLY);
    expect(again.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(again.headers.get('X-PAYMENT-RESPONSE')).not.toBeNull();
  });

  it('query の並び順だけが違う再送は同一束縛 (正直な再送を 409 にしない)', async () => {
    expect((await get(SUPPLY, { query: '?chain=polygon&x=1' })).status).toBe(200);
    const again = await get(SUPPLY, { query: '?x=1&chain=polygon' });
    expect(again.status).toBe(200);
  });

  it('同じ resource でも別 query は別束縛 = 409', async () => {
    expect((await get(SUPPLY, { query: '?chain=polygon' })).status).toBe(200);
    const other = await get(SUPPLY, { query: '?chain=base' });
    expect(other.status).toBe(409);
  });

  it('KV 障害時は claim せず従来どおり通す (fail-open)', async () => {
    kvHold.down = true;
    expect((await get(SUPPLY)).status).toBe(200);
    const second = await get(BALANCE);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // このファイルで unconfigured を起こすのはこの 1 本だけ (warn 抑止フラグはモジュール
  // 単位の状態なので、先に別テストが warn を消費すると偽陰性になる)。
  it('KV 未構成は fail-open + warn はプロセス 1 回だけ (運用に気づかせつつログを埋めない)', async () => {
    kvHold.unconfigured = true;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect((await get(SUPPLY)).status).toBe(200);
      // 二重解錠の防御は OFF = 別 resource へも通る (docs/DEPLOY_CHECKLIST §14 に明記)。
      expect((await get(BALANCE)).status).toBe(200);
      const unconfiguredWarns = warn.mock.calls.filter(
        ([msg]) => msg === 'x402.vanilla.claim_unconfigured',
      );
      expect(unconfiguredWarns).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('verify 失敗ではそもそも claim を張らない (未使用の署名を人質にしない)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: false, invalidReason: 'insufficient_funds' }),
    });
    const failed = await get(SUPPLY);
    expect(failed.status).toBe(402);
    // claim は verify 通過後にしか張らない = KV には何も書かれない。
    expect(kvHold.store.size).toBe(0);
    // 署名は未使用のまま = 同じ authorization を別 resource で正直に使い直せる。
    const second = await get(BALANCE);
    expect(second.status).toBe(200);
  });

  it('content 4xx も claim を解放する (引数を直した同一支払いの再送を塞がない)', async () => {
    const invalid = await get(SUPPLY, {
      content: () => NextResponse.json({ error: 'invalid_query' }, { status: 400 }),
    });
    expect(invalid.status).toBe(400);
    const retried = await get(SUPPLY, { query: '?address=0x1' });
    expect(retried.status).toBe(200);
  });

  it('claim を持たない request (match) の content 4xx は claim を消さない', async () => {
    // 1 本目が claim を張って 200 で配信済み。
    expect((await get(SUPPLY)).status).toBe(200);
    // 同一束縛の 2 本目は 'match' = 解放権を持たない。ここで 400 を返させても claim は残る。
    const conflictingRetry = await get(SUPPLY, {
      content: () => NextResponse.json({ error: 'bad' }, { status: 400 }),
    });
    expect(conflictingRetry.status).toBe(400);
    // よって別 resource への流用は依然として塞がれたまま。
    expect((await get(BALANCE)).status).toBe(409);
  });

  it('同じ nonce・別署名は credential 不一致で 409 (key を知るだけでは横取りできない)', async () => {
    expect((await get(SUPPLY)).status).toBe(200);
    const otherSignature = `0x${'1'.repeat(63)}2${'0'.repeat(63)}31b`;
    // 束縛 (resource + query) は同一なので、弾かれる理由は credential 不一致だけ。
    const hijack = await get(SUPPLY, {
      header: paidHeader(otherSignature),
    });
    expect(hijack.status).toBe(409);
  });

  it('v1 X-PAYMENT と v2 PAYMENT-SIGNATURE は同じ claim キーを導く', async () => {
    expect((await get(SUPPLY)).status).toBe(200);
    // 封筒 (v1/v2) が違うだけの同一 authorization。別 resource への流用は 409。
    const viaV2 = await get(BALANCE, { v2Header: v2PaidHeader() });
    expect(viaV2.status).toBe(409);
  });

  it('from の checksum 大文字小文字は同じ claim キーを導く', async () => {
    expect((await get(SUPPLY)).status).toBe(200);
    const checksummed = `0x${PAYER.slice(2).toUpperCase()}`;
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: {
          signature: SIGNATURE,
          authorization: {
            from: checksummed,
            to: '0x1111111111111111111111111111111111111111',
            value: '2000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: NONCE,
          },
        },
      }),
    ).toString('base64');
    expect((await get(BALANCE, { header })).status).toBe(409);
  });

  it('settle 障害 (503) は claim を保持する (broadcast 済みかもしれない)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: true, payer: '0xabc' }),
    });
    fetchMock.mockRejectedValueOnce(new Error('settle timeout'));
    expect((await get(SUPPLY)).status).toBe(503);
    // 使用済みかもしれない authorization を別 resource へ回させない。
    expect((await get(BALANCE)).status).toBe(409);
  });

  it('settle の broadcast 前拒否だけ claim を解放する (未送信が確実な reason)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: true, payer: '0xabc' }),
    });
    // CDP は broadcast 前の拒否を 4xx + errorReason で返す (2026-08-20 実測の形)。
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ success: false, errorReason: 'insufficient_balance' }),
    });
    const failed = await get(SUPPLY);
    expect(failed.status).toBe(402);
    // 署名は未送信が確実 = 正直に別 resource で使い直せる。
    expect((await get(BALANCE)).status).toBe(200);
  });

  it('settle の未知 reason は claim を保持する (broadcast 済みの可能性)', async () => {
    configHold.vanillaFacilitator = {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpAuth: { keyId: 'org/key-1', keySecret: ed25519Secret() },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: true, payer: '0xabc' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ success: false, errorReason: 'unexpected_state' }),
    });
    expect((await get(SUPPLY)).status).toBe(402);
    expect((await get(BALANCE)).status).toBe(409);
  });

  // record は sha256 束縛 + fingerprint の固定長。生の query を保存していた頃は 4KB 超の
  // ゴミ query で record が MAX_RECORD_BYTES を越え、claim ごと fail-open で無効化できた。
  it('5KB のゴミ query でも claim は書かれる (record は固定長・防御を外せない)', async () => {
    const query = `?q=${'a'.repeat(5000)}`;
    expect((await get(SUPPLY, { query })).status).toBe(200);
    expect(kvHold.store.size).toBe(1);
    const stored = [...kvHold.store.values()][0];
    // 生 query は KV に残らない (hash のみ) ので record は常に小さい。
    expect(stored.length).toBeLessThan(256);
    expect(stored).not.toContain('aaaa');
    // よって別 resource への流用は塞がれる。
    expect((await get(BALANCE)).status).toBe(409);
  });

  it('nonce/署名を読めない payload は claim せず従来どおり facilitator 判定へ', async () => {
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: { signature: '0xsig', authorization: {} },
      }),
    ).toString('base64');
    const first = await get(SUPPLY, { header });
    expect(first.status).toBe(200);
    const second = await get(BALANCE, { header });
    expect(second.status).toBe(200);
    // claim を挟まないだけで、verify → settle は両 request とも従来どおり走る。
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://facilitator.payai.network/verify',
      'https://facilitator.payai.network/settle',
      'https://facilitator.payai.network/verify',
      'https://facilitator.payai.network/settle',
    ]);
    expect(first.headers.get('X-PAYMENT-RESPONSE')).not.toBeNull();
    expect(second.headers.get('X-PAYMENT-RESPONSE')).not.toBeNull();
  });
});
