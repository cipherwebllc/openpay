// 売上の移動の route (app/api/relay/jpyc/move) の入口と配線 (plans/store-sales-move.md §2.1・P1)。
//   - flag OFF は 404 で、admission にも settle にも触れない (完全 inert)
//   - チェーンは 137 / 80002 だけ・mainnet の gas_ceiling_required / kv_required・forwarder 未設定は 503
//   - 送り先の拒否 (送り元と同じ・relayer・JPYC の token) と最低額 (1 JPYC) は、hosted gate・settle より前の 400
//   - hosted intent の gate (denied 409 / storage 503) は broadcast (settleViaForwarder) より前
//   - settleViaForwarder へ渡す値: 利用料 = relayGasFeeValue(chainId) (gasMode・feeKind を読まない)・冪等は relay:idem:・
//     払い元の rate limit は from・forwarder は jpycForwarderFor・feeReceiver は server 権威
//   - 成功だけ sales_move を数え、送り元の数の集計を予約する。push・チップのメッセージ・1% 回避の集計は呼ばない
// settleViaForwarder の中身 (利用料の照合・境界・署名・冪等・予算) は境界モックし、実物を通す検証は
// relay-move-e2e.test.ts が持つ。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';

type SettleInput = {
  chainId: number;
  params: {
    from: Address;
    merchant: Address;
    merchantValue: bigint;
    feeReceiver: Address;
    feeValue: bigint;
  };
  signature: Hex;
  rateLimitKeys: string[];
  expectedFeeValue: bigint;
  callerFeeFloorValue: bigint;
  forwarderFor: (chainId: number) => Address | null;
  idemPrefix: string;
};

const JPYC = 10n ** 18n;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;

const h = vi.hoisted(() => ({
  enableSalesMove: true,
  enableJpycEip3009: true,
  provider: 'self-host' as 'self-host' | 'gelato' | null,
  kvConfigured: true,
  gasCeiling: 1n,
  // 値は beforeEach で入れる (checksum 形)。
  forwarder: null as string | null,
  feeReceiver: null as string | null,
  relayer: '',
  jpyc: null as string | null,
  limiter: vi.fn(async (..._args: unknown[]) => true),
  gate: vi.fn(async (..._args: unknown[]) => 'allow' as 'allow' | 'denied' | 'storage'),
  settle: vi.fn(),
  metric: vi.fn(),
  abuse: vi.fn(),
  push: vi.fn(),
  tipStore: vi.fn(),
  avoidance: vi.fn(),
  relayFee: vi.fn((chainId: number) => (chainId === 137 ? 3n : 2n) * 10n ** 18n),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableSalesMove() {
        return h.enableSalesMove;
      },
      get enableJpycEip3009() {
        return h.enableJpycEip3009;
      },
      // 決済の経路なら push・チップのメッセージ・モバイル注文の利用料が動く設定にしておき、この route が呼ばないことを見る。
      enablePushNotify: true,
      enableTipMessage: true,
      enableMobileOrderFee: true,
    },
  };
});
vi.mock('@/lib/relay/relayProvider', () => ({
  get PROVIDER() {
    return h.provider;
  },
  MAINNET_CHAINS: new Set([137, 8217, 43114]),
  get RELAYER_ADDRESS() {
    return h.provider === 'self-host' ? h.relayer : null;
  },
  jpycAddressFor: () => h.jpyc,
  relayMaxGasCostWei: () => h.gasCeiling,
}));
vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: vi.fn(() => h.forwarder),
  relayGasFeeValue: (chainId: number) => h.relayFee(chainId),
}));
vi.mock('@/lib/relay/forwarderSettleService', () => ({
  settleViaForwarder: (input: SettleInput) => h.settle(input),
  feeReceiverFor: () => h.feeReceiver,
}));
vi.mock('@/lib/x402/purchaseSettleGate', () => ({
  checkHostedIntentSettleAdmission: (input: unknown) => h.gate(input),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: (...args: unknown[]) => h.limiter(...args),
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => h.kvConfigured,
}));
vi.mock('@/lib/metrics', () => ({
  recordMetricAfterResponse: (kind: string) => h.metric(kind),
}));
vi.mock('@/lib/relay/salesMoveAbuse', () => ({
  recordSalesMoveSenderAfterResponse: (input: unknown) => h.abuse(input),
}));
// 決済・チップの後処理。この route の import graph から呼ばれないことを見るために spy にしておく。
vi.mock('@/lib/push/notify', () => ({
  notifyPaymentReceived: (...args: unknown[]) => h.push(...args),
}));
vi.mock('@/lib/tipMessages', () => ({
  sanitizeTipMessage: (v: unknown) => v,
  storeTipMessage: (...args: unknown[]) => h.tipStore(...args),
  TIP_MESSAGE_MIN_AMOUNT_WEI: 0n,
}));
vi.mock('@/lib/relay/recoverFeeAvoidance', () => ({
  recordRecoverFeeAvoidanceAfterResponse: (...args: unknown[]) => h.avoidance(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/relay/jpyc/move/route';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { logger } from '@/lib/logger';

const AMOY = 80002;
const POLYGON = 137;
const FROM = getAddress('0x0000000000000000000000000000000000000def');
const DEST = getAddress('0x000000000000000000000000000000000000d357');

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: AMOY,
    from: FROM,
    merchant: DEST,
    merchantValue: (1_000n * JPYC).toString(),
    feeValue: (2n * JPYC).toString(),
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    intentSalt: `0x${'22'.repeat(32)}`,
    signature: `0x${'b'.repeat(130)}`,
    ...over,
  };
}

function post(over: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new Request('http://localhost/api/relay/jpyc/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(over)),
    }),
  );
}

