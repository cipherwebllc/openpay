// 出品の登録 (POST) と変更 (PATCH) が、Arc の受取先の検査 (arcPayToRejection) を保存の前に通すこと。
// 検査の中身は tests/lib/x402/arcPayToReachability.test.ts。ここは route の配線だけを見る。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WALLET = '0x1111111111111111111111111111111111111111';
const h = vi.hoisted(() => ({
  arcPayToRejection: vi.fn(),
  createResource: vi.fn(),
  updateResource: vi.fn(),
  getResource: vi.fn(),
  isFreelyAccessible: vi.fn(),
  input: {} as Record<string, unknown>,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableX402Facilitator: true } };
});
vi.mock('@/lib/net/crossOriginWrite', () => ({ rejectCrossOriginWrite: () => null }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: async () => true }));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '1.1.1.1', hashIpBucket: () => 'bucket' }));
vi.mock('@/lib/siweSession', () => ({
  requireSession: async () => ({ ok: true, address: WALLET }),
}));
vi.mock('@/lib/x402/resourceRequestGuards', () => ({
  checkResourceWalletRateLimit: async () => true,
  RESOURCE_BODY_MAX_BYTES: 16_384,
  RESOURCE_RATE_LIMIT_WINDOW_SEC: 60,
}));
vi.mock('@/lib/httpBodyCap', () => ({ readJsonBodyCapped: async () => ({ ok: true, value: {} }) }));
vi.mock('@/lib/x402/moderation', () => ({ isFreelyAccessible: h.isFreelyAccessible, probeGate: async () => 'openpay' }));
vi.mock('@/lib/x402/arcPayToReachability', () => ({ arcPayToRejection: h.arcPayToRejection }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/x402/registry', () => ({
  MAX_RESOURCES_PER_MERCHANT: 10,
  parseResourceInput: () => ({ ok: true, input: h.input }),
  countMerchantResources: async () => 0,
  listResourcesForMerchant: async () => [],
  createResource: h.createResource,
  updateResource: h.updateResource,
  getResource: h.getResource,
  deactivateResource: vi.fn(),
}));

import { POST } from '@/app/api/facilitator/resources/route';
import { PATCH } from '@/app/api/facilitator/resources/[id]/route';

const USDC_ARC = { payTo: WALLET, priceUsd: '0.01', arc: true };
const req = () => new Request('https://test.local/api/facilitator/resources', { method: 'POST', body: '{}' });

beforeEach(() => {
  vi.clearAllMocks();
  h.input = { url: 'https://seller.example/api', payTo: WALLET, usdc: USDC_ARC };
  h.arcPayToRejection.mockResolvedValue(null);
  h.isFreelyAccessible.mockResolvedValue(false);
  h.createResource.mockResolvedValue({ ok: true, resource: { id: 'r1', url: 'https://seller.example/api', payTo: WALLET } });
  h.updateResource.mockResolvedValue({ ok: true, resource: { id: 'r1', url: 'https://seller.example/api', payTo: WALLET } });
  h.getResource.mockResolvedValue({ id: 'r1', merchant: WALLET, usdc: { payTo: WALLET, priceUsd: '0.01', arc: true } });
});

describe('POST /api/facilitator/resources', () => {
  it('登録内容の USDC 面で検査し、断られたら保存しない', async () => {
    h.arcPayToRejection.mockResolvedValue({ error: 'usdc_arc_contract_pay_to', status: 400 });
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'usdc_arc_contract_pay_to' });
    // 3 つ目は route に入った時刻 (RPC を route の締め切りまでしか待たない)
    expect(h.arcPayToRejection).toHaveBeenCalledWith(USDC_ARC, undefined, expect.any(Number));
    expect(h.createResource).not.toHaveBeenCalled();
  });

  it('RPC 障害の 503 もそのまま返し、保存しない', async () => {
    h.arcPayToRejection.mockResolvedValue({ error: 'usdc_arc_check_unavailable', status: 503 });
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(h.createResource).not.toHaveBeenCalled();
  });

  it('検査は probe と並行に走る (順に待つと route の 15 秒を超えうる)・保存の前に結果を見る', async () => {
    let releaseProbe!: (v: boolean) => void;
    h.isFreelyAccessible.mockImplementation(() => new Promise((resolve) => { releaseProbe = resolve; }));
    let releaseArc!: (v: null) => void;
    h.arcPayToRejection.mockImplementation(() => new Promise((resolve) => { releaseArc = resolve; }));
    const pending = POST(req());
    await vi.waitFor(() => expect(h.isFreelyAccessible).toHaveBeenCalled());
    expect(h.arcPayToRejection).toHaveBeenCalled();
    releaseProbe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.createResource).not.toHaveBeenCalled();
    releaseArc(null);
    expect((await pending).status).toBe(201);
  });

  it('通れば保存する', async () => {
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(h.createResource).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/facilitator/resources/[id]', () => {
  const ctx = { params: Promise.resolve({ id: 'r1' }) };

  it('変更後の USDC 面と、保存済みの USDC 面を渡して検査する (同意済み・同じ受取先は検査側が飛ばす)', async () => {
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.arcPayToRejection).toHaveBeenCalledWith(USDC_ARC, { payTo: WALLET, priceUsd: '0.01', arc: true }, expect.any(Number));
  });

  it('保存済みが読めない (null) ときは前の値なしで検査する', async () => {
    h.getResource.mockResolvedValue(null);
    await PATCH(req(), ctx);
    expect(h.arcPayToRejection).toHaveBeenCalledWith(USDC_ARC, undefined, expect.any(Number));
  });

  it('断られたら更新しない', async () => {
    h.arcPayToRejection.mockResolvedValue({ error: 'usdc_arc_contract_pay_to', status: 400 });
    const res = await PATCH(req(), ctx);
    expect(res.status).toBe(400);
    expect(h.updateResource).not.toHaveBeenCalled();
  });
});
