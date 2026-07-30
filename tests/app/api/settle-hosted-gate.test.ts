// creator-store v4 契約 A の route 配線フェンス: 両 settle 入口 (facilitator /settle・
// recover relay) が hosted intent gate の denied/storage を broadcast **前** に返すこと。
// gate 本体の判定は tests/lib/x402/purchaseSettleGate.test.ts (実導出) が担う —
// ここでは gate を mock し「配線が存在し、broadcast へ到達しない」ことだけを固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

const h = vi.hoisted(() => ({
  admission: 'allow' as 'allow' | 'denied' | 'storage',
  gate: vi.fn(),
  settleViaForwarder: vi.fn(),
}));

vi.mock('@/lib/x402/purchaseSettleGate', () => ({
  checkHostedIntentSettleAdmission: h.gate,
}));

vi.mock('@/lib/relay/forwarderSettleService', () => ({
  settleViaForwarder: h.settleViaForwarder,
}));

vi.mock('@/lib/x402/facilitatorReservation', () => ({
  consumeFacilitatorPayment: vi.fn(async () => ({ status: 'unavailable' })),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const JPY = 10n ** 18n;
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const CUSTOMER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const JPYC_POLY = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');

function facilitatorBody(): Record<string, unknown> {
  return {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:137',
      payload: {
        signature: `0x${'11'.repeat(65)}`,
        authorization: {
          from: CUSTOMER,
          validAfter: '0',
          validBefore: '99999999999',
          intentSalt: `0x${'22'.repeat(32)}`,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'eip155:137',
      maxAmountRequired: (1010n * JPY).toString(),
      resource: 'https://api.example.jp/paid/x',
      description: 't',
      mimeType: '',
      payTo: FORWARDER,
      maxTimeoutSeconds: 600,
      asset: JPYC_POLY,
      extra: {
        openpay: {
          merchant: MERCHANT,
          merchantValue: (1000n * JPY).toString(),
          feeReceiver: FEE_RECEIVER,
          feeValue: (10n * JPY).toString(),
        },
      },
    },
  };
}

async function loadFacilitatorSettle(): Promise<
  (req: Request) => Promise<Response>
> {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'dummy');
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'sp_dummy');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://dummy@o0.ingest.sentry.io/0');
  vi.stubEnv('RELAYER_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', FORWARDER);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  vi.stubEnv('RELAY_MAX_GAS_COST_WEI', (10n ** 18n).toString());
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example');
  vi.stubEnv('KV_REST_API_TOKEN', 'tok');
  vi.resetModules();
  const mod = await import('@/app/api/facilitator/settle/route');
  return mod.POST as (req: Request) => Promise<Response>;
}

beforeEach(() => {
  h.admission = 'allow';
  h.gate.mockReset();
  h.gate.mockImplementation(async () => h.admission);
  h.settleViaForwarder.mockReset();
  h.settleViaForwarder.mockResolvedValue({
    kind: 'rejected',
    reason: 'sig_invalid',
    httpStatus: 400,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('facilitator /settle の hosted intent gate 配線', () => {
  it('denied は 409 hosted_intent_required で broadcast へ到達しない', async () => {
    h.admission = 'denied';
    const settle = await loadFacilitatorSettle();
    const res = await settle(
      new Request('http://x/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(facilitatorBody()),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'hosted_intent_required',
    });
    expect(h.settleViaForwarder).not.toHaveBeenCalled();
    expect(h.gate).toHaveBeenCalledTimes(1);
  });

  it('storage は fail-closed の 503 で broadcast へ到達しない', async () => {
    h.admission = 'storage';
    const settle = await loadFacilitatorSettle();
    const res = await settle(
      new Request('http://x/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(facilitatorBody()),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'storage_unavailable',
    });
    expect(h.settleViaForwarder).not.toHaveBeenCalled();
  });

  it('allow は従来どおり settleViaForwarder へ到達する', async () => {
    const settle = await loadFacilitatorSettle();
    const res = await settle(
      new Request('http://x/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(facilitatorBody()),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.settleViaForwarder).toHaveBeenCalledTimes(1);
    // gate は broadcast より前に params/chainId/署名で呼ばれている。
    const arg = h.gate.mock.calls[0]![0] as {
      chainId: number;
      params: { intentSalt: string };
      signature: unknown;
    };
    expect(arg.chainId).toBe(137);
    expect(arg.params.intentSalt).toBe(`0x${'22'.repeat(32)}`);
    expect(arg.signature).toBe(`0x${'11'.repeat(65)}`);
  });
});