function rawPost(text: string): Promise<Response> {
  return POST(
    new Request('http://localhost/api/relay/jpyc/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    }),
  );
}

const settleInput = (): SettleInput => h.settle.mock.calls[0]![0] as SettleInput;

function expectNothingDownstream(): void {
  expect(h.gate).not.toHaveBeenCalled();
  expect(h.settle).not.toHaveBeenCalled();
  expect(h.metric).not.toHaveBeenCalled();
  expect(h.abuse).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.enableSalesMove = true;
  h.enableJpycEip3009 = true;
  h.provider = 'self-host';
  h.kvConfigured = true;
  h.gasCeiling = 1n;
  h.forwarder = getAddress('0x00000000000000000000000000000000000f0fa0');
  h.feeReceiver = getAddress('0x0000000000000000000000000000000000000fee');
  h.relayer = getAddress('0x00000000000000000000000000000000000beef7');
  h.jpyc = '0x0000000000000000000000000000000000000abc';
  h.limiter.mockResolvedValue(true);
  h.gate.mockResolvedValue('allow');
  h.settle.mockReset();
  h.settle.mockResolvedValue({ kind: 'success', txHash: TX_HASH });
});

describe('flag と構成', () => {
  it('flag OFF は 404 not_found で、admission・hosted gate・settle・記録に一切触れない (完全 inert)', async () => {
    h.enableSalesMove = false;
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
    expect(h.limiter).not.toHaveBeenCalled();
    expectNothingDownstream();
  });

  it('relay の flag OFF / provider 未構成は 503 relay_not_configured (既存 relay と同じ応答)', async () => {
    h.enableJpycEip3009 = false;
    let res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });

    h.enableJpycEip3009 = true;
    h.provider = null;
    res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
    expect(h.limiter).not.toHaveBeenCalled();
    expectNothingDownstream();
  });

  it('Gelato (self-host でない) は forwarder.settle を送れないので 503 relay_not_configured', async () => {
    h.provider = 'gelato';
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
    expectNothingDownstream();
  });

  it('forwarder 未設定 (a1 利用料が ON で実効 null を含む) は 503 relay_not_configured', async () => {
    h.forwarder = null;
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
    expect(vi.mocked(jpycForwarderFor)).toHaveBeenCalledWith(AMOY);
    expectNothingDownstream();
  });

  it('feeReceiver 未設定は 503 relay_not_configured', async () => {
    h.feeReceiver = null;
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
    expectNothingDownstream();
  });
});

