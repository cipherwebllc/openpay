// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  beforeEval: null as (() => void) | null,
}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true, value: (holder.store!.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    holder.beforeEval?.();
    holder.beforeEval = null;
    return { ok: true, value: await runRedisLua(script, keys, args, holder.store!) };
  },
}));

import {
  createResource, deactivateResource, getPublicResource, listActiveResources, listResourcesForMerchant,
  resourceKey, updateResource, type X402Resource, type X402ResourceInput,
} from '@/lib/x402/registry';
import { hiddenUrlLedgerKey, HIDDEN_URL_LEDGER_TTL_SEC } from '@/lib/x402/hiddenUrlLedger';
import { applyExternalReverify } from '@/lib/x402/reverify';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';

const OWNER = '0x1111111111111111111111111111111111111111';
const TARGET = 'https://seller.example/x';
const DUMMY = 'https://seller.example/dummy';
const input = (url: string): X402ResourceInput => ({
  merchant: OWNER, payTo: OWNER, url, description: 'd', category: 'api', priceJpyc: '1',
});
const stored = (id: string): X402Resource => JSON.parse(holder.store!.strings.get(resourceKey(id))!);
function mark(id: string, overrides: Partial<X402Resource>) {
  holder.store!.strings.set(resourceKey(id), JSON.stringify({ ...stored(id), ...overrides }));
}
const verification = {
  lastOkAt: '2026-09-23T00:00:00.000Z', lastCheckedAt: '2026-09-23T00:00:00.000Z',
  lastRunId: 'run', failures: 0, probedUrl: DUMMY,
};

beforeEach(() => { holder.store = createFakeRedisStore(); holder.beforeEval = null; });
afterAll(closeRedisLuaEngine);

describe('registry moderation inheritance (real Lua)', () => {
  it.each([TARGET, TARGET + '?v=2'])('PATCH into a deleted hidden URL inherits hidden: %s', async (url) => {
    expect(await createResource(input(TARGET), 'old', 1)).toMatchObject({ ok: true });
    mark('old', { hidden: true });
    expect(await deactivateResource('old', OWNER)).toEqual({ ok: true });
    expect(await createResource(input(DUMMY), 'dummy', 2)).toMatchObject({ ok: true });
    mark('dummy', { verification });

    expect(await updateResource('dummy', OWNER, input(url), 3))
      .toMatchObject({ ok: true, resource: { url, hidden: true } });
    expect(stored('dummy').hidden).toBe(true);
    expect(stored('dummy')).not.toHaveProperty('verification');
    expect(holder.store!.strings.get(resourceUrlClaimKey(url))).toBe('dummy');
    expect(holder.store!.strings.has(resourceUrlClaimKey(DUMMY))).toBe(false);
    expect(await listActiveResources()).toEqual([]);
    expect(await listResourcesForMerchant(OWNER)).toEqual([expect.objectContaining({ id: 'dummy', hidden: true })]);
  });

  it('metadata-only PATCH does not rehide or reset verification', async () => {
    await createResource(input(DUMMY), 'dummy', 1);
    mark('dummy', { verification, hidden: false });
    holder.store!.strings.set(hiddenUrlLedgerKey(DUMMY), '1');
    expect(await updateResource('dummy', OWNER, { ...input(DUMMY), description: 'updated' }, 2))
      .toMatchObject({ ok: true, resource: { hidden: false, verification, description: 'updated' } });
  });

  it.each([false, true])('a clean target preserves the existing hidden=%s state', async (hidden) => {
    await createResource(input(DUMMY), 'dummy', 1);
    mark('dummy', { hidden, verification });
    expect(await updateResource('dummy', OWNER, input(TARGET), 2))
      .toMatchObject({ ok: true, resource: { url: TARGET, hidden } });
    expect(stored('dummy')).not.toHaveProperty('verification');
  });

  it('checks the ledger at CAS time, after the pre-read', async () => {
    await createResource(input(DUMMY), 'dummy', 1);
    holder.beforeEval = () => holder.store!.strings.set(hiddenUrlLedgerKey(TARGET), '1');
    expect(await updateResource('dummy', OWNER, input(TARGET + '?v=2'), 2))
      .toMatchObject({ ok: true, resource: { hidden: true } });
  });

  it.each([
    ['create', false], ['update', false], ['create', true], ['update', true],
  ] as const)('%s checks the legacy full-URL ledger without refreshing its TTL (expired=%s)', async (action, expired) => {
    if (action === 'update') await createResource(input(DUMMY), 'current', 1);
    // 旧バージョンのキーを独立に再現する。新 helper 由来のキーでは移行漏れを検出できない。
    const legacyKey = 'x402:hidden-url:' + createHash('sha256')
      .update('https://seller.example/x?v=1').digest('hex');
    holder.store!.strings.set(legacyKey, '1');
    holder.store!.setTtl(legacyKey, HIDDEN_URL_LEDGER_TTL_SEC);
    holder.store!.advance(expired ? (HIDDEN_URL_LEDGER_TTL_SEC + 1) * 1000 : 1000);
    const url = 'https://SELLER.EXAMPLE:443/x?v=1#fragment';
    const result = action === 'create'
      ? await createResource(input(url), 'current', 2)
      : await updateResource('current', OWNER, input(url), 2);
    expect(result.ok).toBe(true);
    expect(stored('current').hidden).toBe(expired ? undefined : true);
    expect(holder.store!.strings.has(hiddenUrlLedgerKey(url))).toBe(false);
    if (!expired) expect(holder.store!.getTtl(legacyKey)).toBe(HIDDEN_URL_LEDGER_TTL_SEC - 1);
  });
});

