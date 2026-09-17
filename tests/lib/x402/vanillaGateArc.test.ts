// Arc rail (Circle Gateway x402 facilitator) のフェンス — plans/arc-x402-gateway.md。
//   - flag ON: 402 の v2 accepts は [Base, Arc]・v1 body は Base 1 件のまま (Gateway は v2 のみ)
//   - Arc accepted の PAYMENT-SIGNATURE → Gateway URL へ認証なし v2 wire (verify → settle)
//   - Base accepted は従来どおり (CDP/payai wire・URL・ヘッダ不変 = 掟 12)
//   - Gateway の判定 (isValid:false / success:false) は 402 へ透過・5xx は 503 (課金なし)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));
const ledger = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/lib/x402/settleLedger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/settleLedger')>()),
  recordSettleLedgerAfterResponse: ledger.record,
}));

const PAY_TO = '0x1111111111111111111111111111111111111111';
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const configHold = vi.hoisted(() => ({
  arcEnabled: true,
}));

vi.mock('@/lib/x402/config', () => ({
  ARC_GATEWAY_MAX_TIMEOUT_SECONDS: 604_900,
  x402Config: {
    network: 'base-sepolia',
    payTo: '0x1111111111111111111111111111111111111111',
    testMode: false,
    vanillaFacilitator: { url: 'https://facilitator.payai.network' },
    get arcGateway() {
      return configHold.arcEnabled
        ? {
            enabled: true,
            chainId: 5042002,
            caip2: 'eip155:5042002',
            usdc: '0x3600000000000000000000000000000000000000',
            gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
            url: 'https://gateway-api-testnet.circle.com',
            payTo: '0x1111111111111111111111111111111111111111',
          }
        : { enabled: false };
    },
  },
}));

// resource 束縛 claim の KV は in-memory (vanillaGateFacilitator.test と同じ最小実装)。
const kvHold = vi.hoisted(() => ({ store: new Map<string, string>(), claimed: 0 }));
vi.mock('@/lib/kv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
  return {
    ...actual,
    kvSetNxGet: async (key: string, value: string) => {
      const existing = kvHold.store.get(key);
      if (existing !== undefined) return { ok: true, value: existing };
      kvHold.store.set(key, value);
      kvHold.claimed += 1;
      return { ok: true, value: null };
    },
    kvEval: async (_script: string, keys: string[]) => {
      const had = kvHold.store.delete(keys[0]);
      return { ok: true, value: had ? 1 : 0 };
    },
  };
});

import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

const RESOURCE = {
  resourceUrl: 'https://open-pay.jp/api/paid/hello',
  description: 'hello',
  price: '$0.001',
};

const ARC_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:5042002',
  amount: '1000',
  asset: ARC_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 604_900,
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: GATEWAY_WALLET },
};
const BASE_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
};

const PAYER = '0x2222222222222222222222222222222222222222';
// 65 byte・v=27 の secp256k1 形 (fingerprint が受理する形。中身の真偽は facilitator mock が決める)
const SIG = `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`;
const nonceHex = (n: string): string => `0x${n.replace(/^0x/, '').padStart(64, '0')}`;

function v2Header(accepted: unknown, nonce = '0x01'): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      payload: {
        signature: SIG,
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: '1000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: nonceHex(nonce),
        },
      },
    }),
  ).toString('base64');
}

const fetchMock = vi.fn();
function gatewayOk(): void {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.endsWith('/verify')
        ? { isValid: true, payer: '0xabc' }
        : { success: true, transaction: '4b1d0f8e-uuid', network: 'eip155:5042002', payer: '0xabc' },
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  ledger.record.mockReset();
  kvHold.store.clear();
  kvHold.claimed = 0;
  configHold.arcEnabled = true;
  vi.stubGlobal('fetch', fetchMock);
  gatewayOk();
});

