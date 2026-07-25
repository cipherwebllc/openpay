import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import {
  consumeFacilitatorPayment,
  RESERVATION_ADMISSION_MARGIN_SECONDS,
  reserveFacilitatorPayment,
} from '@/lib/x402/facilitatorReservation';

const FROM = getAddress('0x1234567890123456789012345678901234567890');
const NONCE = `0x${'ab'.repeat(32)}` as Hex;
const IDENTITY = { chainId: 80002, from: FROM, nonce: NONCE };

function rawPayment(
  resource = 'https://seller.example/paid/report',
): Record<string, unknown> {
  return {
    x402Version: 1,
    paymentPayload: {
      scheme: 'exact',
      network: 'eip155:80002',
      payload: {
        authorization: {
          from: FROM,
          validAfter: '0',
          validBefore: '1600',
          intentSalt: `0x${'12'.repeat(32)}`,
        },
        signature: `0x${'34'.repeat(65)}`,
      },
    },
    paymentRequirements: {
      resource,
      network: 'eip155:80002',
      maxAmountRequired: '100',
    },
    reservation: {
      maxUpstreamSeconds: 60,
      settlementGraceSeconds: 30,
    },
  };
}

function memoryStore() {
  let value: string | null = null;
  const set = vi.fn(
    async (
      _key: string,
      next: string,
      _options: { nx?: boolean; ttlSec?: number } = {},
    ) => {
      if (value !== null) return { ok: true as const, value: null };
      value = next;
      return { ok: true as const, value: 'OK' as const };
    },
  );
  const evalFn = vi.fn(
    async (_script: string, _keys: string[], args: string[]) => {
      if (value === null) return { ok: true as const, value: 0 };
      const record = JSON.parse(value) as {
        state?: string;
        resource?: string;
        paymentHash?: string;
        token?: string;
      };
      if (
        record.resource !== args[0] ||
        (args[2] === '1' && record.token !== args[1])
      ) {
        return { ok: true as const, value: -1 };
      }
      if (record.state === 'consumed') {
        return { ok: true as const, value: 2 };
      }
      if (record.state !== 'reserved') {
        return { ok: true as const, value: -2 };
      }
      value = JSON.stringify({ ...record, state: 'consumed' });
      return { ok: true as const, value: 1 };
    },
  );
  return {
    store: { set, eval: evalFn },
    set,
    eval: evalFn,
    clear: () => {
      value = null;
    },
  };
}