// PR-09b: 登録の probe が判定不能だった新規掲載 (pendingFirstVerification)。hidden の既存の仕組みに乗せる。
describe('first verification pending (real Lua)', () => {
  const ledgerKeys = () => holder.store!.keys().filter((key) => key.startsWith('x402:hidden-url:'));

  it('hidden + 印で作り、URL claim を持ち、一覧には出さず ID の照会と owner の一覧には出す', async () => {
    expect(await createResource(input(TARGET), 'pending', 1, { pendingFirstVerification: true }))
      .toMatchObject({ ok: true, resource: { hidden: true, pendingFirstVerification: true } });
    expect(stored('pending')).toMatchObject({ hidden: true, pendingFirstVerification: true });
    expect(holder.store!.strings.get(resourceUrlClaimKey(TARGET))).toBe('pending');
    expect(await listActiveResources()).toEqual([]);
    expect(await getPublicResource('pending'))
      .toEqual({ ok: true, resource: expect.objectContaining({ id: 'pending', pendingFirstVerification: true }) });
    expect(await listResourcesForMerchant(OWNER)).toEqual([expect.objectContaining({ id: 'pending', hidden: true })]);
  });

  it('移行なし: 印なしの作成は従来どおり公開・印のない hidden は ID の照会でも隠す', async () => {
    expect(await createResource(input(TARGET), 'visible', 1)).toMatchObject({ ok: true });
    expect(stored('visible')).not.toHaveProperty('hidden');
    expect(stored('visible')).not.toHaveProperty('pendingFirstVerification');
    expect(await listActiveResources()).toEqual([expect.objectContaining({ id: 'visible' })]);
    mark('visible', { hidden: true });
    expect(await getPublicResource('visible')).toEqual({ ok: true, resource: null });
  });

  // 台帳を継承した hidden は本物のモデレーション状態。probe が判定不能でも印を付けず、従来どおりの hidden
  // (ID の照会も 404) にする。印を付けると ID の照会で返り、削除 → 再登録で台帳を立てずに洗い流せてしまう。
  it.each([true, false])('台帳がある URL の登録は印なしの hidden (pending 指定=%s)', async (pending) => {
    holder.store!.strings.set(hiddenUrlLedgerKey(TARGET), '1');
    const created = await createResource(input(TARGET), 'inherited', 1, { pendingFirstVerification: pending });
    expect(created).toMatchObject({ ok: true, resource: { hidden: true } });
    expect(created.ok && created.resource).not.toHaveProperty('pendingFirstVerification');
    expect(stored('inherited').hidden).toBe(true);
    expect(stored('inherited')).not.toHaveProperty('pendingFirstVerification');
    expect(await getPublicResource('inherited')).toEqual({ ok: true, resource: null });
    expect(await listActiveResources()).toEqual([]);
    // 再検証の一時障害・違反では解けない。削除すれば台帳を立て直す (従来の N-5 と同じ)。
    expect(await applyExternalReverify('inherited', TARGET, 'transient', 't1', 'r1')).toMatchObject({ hiddenAfter: true });
    expect(await applyExternalReverify('inherited', TARGET, 'violation_gone', 't2', 'r2')).toMatchObject({ hiddenAfter: true });
    holder.store!.strings.delete(hiddenUrlLedgerKey(TARGET));
    expect(await deactivateResource('inherited', OWNER)).toEqual({ ok: true });
    expect(holder.store!.strings.get(hiddenUrlLedgerKey(TARGET))).toBe('1');
  });

  it('台帳済 URL への PATCH は印を外し、従来どおりの hidden にする', async () => {
    await createResource(input(DUMMY), 'pending', 1, { pendingFirstVerification: true });
    holder.store!.strings.set(hiddenUrlLedgerKey(TARGET), '1');
    expect(await updateResource('pending', OWNER, input(TARGET), 2))
      .toMatchObject({ ok: true, resource: { url: TARGET, hidden: true } });
    expect(stored('pending')).not.toHaveProperty('pendingFirstVerification');
    expect(await getPublicResource('pending')).toEqual({ ok: true, resource: null });
  });

  it.each(['visible', 'pending'] as const)(
    'モデレーションで隠れた %s の掲載を削除 → 再登録 (probe 判定不能) しても印なしの hidden のまま',
    async (start) => {
      await createResource(input(TARGET), 'old', 1, { pendingFirstVerification: start === 'pending' });
      for (let run = 1; run <= 3; run += 1) {
        await applyExternalReverify('old', TARGET, 'violation_gone', `t${run}`, `r${run}`);
      }
      expect(stored('old')).toMatchObject({ hidden: true });
      expect(stored('old')).not.toHaveProperty('pendingFirstVerification');
      expect(await deactivateResource('old', OWNER)).toEqual({ ok: true });

      const again = await createResource(input(TARGET), 'again', 2, { pendingFirstVerification: true });
      expect(again).toMatchObject({ ok: true, resource: { hidden: true } });
      expect(stored('again')).not.toHaveProperty('pendingFirstVerification');
      expect(await getPublicResource('again')).toEqual({ ok: true, resource: null });
      expect(await listActiveResources()).toEqual([]);
    },
  );

  it('削除しても URL 台帳を立てない (一度も公開されていない)・印のない hidden の削除は従来どおり立てる', async () => {
    await createResource(input(TARGET), 'pending', 1, { pendingFirstVerification: true });
    expect(await deactivateResource('pending', OWNER)).toEqual({ ok: true });
    expect(stored('pending').active).toBe(false);
    expect(ledgerKeys()).toEqual([]);

    await createResource(input(DUMMY), 'hidden', 2);
    mark('hidden', { hidden: true });
    expect(await deactivateResource('hidden', OWNER)).toEqual({ ok: true });
    expect(ledgerKeys()).toEqual([hiddenUrlLedgerKey(DUMMY)]);
  });

  it('URL を変える編集でも印と hidden は残る (公開は再検証の ok だけ)', async () => {
    await createResource(input(TARGET), 'pending', 1, { pendingFirstVerification: true });
    expect(await updateResource('pending', OWNER, input(DUMMY), 2))
      .toMatchObject({ ok: true, resource: { url: DUMMY, hidden: true, pendingFirstVerification: true } });
    expect(await listActiveResources()).toEqual([]);
  });
});