describe('admission と body', () => {
  it('admission は既存 relay と同じ枠 (relay-admission・120 / 60 秒)。超えたら 429 で署名検証より前に止まる', async () => {
    h.limiter.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: 'ip_rate_limited' });
    expect(h.limiter).toHaveBeenCalledTimes(1);
    // IP_HASH_SECRET の無いテストでは bucket は null (limiter は skip)。bucket の導出は money-ip-buckets.test.ts が見る。
    expect(h.limiter.mock.calls[0]).toEqual(['relay-admission', null, 120, 60]);
    expectNothingDownstream();
  });

  it('JSON でない・object でない・欄の不足・大きすぎる body は既存 relay と同じ 400 / 413', async () => {
    let res = await rawPost('{');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });

    res = await rawPost('null');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });

    res = await post({ chainId: '80002' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });

    for (const over of [
      { from: 'nope' },
      { merchant: undefined },
      { merchantValue: '1.5' },
      { feeValue: undefined },
      { intentSalt: '0x1234' },
      { signature: 'zz' },
    ]) {
      res = await post(over);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });
    }

    res = await rawPost(JSON.stringify({ ...body(), pad: 'x'.repeat(5_000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'payload_too_large' });
    expectNothingDownstream();
  });
});

describe('チェーン', () => {
  it.each([
    ['Kaia', 8217],
    ['Kairos', 1001],
    ['Avalanche', 43114],
    ['Ethereum', 1],
    ['Base', 8453],
  ])('%s (%i) は 400 unsupported_chain (Polygon の JPYC だけ)', async (_name, chainId) => {
    const res = await post({ chainId });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'unsupported_chain' });
    expectNothingDownstream();
  });

  it.each([POLYGON, AMOY])('%i は通り、利用料は relayGasFeeValue(chainId) (chain 別)', async (chainId) => {
    const fee = h.relayFee(chainId);
    const res = await post({ chainId, feeValue: fee.toString() });
    expect(res.status).toBe(200);
    expect(settleInput().chainId).toBe(chainId);
    expect(settleInput().expectedFeeValue).toBe(fee);
    expect(settleInput().callerFeeFloorValue).toBe(fee);
  });

  it('mainnet (137) は gas の上限が無ければ 503 gas_ceiling_required (logger.error)', async () => {
    h.gasCeiling = 0n;
    const res = await post({ chainId: POLYGON });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'gas_ceiling_required' });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('relay.jpyc.move.gas_ceiling_required', { chainId: POLYGON });
    expectNothingDownstream();
  });

  it('mainnet (137) は KV が無ければ 503 kv_required (冪等の fail-open を塞ぐ)', async () => {
    h.kvConfigured = false;
    const res = await post({ chainId: POLYGON });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_required' });
    expectNothingDownstream();
  });

  it('testnet (80002) は gas の上限・KV が無くても従来どおり通す (既存 relay と同じ緩さ)', async () => {
    h.gasCeiling = 0n;
    h.kvConfigured = false;
    const res = await post({ chainId: AMOY });
    expect(res.status).toBe(200);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
});

describe('最低額と送り先の拒否 (hosted gate・settle より前)', () => {
  it('移す額 1 JPYC 未満は 400 amount_below_minimum・ちょうど 1 JPYC は通る', async () => {
    let res = await post({ merchantValue: (JPYC - 1n).toString() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'amount_below_minimum' });
    expectNothingDownstream();

    res = await post({ merchantValue: '0' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'amount_below_minimum' });
    expectNothingDownstream();

    res = await post({ merchantValue: JPYC.toString() });
    expect(res.status).toBe(200);
    expect(settleInput().params.merchantValue).toBe(JPYC);
  });

  it('送り元と同じ送り先は 400 merchant_is_sender (大文字小文字の違いも同じアドレス)', async () => {
    const res = await post({ merchant: FROM.toLowerCase() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'merchant_is_sender' });
    expectNothingDownstream();
  });

  it('relayer 宛ては 400 merchant_is_relayer', async () => {
    const res = await post({ merchant: h.relayer.toLowerCase() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'merchant_is_relayer' });
    expectNothingDownstream();
  });

  it('JPYC の token contract 宛ては 400 merchant_is_token', async () => {
    const res = await post({ merchant: getAddress(h.jpyc!) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'merchant_is_token' });
    expectNothingDownstream();
  });

  it('forwarder・feeReceiver 宛ては route では止めず、共有の verifyForwarderSettle に任せる (settle に届く)', async () => {
    // 拒否のコード (merchant_is_forwarder / merchant_is_fee_receiver) は実物を通す relay-move-e2e.test.ts が見る。
    await post({ merchant: h.forwarder });
    await post({ merchant: h.feeReceiver });
    expect(h.settle).toHaveBeenCalledTimes(2);
  });
});