describe('x402 facilitator reservation', () => {
  it('atomically admits only one parallel verify for chain/from/nonce', async () => {
    const memory = memoryStore();
    const input = {
      ...IDENTITY,
      raw: rawPayment(),
      validBefore: 1600n,
      nowSec: 1000,
    };

    const results = await Promise.all([
      reserveFacilitatorPayment(input, memory.store),
      reserveFacilitatorPayment(input, memory.store),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({
      ok: false,
      reason: 'authorization_reserved',
    });
    const successful = results.find((result) => result.ok);
    expect(successful).toMatchObject({
      token: expect.stringMatching(/^x402r1_[0-9a-f]{64}$/),
    });
    expect(memory.set).toHaveBeenCalledTimes(2);
    expect(memory.set.mock.calls[0][2]).toEqual({ nx: true, ttlSec: 600 });
  });

  it('binds the reservation token to stable resource and payment JSON', async () => {
    const memory = memoryStore();
    const raw = rawPayment();
    const reserved = await reserveFacilitatorPayment(
      {
        ...IDENTITY,
        raw,
        validBefore: 1600n,
        nowSec: 1000,
      },
      memory.store,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const reordered = {
      reservation: raw.reservation,
      paymentRequirements: raw.paymentRequirements,
      paymentPayload: raw.paymentPayload,
      x402Version: 1,
    };
    await expect(
      consumeFacilitatorPayment(
        {
          ...IDENTITY,
          raw: reordered,
          reservationToken: reserved.token,
        },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'consumed' });
  });

  it('rejects a changed resource or token and reports a match as replay', async () => {
    const memory = memoryStore();
    const raw = rawPayment();
    const reserved = await reserveFacilitatorPayment(
      {
        ...IDENTITY,
        raw,
        validBefore: 1600n,
        nowSec: 1000,
      },
      memory.store,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    await expect(
      consumeFacilitatorPayment(
        {
          ...IDENTITY,
          raw: rawPayment('https://seller.example/paid/other'),
          reservationToken: reserved.token,
        },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    expect(memory.eval).toHaveBeenCalledTimes(1);

    await expect(
      consumeFacilitatorPayment(
        {
          ...IDENTITY,
          raw,
          reservationToken: `x402r1_${'ff'.repeat(32)}`,
        },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    expect(memory.eval).toHaveBeenCalledTimes(2);

    await expect(
      consumeFacilitatorPayment(
        { ...IDENTITY, raw, reservationToken: reserved.token },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'consumed' });
    await expect(
      consumeFacilitatorPayment(
        { ...IDENTITY, raw, reservationToken: reserved.token },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'replay' });
  });

  it('leaves same-resource payment validation to the existing settle core', async () => {
    const memory = memoryStore();
    const raw = rawPayment();
    const reserved = await reserveFacilitatorPayment(
      {
        ...IDENTITY,
        raw,
        validBefore: 1600n,
        nowSec: 1000,
      },
      memory.store,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const changedPayment = rawPayment();
    (
      changedPayment.paymentRequirements as Record<string, unknown>
    ).maxAmountRequired = '101';

    await expect(
      consumeFacilitatorPayment(
        {
          ...IDENTITY,
          raw: changedPayment,
          reservationToken: reserved.token,
        },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'consumed' });
  });

  it('lets a published token-less client consume only the matching payment', async () => {
    const memory = memoryStore();
    const raw = rawPayment();
    const reserved = await reserveFacilitatorPayment(
      {
        ...IDENTITY,
        raw,
        validBefore: 1600n,
        nowSec: 1000,
      },
      memory.store,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    await expect(
      consumeFacilitatorPayment({ ...IDENTITY, raw }, memory.store),
    ).resolves.toEqual({ status: 'consumed' });
    await expect(
      consumeFacilitatorPayment({ ...IDENTITY, raw }, memory.store),
    ).resolves.toEqual({ status: 'replay' });
    await expect(
      consumeFacilitatorPayment(
        { ...IDENTITY, raw, reservationToken: reserved.token },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'replay' });
  });

  it('reports missing when settle did not have a preceding verify reservation', async () => {
    const memory = memoryStore();
    const raw = rawPayment();

    await expect(
      consumeFacilitatorPayment({ ...IDENTITY, raw }, memory.store),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      consumeFacilitatorPayment(
        {
          ...IDENTITY,
          raw,
          reservationToken: `x402r1_${'aa'.repeat(32)}`,
        },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      consumeFacilitatorPayment(
        {
          ...IDENTITY,
          raw,
          reservationToken: null,
        },
        memory.store,
      ),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('requires enough validity for upstream execution plus settlement grace', async () => {
    const memory = memoryStore();

    for (const validBefore of [1089n, 1090n, 1094n]) {
      await expect(
        reserveFacilitatorPayment(
          {
            ...IDENTITY,
            raw: rawPayment(),
            validBefore,
            nowSec: 1000,
          },
          memory.store,
        ),
      ).resolves.toEqual({
        ok: false,
        reason: 'insufficient_validity_window',
      });
    }
    expect(memory.set).not.toHaveBeenCalled();

    const admitted = await reserveFacilitatorPayment(
      {
        ...IDENTITY,
        raw: rawPayment(),
        validBefore:
          1090n + BigInt(RESERVATION_ADMISSION_MARGIN_SECONDS),
        nowSec: 1000,
        nowMs: () => 0,
      },
      memory.store,
    );
    expect(admitted.ok).toBe(true);
  });

  it('applies the default upstream window to a published request without reservation context', async () => {
    const memory = memoryStore();
    const legacyRaw = rawPayment();
    delete legacyRaw.reservation;

    await expect(
      reserveFacilitatorPayment(
        {
          ...IDENTITY,
          raw: legacyRaw,
          validBefore: 1094n,
          nowSec: 1000,
        },
        memory.store,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'insufficient_validity_window',
    });
    expect(memory.set).not.toHaveBeenCalled();
  });

  it('rechecks validity after KV latency and leaves an unsafe reservation fail-closed', async () => {
    const memory = memoryStore();
    let nowMs = 0;
    const delayedStore = {
      ...memory.store,
      set: vi.fn(async (...args: Parameters<typeof memory.store.set>) => {
        const result = await memory.store.set(...args);
        nowMs += 5_000;
        return result;
      }),
    };

    await expect(
      reserveFacilitatorPayment(
        {
          ...IDENTITY,
          raw: rawPayment(),
          validBefore:
            1090n + BigInt(RESERVATION_ADMISSION_MARGIN_SECONDS),
          nowSec: 1000,
          nowMs: () => nowMs,
        },
        delayedStore,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'insufficient_validity_window',
    });
    expect(delayedStore.set).toHaveBeenCalledOnce();
  });

  it('reports when reserve or consume storage is unavailable', async () => {
    const raw = rawPayment();
    const unavailable = {
      set: vi.fn(async () => ({
        ok: false as const,
        reason: 'network_error' as const,
      })),
      eval: vi.fn(async () => ({
        ok: false as const,
        reason: 'timeout' as const,
      })),
    };

    await expect(
      reserveFacilitatorPayment(
        {
          ...IDENTITY,
          raw,
          validBefore: 1600n,
          nowSec: 1000,
        },
        unavailable,
      ),
    ).resolves.toEqual({ ok: false, reason: 'reservation_unavailable' });
    await expect(
      consumeFacilitatorPayment(
        { ...IDENTITY, raw },
        unavailable,
      ),
    ).resolves.toEqual({ status: 'unavailable' });
  });
});
