// facilitator /settle の IP rate limit の枠: hosted paid route が同じプロセスから直接呼ぶ settle (印付きの Request) は
// 買い手の IP の別の枠 (hosted-settle) で数え、外から /api/facilitator/settle を叩く経路は従来どおり relay-admission。
// 買い手が relay-admission (/api/relay/jpyc 等と共有) を先に使い切って settle を ip_rate_limited (broadcast 前の拒否
// = failed_prebroadcast) にし、限定在庫の押さえを支払わずに残す手を断つ (lib/x402/hostedSettleRequest.ts)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

const h = vi.hoisted(() => ({ limited: new Set<string>(), calls: [] as { scope: string; ip: string | null; max: number; windowSec: number }[] }));

vi.mock('@/lib/relay/relayGuards', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/relay/relayGuards')>(),
  checkIpRateLimit: async (scope: string, ip: string | null, max: number, windowSec: number) => {
    h.calls.push({ scope, ip, max, windowSec });
    return !h.limited.has(scope);
  },
}));
vi.mock('@/lib/x402/purchaseSettleGate', () => ({ checkHostedIntentSettleAdmission: vi.fn(async () => 'allow') }));
vi.mock('@/lib/relay/forwarderSettleService', () => ({
  settleViaForwarder: vi.fn(async () => ({ kind: 'rejected', reason: 'sig_invalid', httpStatus: 400 })),
}));
vi.mock('@/lib/x402/facilitatorReservation', () => ({ consumeFacilitatorPayment: vi.fn(async () => ({ status: 'unavailable' })) }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const HEADERS = { 'content-type': 'application/json', 'x-vercel-forwarded-for': '172.71.0.1', 'cf-connecting-ip': '203.0.113.5' };

async function load() {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'dummy');
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'sp_dummy');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://dummy@o0.ingest.sentry.io/0');
  vi.stubEnv('RELAYER_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', FORWARDER);
  vi.stubEnv('RELAY_MAX_GAS_COST_WEI', (10n ** 18n).toString());
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example');
  vi.stubEnv('KV_REST_API_TOKEN', 'tok');
  vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
  vi.resetModules();
  // route と同じ module registry の印を使う (resetModules の後に両方を読み込む)。
  const route = await import('@/app/api/facilitator/settle/route');
  const marker = await import('@/lib/x402/hostedSettleRequest');
  return { settle: route.POST as (req: Request) => Promise<Response>, ...marker };
}
const req = (headers: Record<string, string> = HEADERS) => new Request('https://open-pay.jp/api/facilitator/settle', { method: 'POST', headers, body: '{}' });

beforeEach(() => { h.limited.clear(); h.calls = []; });
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('facilitator /settle IP rate limit bucket', () => {
  it('an external request keeps the shared relay-admission bucket (120/min) even with spoofed internal-looking headers', async () => {
    const { settle } = await load();
    await settle(req({ ...HEADERS, 'x-openpay-hosted-settle': '1', 'x-internal': 'hosted-settle' }));
    expect(h.calls).toEqual([{ scope: 'relay-admission', ip: expect.any(String), max: 120, windowSec: 60 }]);
  });

  it('the hosted route\'s in-process request uses the hosted-settle bucket for the same buyer IP', async () => {
    const { settle, markHostedSettleRequest } = await load();
    await settle(req());
    await settle(markHostedSettleRequest(req()));
    expect(h.calls.map((c) => c.scope)).toEqual(['relay-admission', 'hosted-settle']);
    // 数える IP (買い手) と上限は同じ。枠だけが別。
    expect(h.calls[1]).toEqual({ ...h.calls[0], scope: 'hosted-settle' });
    expect(h.calls[0]!.ip).not.toBeNull();
  });

  it('an exhausted relay-admission bucket no longer turns the hosted settle into ip_rate_limited', async () => {
    const { settle, markHostedSettleRequest } = await load();
    h.limited.add('relay-admission');
    const external = await settle(req());
    expect(external.status).toBe(429);
    expect(await external.json()).toEqual({ error: 'ip_rate_limited' });
    const hosted = await settle(markHostedSettleRequest(req()));
    expect(hosted.status).not.toBe(429);
    // hosted-settle の枠を使い切れば従来と同じ 429 (この枠も上限は残る)。
    h.limited.add('hosted-settle');
    expect((await settle(markHostedSettleRequest(req()))).status).toBe(429);
  });

  it('the marker is the Request object itself: a copy (clone or new Request from it) is not marked', async () => {
    const { markHostedSettleRequest, isHostedSettleRequest } = await load();
    const marked = markHostedSettleRequest(req());
    expect(isHostedSettleRequest(marked)).toBe(true);
    expect(isHostedSettleRequest(marked.clone())).toBe(false);
    expect(isHostedSettleRequest(new Request(marked))).toBe(false);
    expect(isHostedSettleRequest(req())).toBe(false);
  });
});