describe('hosted intent の gate', () => {
  it('denied は 409 hosted_intent_required で broadcast に届かない', async () => {
    h.gate.mockResolvedValue('denied');
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'hosted_intent_required' });
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.metric).not.toHaveBeenCalled();
  });

  it('storage は fail-closed の 503 storage_unavailable で broadcast に届かない', async () => {
    h.gate.mockResolvedValue('storage');
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('allow は settle へ進み、gate には server 権威の params と署名を渡す', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.gate.mock.calls[0]![0]).toEqual({
      chainId: AMOY,
      params: expect.objectContaining({
        from: FROM,
        merchant: DEST,
        feeReceiver: h.feeReceiver,
        intentSalt: `0x${'22'.repeat(32)}`,
      }),
      signature: `0x${'b'.repeat(130)}`,
    });
    expect(h.gate.mock.invocationCallOrder[0]!).toBeLessThan(h.settle.mock.invocationCallOrder[0]!);
  });
});

describe('settleViaForwarder への配線', () => {
  it('冪等は relay:idem: (status が読む)・払い元の rate limit は from・forwarder は jpycForwarderFor・feeReceiver は server 権威', async () => {
    const res = await post({
      from: FROM.toLowerCase(),
      merchant: DEST.toLowerCase(),
      // client が送る feeReceiver は読まない。
      feeReceiver: '0x0000000000000000000000000000000000000bad',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: TX_HASH });
    const input = settleInput();
    expect(input.idemPrefix).toBe('relay:idem:');
    expect(input.rateLimitKeys).toEqual([FROM]);
    expect(input.forwarderFor).toBe(jpycForwarderFor);
    expect(input.params).toEqual({
      from: FROM,
      merchant: DEST,
      merchantValue: 1_000n * JPYC,
      feeReceiver: h.feeReceiver,
      feeValue: 2n * JPYC,
      validAfter: 0n,
      validBefore: expect.any(BigInt),
      intentSalt: `0x${'22'.repeat(32)}`,
    });
    expect(input.signature).toBe(`0x${'b'.repeat(130)}`);
  });

  it('gasMode・feeKind は読まない: merchant / モバイル注文の種別を送っても利用料はいつも floor', async () => {
    await post({ gasMode: 'merchant', feeKind: 'preorder' });
    await post({ gasMode: 'customer', feeKind: 'storefront' });
    expect(h.settle.mock.calls.map(([i]) => (i as SettleInput).expectedFeeValue)).toEqual([
      2n * JPYC,
      2n * JPYC,
    ]);
    // relayGasFeeValue 以外の料率 (recoverFeeValue・mobileOrderFeeValue) はこの route の import graph に無い。
    expect(h.relayFee).toHaveBeenCalledWith(AMOY);
  });
});

describe('記録', () => {
  it('成功は sales_move を 1 回数え、送り先 × 送り元の集計を予約する。push・チップのメッセージ・1% 回避は呼ばない', async () => {
    const res = await post({ tipMessage: 'hello' });
    expect(res.status).toBe(200);
    expect(h.metric.mock.calls).toEqual([['sales_move']]);
    expect(h.abuse.mock.calls).toEqual([[{ chainId: AMOY, destination: DEST, sender: FROM }]]);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.tipStore).not.toHaveBeenCalled();
    expect(h.avoidance).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'rejected', httpStatus: 400, reason: 'fee_value_mismatch' }, 400, { ok: false, error: 'fee_value_mismatch' }],
    [{ kind: 'pending', txHash: TX_HASH }, 202, { ok: false, pending: true, txHash: TX_HASH }],
    [{ kind: 'pending' }, 202, { ok: false, pending: true, txHash: null }],
    [{ kind: 'reverted', txHash: TX_HASH }, 200, { ok: false, reverted: true, txHash: TX_HASH }],
    [{ kind: 'relay_error', detail: 'submit_failed: x' }, 502, { ok: false, error: 'relay_error' }],
  ])('成功でない結果 (%o) は既存 relay と同じ応答で、何も数えない', async (result, status, json) => {
    h.settle.mockResolvedValue(result);
    const res = await post();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(json);
    expect(h.metric).not.toHaveBeenCalled();
    expect(h.abuse).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});
