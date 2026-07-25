import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseSignature,
  serializeCompactSignature,
  signatureToCompactSignature,
} from 'viem';

const kv = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
  setNxGet: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  kvEval: kv.eval,
  kvGet: kv.get,
  kvSetNxGet: kv.setNxGet,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  PAYMENT_REDELIVERY_TTL_SEC,
  claimPaymentRedelivery,
  isFacilitatorPreBroadcastRejection,
  lookupPaymentRedelivery,
  paymentRedeliveryIdentity,
  promotePaymentRedelivery,
  releasePaymentRedelivery,
  type PaymentRedeliveryBinding,
  type PaymentRedeliveryIdentity,
} from '@/lib/x402/paymentRedelivery';

const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const OTHER_RESOURCE = 'https://open-pay.jp/api/paid/stores';
const PAYER = '0x1111111111111111111111111111111111111111';
const SIGNATURE =
  `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b` as const;
const OTHER_SIGNATURE =
  `0x${'0'.repeat(63)}3${'0'.repeat(63)}41c` as const;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BODY = {
  x402Version: 1,
  paymentPayload: { scheme: 'exact' },
  paymentRequirements: { resource: RESOURCE },
};
const BINDING: PaymentRedeliveryBinding = {
  scope: 'first-party',
  resource: RESOURCE,
};

function v1Payload(signature: string = SIGNATURE) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:080002',
    payload: {
      signature,
      authorization: {
        from: PAYER.toUpperCase().replace('0X', '0x'),
        validAfter: '000',
        validBefore: '009999999999',
        intentSalt: `0x${'AB'.repeat(32)}`,
      },
    },
  };
}

function v2Payload(signature: string = SIGNATURE) {
  return {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: 'eip155:80002',
      amount: '3',
      asset: '0x2222222222222222222222222222222222222222',
      payTo: '0x3333333333333333333333333333333333333333',
      maxTimeoutSeconds: 60,
    },
    payload: {
      authorization: {
        intentSalt: `0x${'ab'.repeat(32)}`,
        validBefore: '9999999999',
        validAfter: '0',
        from: PAYER,
      },
      signature,
    },
  };
}

function identity(): PaymentRedeliveryIdentity {
  const result = paymentRedeliveryIdentity(v1Payload());
  if (!result) throw new Error('fixture must produce an identity');
  return result;
}

