// A7: recover (forwarder.settle) の **入口跨ぎ**冪等フェンス。
//
// recover の nonce は buildForwarderNonce による決定論的コミットメントなので「同 nonce = 同一支払い」。
// 決済 relay (/api/relay/jpyc) と x402 facilitator (/api/facilitator/settle) は route 別の
// idempotency prefix しか持たないため、同じ署名済 authorization を両入口へ投げると 2 本 broadcast
// されうる (2 本目は on-chain の authorizationState で revert → client の送信ラッチが解けて standard
// 再送を誘発する窓)。共有 claim (relay:recover:idem:) が入るとどちらの順序でも broadcast は 1 本だけ。
//
// 外すのは KV / on-chain I/O / broadcast (selfHostRelayer) のみ。route → forwarderSettleService →
// recoverViaForwarder → relayGuards は実物を走らせる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const AMOY = 80002;
const CUSTOMER_PK = `0x${'3'.repeat(64)}` as Hex;
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0xdead000000000000000000000000000000001234');
const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const INTENT_SALT = `0x${'77'.repeat(32)}` as Hex;
const JPY = 10n ** 18n;

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  delete process.env.GELATO_SPONSOR_API_KEY;
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY =
    '0x752b7aad0089286eb7b553d84d05233d80c9fcb4';
  process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
    '0xdead000000000000000000000000000000001234';
  // 両入口が同じ feeValue (= 2 JPYC のフロア) を期待するよう率を 0 に揃える
  // (x402=max(floor, price×bps) / recover(customer)=floor)。
  process.env.X402_FEE_BPS = '0';
  process.env.X402_FEE_FLOOR_JPYC = '2';
});

const io = vi.hoisted(() => ({ submits: [] as Hex[] }));

// broadcast は数えるだけ (実 RPC は張らない)。
vi.mock('@/lib/relay/selfHostRelayer', () => ({
  submitSelfHost: vi.fn(async (_io: unknown, target: Address) => {
    io.submits.push(target as Hex);
    return { taskId: TX_HASH };
  }),
  pollSelfHost: vi.fn(async () => ({
    state: 'success' as const,
    txHash: TX_HASH,
  })),
}));

// forwarder 健全性は on-chain 読みなので固定 (本テストの対象外)。
vi.mock('@/lib/relay/forwarderHealth', () => ({
  verifyForwarderHealth: vi.fn(async () => null),
}));

// viem clients の I/O のみ固定 (署名 recover / nonce 計算は実物)。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === 'balanceOf') return 10_000n * JPY;
        if (args.functionName === 'authorizationState') return false;
        return 0n;
      },
      getBalance: async () => 10n ** 18n,
    }),
    createWalletClient: () => ({}),
  };
});

const kv = vi.hoisted(() => {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const counters = new Map<string, number>();
  return { values, lists, counters, setKeys: [] as string[] };
});

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: async (key: string) => ({
    ok: true as const,
    value: kv.values.get(key) ?? null,
  }),
  kvSet: async (
    key: string,
    value: string,
    opts: { nx?: boolean; ttlSec?: number } = {},
  ) => {
    kv.setKeys.push(key);
    if (opts.nx && kv.values.has(key)) return { ok: true as const, value: null };
    kv.values.set(key, value);
    return { ok: true as const, value: 'OK' as const };
  },
  kvDel: async (key: string) => ({
    ok: true as const,
    value: kv.values.delete(key) ? 1 : 0,
  }),
  kvLpush: async (key: string, value: string) => {
    const list = kv.lists.get(key) ?? [];
    list.unshift(value);
    kv.lists.set(key, list);
    return { ok: true as const, value: list.length };
  },
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true as const,
    value: (kv.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvLtrim: async () => ({ ok: true as const, value: 'OK' as const }),
  kvIncr: async (key: string) => {
    const value = (kv.counters.get(key) ?? 0) + 1;
    kv.counters.set(key, value);
    return { ok: true as const, value };
  },
  kvDecr: async (key: string) => {
    const value = (kv.counters.get(key) ?? 0) - 1;
    kv.counters.set(key, value);
    return { ok: true as const, value };
  },
  kvExpire: async () => ({ ok: true as const, value: 1 }),
  kvEval: async () => ({ ok: true as const, value: null }),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableJpycEip3009: true,
      enableX402Facilitator: true,
      feeReceiver: '0xdead000000000000000000000000000000001234',
      feeReceiverConfigured: true,
      enableUsageFee: false,
      enableMobileOrderFee: false,
      enablePushNotify: false,
      enableTipMessage: false,
      recoverFeeBps: 0,
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  recordMetric: vi.fn(async () => undefined),
  recordMetricAfterResponse: vi.fn(),
}));
vi.mock('@/lib/x402/registry', () => ({ recordSettlement: vi.fn(async () => undefined) }));
vi.mock('@/lib/x402/receipt', () => ({
  makeSettlementReceipt: vi.fn(() => ({})),
  signReceipt: vi.fn(async () => null),
}));
vi.mock('@/lib/x402/facilitatorReservation', () => ({
  consumeFacilitatorPayment: vi.fn(async () => ({ status: 'unavailable' })),
}));
vi.mock('@/lib/x402/purchaseSettleGate', () => ({
  checkHostedIntentSettleAdmission: vi.fn(async () => 'allow'),
}));

