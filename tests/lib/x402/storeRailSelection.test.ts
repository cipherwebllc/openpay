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

import { kvEval } from '@/lib/kv';
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

  // B15: rail 確定後の active slot を PERSIST (無期限) にすると、terminal に到達しない
  // intent (indeterminate 等) が同じ payer×resource×revision を恒久的に塞ぎ KV も膨らむ。
  //
  // ⚠️ このテストは意図的に white-box (Lua スクリプト本文と ARGV の位置を直接見る)。TTL は
  // 実 Redis 無しでは観測できず、in-memory の kvEval モックは EXPIRE を解釈しないため、
  // 「スクリプトが TTL を張る形になっていること」以上は検証できない。スクリプトの整形や
  // ARGV 番号を変えたらこのテストも一緒に直す (壊れたら仕様違反ではなくテストの追随漏れ)。
  it('rail 確定後の active slot / intent 対応は無期限にせず 30 日 TTL を張る', async () => {
    const associated = await associateStoreRailIntent({
      intentSalt: USDC_SALT,
      intentKey: `store:usdc:intent:${USDC_SALT}`,
      payer: PAYER,
      resourceId: RESOURCE,
      contentRevision: 1,
    });
    if (!associated.ok) throw new Error('association failed');
    await claimStoreRailSelection({
      parentIntentId: associated.parentIntentId,
      intentSalt: USDC_SALT,
      intentKey: `store:usdc:intent:${USDC_SALT}`,
      payer: PAYER,
      resourceId: RESOURCE,
      contentRevision: 1,
      rail: 'usdc',
      authorizationHash: 'b'.repeat(64),
    });

    const claimCall = vi
      .mocked(kvEval)
      .mock.calls.find(([script]) =>
        String(script).includes('active.selectedRail = ARGV[6]'),
      );
    const [script, , args] = claimCall!;
    expect(String(script)).not.toContain('PERSIST');
    expect(String(script)).toContain("redis.call('EXPIRE', KEYS[3], ARGV[13])");
    expect(String(script)).toContain(
      "redis.call('SET', KEYS[1], selectedRaw, 'EX', ARGV[13])",
    );
    expect((args as string[])[12]).toBe(String(30 * 24 * 60 * 60));
    // archive (KEYS[2]) は監査用に無期限のまま。
    expect(String(script)).toContain("redis.call('SET', KEYS[2], selectedRaw)");
  });
});