function pendingRaw(input: {
  identity?: PaymentRedeliveryIdentity;
  binding?: PaymentRedeliveryBinding;
  context?: Record<string, unknown>;
} = {}): string {
  const paymentIdentity = input.identity ?? identity();
  const binding = input.binding ?? BINDING;
  return JSON.stringify({
    version: 1,
    state: 'pending',
    scope: binding.scope,
    resource: binding.resource,
    credential: paymentIdentity.credential,
    facilitatorBody: BODY,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

const settlement = {
  success: true as const,
  transaction: TX_HASH,
  network: 'eip155:80002',
  payer: PAYER,
  receipt: { blockNumber: '123' },
};

beforeEach(() => {
  vi.clearAllMocks();
  kv.get.mockResolvedValue({ ok: true, value: null });
  kv.setNxGet.mockResolvedValue({ ok: true, value: null });
});

describe('paymentRedeliveryIdentity', () => {
  it('v1/v2・decimal/address casing・JSON field order に依存しない主 key と credential を作る', () => {
    const v1Identity = paymentRedeliveryIdentity(v1Payload());
    const reorderedV1 = JSON.parse(
      JSON.stringify(v1Payload(), [
        'payload',
        'authorization',
        'validBefore',
        'from',
        'intentSalt',
        'validAfter',
        'signature',
        'network',
        'scheme',
        'x402Version',
      ]),
    ) as unknown;

    expect(v1Identity).not.toBeNull();
    expect(paymentRedeliveryIdentity(reorderedV1)).toEqual(v1Identity);
    expect(paymentRedeliveryIdentity(v2Payload())).toEqual(v1Identity);
    expect(v1Identity?.keyIdentity).toMatch(
      /^x402:redelivery:[0-9a-f]{64}$/,
    );
    expect(v1Identity?.credential).toMatch(/^[0-9a-f]{64}$/);
  });

  it('65-byte の v 0/1/27/28 と compact signature を同じ credential に正規化する', () => {
    const parsed = parseSignature(SIGNATURE);
    const vZero = `${SIGNATURE.slice(0, -2)}00`;
    const compact = serializeCompactSignature(
      signatureToCompactSignature(parsed),
    );

    expect(paymentRedeliveryIdentity(v1Payload(vZero))).toEqual(identity());
    expect(paymentRedeliveryIdentity(v1Payload(compact))).toEqual(identity());
  });

  it('主 key は authorization identity、credential は signature ごとに分離する', () => {
    const first = identity();
    const second = paymentRedeliveryIdentity(v1Payload(OTHER_SIGNATURE));

    expect(second?.keyIdentity).toBe(first.keyIdentity);
    expect(second?.credential).not.toBe(first.credential);
  });

  it('不正 signature / authorization は identity を発行しない', () => {
    expect(
      paymentRedeliveryIdentity({
        ...v1Payload(),
        payload: { ...v1Payload().payload, signature: `0x${'11'.repeat(65)}` },
      }),
    ).toBeNull();
    expect(
      paymentRedeliveryIdentity({
        ...v1Payload(),
        payload: {
          ...v1Payload().payload,
          authorization: {
            ...v1Payload().payload.authorization,
            validAfter: '-1',
          },
        },
      }),
    ).toBeNull();
  });
});

describe('payment redelivery record binding', () => {
  it('lookup は scope/resource/credential が全一致した record だけを返す', async () => {
    const paymentIdentity = identity();
    kv.get.mockResolvedValue({
      ok: true,
      value: pendingRaw({ identity: paymentIdentity }),
    });

    await expect(
      lookupPaymentRedelivery(paymentIdentity, BINDING),
    ).resolves.toMatchObject({
      kind: 'match',
      record: { state: 'pending', resource: RESOURCE },
    });
    await expect(
      lookupPaymentRedelivery(paymentIdentity, {
        ...BINDING,
        resource: OTHER_RESOURCE,
      }),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(
      lookupPaymentRedelivery(paymentIdentity, {
        ...BINDING,
        scope: 'agent-order',
      }),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(
      lookupPaymentRedelivery(
        paymentRedeliveryIdentity(v1Payload(OTHER_SIGNATURE))!,
        BINDING,
      ),
    ).resolves.toEqual({ kind: 'conflict' });
  });

  it('壊れた既存 record は fail-closed conflict、KV 障害は fail-open unavailable', async () => {
    kv.get.mockResolvedValueOnce({ ok: true, value: '{"state":"pending"}' });
    await expect(
      lookupPaymentRedelivery(identity(), BINDING),
    ).resolves.toEqual({ kind: 'conflict' });

    kv.get.mockRejectedValueOnce(new Error('kv down'));
    await expect(
      lookupPaymentRedelivery(identity(), BINDING),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('verify 後 claim は SET NX GET + TTL で pending body/context を原子的に束縛する', async () => {
    const paymentIdentity = identity();
    const context = { order: { handle: 'ramen' }, immutable: true };
    const result = await claimPaymentRedelivery({
      identity: paymentIdentity,
      binding: BINDING,
      facilitatorBody: BODY,
      context,
    });

    expect(result).toMatchObject({ kind: 'claimed' });
    expect(kv.setNxGet).toHaveBeenCalledTimes(1);
    const [key, raw, ttl] = kv.setNxGet.mock.calls[0];
    expect(key).toBe(paymentIdentity.keyIdentity);
    expect(ttl).toBe(PAYMENT_REDELIVERY_TTL_SEC);
    const claimedRecord = JSON.parse(raw as string) as Record<string, unknown>;
    expect(claimedRecord).toMatchObject({
      version: 1,
      state: 'pending',
      scope: 'first-party',
      resource: RESOURCE,
      credential: paymentIdentity.credential,
      facilitatorBody: BODY,
      context,
    });
    expect(claimedRecord.ownerToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同じ identity の異なる resource claim race は一方だけが勝ち、敗者は conflict', async () => {
    let stored: string | null = null;
    kv.setNxGet.mockImplementation(
      async (_key: string, value: string) => {
        if (stored === null) {
          stored = value;
          return { ok: true as const, value: null };
        }
        return { ok: true as const, value: stored };
      },
    );
    const paymentIdentity = identity();

    const results = await Promise.all([
      claimPaymentRedelivery({
        identity: paymentIdentity,
        binding: BINDING,
        facilitatorBody: BODY,
      }),
      claimPaymentRedelivery({
        identity: paymentIdentity,
        binding: { ...BINDING, resource: OTHER_RESOURCE },
        facilitatorBody: BODY,
      }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      'claimed',
      'conflict',
    ]);
  });

  it('promotion CAS は一致 pending だけを昇格し immutable context を保持する', async () => {
    const paymentIdentity = identity();
    let stored = pendingRaw({
      identity: paymentIdentity,
      context: { snapshot: { total: '300' } },
    });
    kv.eval.mockImplementation(
      async (
        script: string,
        _keys: string[],
        args: string[],
      ) => {
        expect(script).toContain("decoded.scope ~= ARGV[1]");
        expect(script).toContain("decoded.resource ~= ARGV[2]");
        expect(script).toContain("decoded.credential ~= ARGV[3]");
        const current = JSON.parse(stored) as Record<string, unknown>;
        if (
          current.scope !== args[0] ||
          current.resource !== args[1] ||
          current.credential !== args[2]
        ) {
          return { ok: true as const, value: [-1, ''] };
        }
        current.state = 'settled';
        current.settlement = JSON.parse(args[3]) as unknown;
        stored = JSON.stringify(current);
        return { ok: true as const, value: [1, stored] };
      },
    );

    const result = await promotePaymentRedelivery({
      identity: paymentIdentity,
      binding: BINDING,
      settlement,
    });

    expect(result).toMatchObject({
      kind: 'promoted',
      record: {
        state: 'settled',
        context: { snapshot: { total: '300' } },
        settlement,
      },
    });
    expect(kv.eval.mock.calls[0][2].slice(-2)).toEqual([
      String(PAYMENT_REDELIVERY_TTL_SEC),
      String(16 * 1024),
    ]);
  });

  it('promotion CAS は異なる resource/credential を上書きしない', async () => {
    kv.eval.mockResolvedValue({ ok: true, value: [-1, ''] });

    await expect(
      promotePaymentRedelivery({
        identity: identity(),
        binding: { ...BINDING, resource: OTHER_RESOURCE },
        settlement,
      }),
    ).resolves.toEqual({ kind: 'conflict' });
  });

  it('broadcast 前拒否の解放は ownerToken 一致 CAS だけが pending を削除する', async () => {
    const paymentIdentity = identity();
    let stored: string | null = null;
    kv.setNxGet.mockImplementation(
      async (_key: string, value: string) => {
        stored = value;
        return { ok: true as const, value: null };
      },
    );
    kv.eval.mockImplementation(
      async (script: string, _keys: string[], args: string[]) => {
        expect(script).toContain("decoded.ownerToken ~= ARGV[4]");
        expect(script).toContain("redis.call('DEL', KEYS[1])");
        if (stored === null) return { ok: true as const, value: 0 };
        const current = JSON.parse(stored) as Record<string, unknown>;
        if (
          current.scope !== args[0] ||
          current.resource !== args[1] ||
          current.credential !== args[2] ||
          current.ownerToken !== args[3]
        ) {
          return { ok: true as const, value: -1 };
        }
        stored = null;
        return { ok: true as const, value: 1 };
      },
    );
    const claim = await claimPaymentRedelivery({
      identity: paymentIdentity,
      binding: BINDING,
      facilitatorBody: BODY,
    });
    if (claim.kind !== 'claimed') throw new Error('claim must succeed');

    await expect(
      releasePaymentRedelivery({
        identity: paymentIdentity,
        binding: BINDING,
        ownerToken: 'f'.repeat(64),
      }),
    ).resolves.toEqual({ kind: 'not-owner' });
    expect(stored).not.toBeNull();

    await expect(
      releasePaymentRedelivery({
        identity: paymentIdentity,
        binding: BINDING,
        ownerToken: claim.record.ownerToken,
      }),
    ).resolves.toEqual({ kind: 'released' });
    expect(stored).toBeNull();
  });

  it('release 対象は broadcast 前と保証された settle 拒否だけに限定する', () => {
    expect(
      isFacilitatorPreBroadcastRejection(429, {
        success: false,
        errorReason: 'rate_limited',
      }),
    ).toBe(true);
    expect(
      isFacilitatorPreBroadcastRejection(429, {
        error: 'ip_rate_limited',
      }),
    ).toBe(true);
    expect(
      isFacilitatorPreBroadcastRejection(503, {
        success: false,
        errorReason: 'preflight_unavailable',
      }),
    ).toBe(true);
    expect(
      isFacilitatorPreBroadcastRejection(202, {
        success: false,
        errorReason: 'pending',
      }),
    ).toBe(false);
    expect(
      isFacilitatorPreBroadcastRejection(502, {
        success: false,
        errorReason: 'unknown_after_submit',
      }),
    ).toBe(false);
  });
});