async function challenge(): Promise<{ status: number; v1: { accepts: unknown[] }; v2: { accepts: unknown[] } }> {
  const res = await handleVanillaPaidGet(new Request(RESOURCE.resourceUrl), RESOURCE, () =>
    NextResponse.json({ ok: true }),
  );
  const v1 = (await res.json()) as { accepts: unknown[] };
  const v2 = JSON.parse(
    Buffer.from(res.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8'),
  ) as { accepts: unknown[] };
  return { status: res.status, v1, v2 };
}

async function pay(accepted: unknown, nonce?: string): Promise<Response> {
  return handleVanillaPaidGet(
    new Request(RESOURCE.resourceUrl, { headers: { 'PAYMENT-SIGNATURE': v2Header(accepted, nonce) } }),
    RESOURCE,
    () => NextResponse.json({ ok: true }),
  );
}

describe('vanillaGate Arc rail (Circle Gateway)', () => {
  it('flag ON: v2 accepts は [Base, Arc]・v1 body は Base 1 件のまま', async () => {
    const { status, v1, v2 } = await challenge();
    expect(status).toBe(402);
    expect(v1.accepts).toHaveLength(1);
    expect((v1.accepts[0] as { network: string }).network).toBe('base-sepolia');
    expect(v2.accepts).toEqual([BASE_ACCEPT, ARC_ACCEPT]);
  });

  it('flag OFF: v2 accepts は Base だけ (従来と同一)', async () => {
    configHold.arcEnabled = false;
    const { v1, v2 } = await challenge();
    expect(v1.accepts).toHaveLength(1);
    expect(v2.accepts).toEqual([BASE_ACCEPT]);
  });

  it('Arc accepted → Gateway URL へ認証なし v2 wire で verify → settle・Base facilitator は呼ばれない', async () => {
    const res = await pay(ARC_ACCEPT);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway-api-testnet.circle.com/v1/x402/verify');
    expect(fetchMock.mock.calls[1][0]).toBe('https://gateway-api-testnet.circle.com/v1/x402/settle');
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { headers: Record<string, string>; body: string };
      expect(init.headers.authorization).toBeUndefined();
      const body = JSON.parse(init.body);
      expect(body.x402Version).toBe(2);
      expect(body.paymentRequirements).toEqual(ARC_ACCEPT);
      expect(body.paymentPayload.accepted).toEqual(ARC_ACCEPT);
      expect(body.paymentPayload.payload.signature).toBe(SIG);
      expect(body.paymentPayload.resource.url).toBe(RESOURCE.resourceUrl);
      // Bazaar 拡張は CDP 専用・Gateway には載せない
      expect(body.paymentPayload.extensions).toBeUndefined();
    }
    // 応答: Gateway の transaction UUID と CAIP-2 network
    const pr = JSON.parse(Buffer.from(res.headers.get('PAYMENT-RESPONSE')!, 'base64').toString('utf8'));
    expect(pr).toEqual({ success: true, transaction: '4b1d0f8e-uuid', network: 'eip155:5042002', payer: '0xabc' });
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][0]).toMatchObject({
      source: 'usdc-vanilla',
      network: 'eip155:5042002',
      payTo: PAY_TO,
      amount: '0.001',
      asset: 'USDC',
      tx: '4b1d0f8e-uuid',
    });
  });

  it('Base accepted は従来どおり payai へ v1 wire (Arc 有効でも不変)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ isValid: true, payer: '0xabc', success: true, transaction: '0xtx' }),
    });
    const res = await pay(BASE_ACCEPT);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://facilitator.payai.network/verify');
    expect(fetchMock.mock.calls[1][0]).toBe('https://facilitator.payai.network/settle');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.x402Version).toBe(1);
    expect(body.paymentPayload.network).toBe('base-sepolia');
    expect(ledger.record.mock.calls[0][0]).toMatchObject({ network: 'base-sepolia', tx: '0xtx' });
  });

  it('flag OFF で Arc accepted を投げても照合されず 402 (invalid_payment_payload)・facilitator 未呼出', async () => {
    configHold.arcEnabled = false;
    const res = await pay(ARC_ACCEPT);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('invalid_payment_payload');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Gateway verify isValid:false → 402 に reason 透過・settle なし・台帳なし', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ isValid: false, invalidReason: 'wallet_not_found', payer: '0xabc' }),
    });
    const res = await pay(ARC_ACCEPT);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('wallet_not_found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('Gateway settle success:false (insufficient_balance) → 402・claim は戻る (同じ支払いで再挑戦できる)', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/verify')
          ? { isValid: true, payer: '0xabc' }
          : { success: false, errorReason: 'insufficient_balance', transaction: '', network: 'eip155:5042002' },
    }));
    const res = await pay(ARC_ACCEPT, '0x77');
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('insufficient_balance');
    // claim は張られてから戻された (KV を素通りしたのではない)
    expect(kvHold.claimed).toBeGreaterThan(0);
    expect(kvHold.store.size).toBe(0);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('Gateway 4xx + 判定 body は結果として扱う (400 {isValid:false})', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ isValid: false, invalidReason: 'invalid_signature' }),
    });
    const res = await pay(ARC_ACCEPT);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('invalid_signature');
  });

  it('Gateway 5xx → 503 payment_facility_unavailable (課金なし)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) });
    const res = await pay(ARC_ACCEPT);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('payment_facility_unavailable');
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('同じ authorization を別 resource へ同時再利用 → 2 本目は 409 (claim は Arc でも効く)', async () => {
    const other = { ...RESOURCE, resourceUrl: 'https://open-pay.jp/api/paid/usdc/stores' };
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/verify')
          ? { isValid: true, payer: '0xabc' }
          : new Promise(() => {}),
    }));
    const first = pay(ARC_ACCEPT, '0x99');
    await new Promise((r) => setTimeout(r, 10));
    const second = await handleVanillaPaidGet(
      new Request(other.resourceUrl, { headers: { 'PAYMENT-SIGNATURE': v2Header({ ...ARC_ACCEPT }, '0x99') } }),
      other,
      () => NextResponse.json({ ok: true }),
    );
    expect(second.status).toBe(409);
    expect(kvHold.claimed).toBe(1);
    void first;
  });
});
