import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';

const redis = vi.hoisted(() => ({
  parent: null as string | null,
  selected: null as null | {
    rail: string;
    intentSalt: string;
    authorizationHash: string;
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/kv', () => ({
  kvEval: vi.fn(async (script: string, _keys: string[], args: string[]) => {
    if (script.includes('local terminal = false')) {
      redis.parent ??= args[10]!;
      return { ok: true as const, value: [redis.parent] };
    }
    if (script.includes('active.selectedRail = ARGV[6]')) {
      const incoming = {
        rail: args[5]!,
        intentSalt: args[6]!,
        authorizationHash: args[7]!,
      };
      if (!redis.selected) {
        redis.selected = incoming;
        return { ok: true as const, value: 1 };
      }
      return {
        ok: true as const,
        value:
          JSON.stringify(redis.selected) === JSON.stringify(incoming) ? 2 : -1,
      };
    }
    return { ok: true as const, value: 1 };
  }),
}));

import {
  associateStoreRailIntent,
  claimStoreRailSelection,
} from '@/lib/x402/storeRailSelection';

const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const RESOURCE = `h_${'a'.repeat(32)}`;
const JPYC_SALT = `0x${'11'.repeat(32)}` as Hex;
const USDC_SALT = `0x${'22'.repeat(32)}` as Hex;

beforeEach(() => {
  redis.parent = null;
  redis.selected = null;
});

describe('Store payment rail exclusion CAS', () => {
  it('同じ payer/product/revision の JPYC と USDC intent を同じ parent に束ねる', async () => {
    const [jpyc, usdc] = await Promise.all([
      associateStoreRailIntent({
        intentSalt: JPYC_SALT,
        intentKey: `store:intent:${JPYC_SALT}`,
        payer: PAYER,
        resourceId: RESOURCE,
        contentRevision: 1,
      }),
      associateStoreRailIntent({
        intentSalt: USDC_SALT,
        intentKey: `store:usdc:intent:${USDC_SALT}`,
        payer: PAYER,
        resourceId: RESOURCE,
        contentRevision: 1,
      }),
    ]);
    expect(jpyc.ok && usdc.ok && jpyc.parentIntentId).toBe(
      usdc.ok ? usdc.parentIntentId : '',
    );
  });

  it('JPYC vs USDC 同時署名 race は単一 CAS の勝者だけを broadcast admission する', async () => {
    const associated = await associateStoreRailIntent({
      intentSalt: JPYC_SALT,
      intentKey: `store:intent:${JPYC_SALT}`,
      payer: PAYER,
      resourceId: RESOURCE,
      contentRevision: 1,
    });
    if (!associated.ok) throw new Error('association failed');

    const [jpyc, usdc] = await Promise.all([
      claimStoreRailSelection({
        parentIntentId: associated.parentIntentId,
        intentSalt: JPYC_SALT,
        intentKey: `store:intent:${JPYC_SALT}`,
        payer: PAYER,
        resourceId: RESOURCE,
        contentRevision: 1,
        rail: 'jpyc',
        authorizationHash: 'a'.repeat(64),
      }),
      claimStoreRailSelection({
        parentIntentId: associated.parentIntentId,
        intentSalt: USDC_SALT,
        intentKey: `store:usdc:intent:${USDC_SALT}`,
        payer: PAYER,
        resourceId: RESOURCE,
        contentRevision: 1,
        rail: 'usdc',
        authorizationHash: 'b'.repeat(64),
      }),
    ]);

    expect([jpyc.ok, usdc.ok].filter(Boolean)).toHaveLength(1);
    expect([jpyc, usdc]).toContainEqual({ ok: false, reason: 'conflict' });
  });

  it('同一 rail・intent・authorization の再送は idempotent', async () => {
    const associated = await associateStoreRailIntent({
      intentSalt: USDC_SALT,
      intentKey: `store:usdc:intent:${USDC_SALT}`,
      payer: PAYER,
      resourceId: RESOURCE,
      contentRevision: 1,
    });
    if (!associated.ok) throw new Error('association failed');
    const input = {
      parentIntentId: associated.parentIntentId,
      intentSalt: USDC_SALT,
      intentKey: `store:usdc:intent:${USDC_SALT}`,
      payer: PAYER,
      resourceId: RESOURCE,
      contentRevision: 1,
      rail: 'usdc' as const,
      authorizationHash: 'b'.repeat(64),
    };
    await expect(claimStoreRailSelection(input)).resolves.toEqual({
      ok: true,
      kind: 'claimed',
    });
    await expect(claimStoreRailSelection(input)).resolves.toEqual({
      ok: true,
      kind: 'idempotent',
    });
  });
});