import { POST as relayPost } from '@/app/api/relay/jpyc/route';
import { POST as facilitatorPost } from '@/app/api/facilitator/settle/route';
import {
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { jpycAddressFor } from '@/lib/relay/relayProvider';
import { SHARED_RECOVER_IDEM_PREFIX } from '@/lib/relay/relayGuards';

const customer = privateKeyToAccount(CUSTOMER_PK);

function makeParams(): ForwarderSettleParams {
  return {
    from: getAddress(customer.address),
    merchant: MERCHANT,
    merchantValue: 1_000n * JPY,
    feeReceiver: FEE_RECEIVER,
    feeValue: 2n * JPY, // 両入口の期待フロア (recover gas floor = x402 floor = 2 JPYC)
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
    intentSalt: INTENT_SALT,
  };
}

async function signParams(params: ForwarderSettleParams): Promise<Hex> {
  const jpyc = jpycAddressFor(AMOY);
  if (!jpyc) throw new Error('JPYC address unresolved for Amoy');
  return customer.signTypedData(
    buildReceiveWithAuthorizationTypedData(params, AMOY, jpyc, FORWARDER),
  );
}

function relayRequest(params: ForwarderSettleParams, signature: Hex): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: AMOY,
      from: params.from,
      merchant: params.merchant,
      merchantValue: params.merchantValue.toString(),
      feeValue: params.feeValue.toString(),
      validAfter: params.validAfter.toString(),
      validBefore: params.validBefore.toString(),
      intentSalt: params.intentSalt,
      signature,
    }),
  });
}

function facilitatorRequest(
  params: ForwarderSettleParams,
  signature: Hex,
): Request {
  return new Request('http://localhost/api/facilitator/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      x402Version: 1,
      paymentPayload: {
        x402Version: 1,
        scheme: 'exact',
        network: `eip155:${AMOY}`,
        payload: {
          signature,
          authorization: {
            from: params.from,
            validAfter: params.validAfter.toString(),
            validBefore: params.validBefore.toString(),
            intentSalt: params.intentSalt,
          },
        },
      },
      paymentRequirements: {
        scheme: 'exact',
        network: `eip155:${AMOY}`,
        maxAmountRequired: (params.merchantValue + params.feeValue).toString(),
        resource: 'https://open-pay.jp/api/paid/x',
        description: 'x',
        mimeType: '',
        payTo: FORWARDER,
        maxTimeoutSeconds: 600,
        asset: jpycAddressFor(AMOY),
        extra: {
          openpay: {
            merchant: params.merchant,
            merchantValue: params.merchantValue.toString(),
            feeReceiver: params.feeReceiver,
            feeValue: params.feeValue.toString(),
          },
        },
      },
    }),
  });
}

beforeEach(() => {
  kv.values.clear();
  kv.lists.clear();
  kv.counters.clear();
  kv.setKeys.length = 0;
  io.submits.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recover authorization を両入口へ POST しても broadcast は 1 本 (A7)', () => {
  it('決済 relay が先に broadcast → facilitator は 202 pending で再 broadcast しない', async () => {
    const params = makeParams();
    const signature = await signParams(params);

    const first = await relayPost(relayRequest(params, signature));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, txHash: TX_HASH });
    expect(io.submits).toHaveLength(1);

    const second = await facilitatorPost(facilitatorRequest(params, signature));
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      success: false,
      errorReason: 'pending',
      transaction: TX_HASH,
    });
    // 2 本目は broadcast されない (共有 claim が止めた)。
    expect(io.submits).toHaveLength(1);
  });

  it('facilitator が先に broadcast → 決済 relay は 202 pending で再 broadcast しない', async () => {
    const params = makeParams();
    const signature = await signParams(params);

    const first = await facilitatorPost(facilitatorRequest(params, signature));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      success: true,
      transaction: TX_HASH,
    });
    expect(io.submits).toHaveLength(1);

    const second = await relayPost(relayRequest(params, signature));
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({
      ok: false,
      pending: true,
      txHash: TX_HASH,
    });
    expect(io.submits).toHaveLength(1);
  });

  it('共有 claim key は relay:recover:idem:<chainId>:<from>:<nonce>', async () => {
    const params = makeParams();
    const signature = await signParams(params);
    await relayPost(relayRequest(params, signature));

    const nonce = buildForwarderNonce(params, AMOY, FORWARDER);
    const sharedKey = `${SHARED_RECOVER_IDEM_PREFIX}${AMOY}:${params.from.toLowerCase()}:${nonce.toLowerCase()}`;
    expect(kv.values.get(sharedKey)).toBe(TX_HASH);
    // route 別 claim も従来どおり残っている (共有 claim は重ねただけ)。
    expect(
      kv.values.has(
        `relay:idem:${AMOY}:${params.from.toLowerCase()}:${nonce.toLowerCase()}`,
      ),
    ).toBe(true);
  });

  it('別 nonce (別 intentSalt) の支払いは共有 claim に阻まれず broadcast される', async () => {
    const first = makeParams();
    await relayPost(relayRequest(first, await signParams(first)));
    expect(io.submits).toHaveLength(1);

    const other: ForwarderSettleParams = {
      ...first,
      intentSalt: `0x${'88'.repeat(32)}` as Hex,
    };
    const res = await facilitatorPost(
      facilitatorRequest(other, await signParams(other)),
    );
    expect(res.status).toBe(200);
    expect(io.submits).toHaveLength(2);
  });
});
