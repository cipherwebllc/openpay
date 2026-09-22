// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const kv = vi.hoisted(() => ({ kvGet: vi.fn(), kvGetDel: vi.fn(), kvSetNxGet: vi.fn(), kvEval: vi.fn(), kvLrange: vi.fn() }));
vi.mock('@/lib/kv', () => kv);
import { bindAgent, unbindAgent, listAgentBindings, isOwner } from '@/lib/agent/bindings';
import { agentPurchasesKv } from '../../_helpers/agentPurchasesKv';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const O = `0x${'c'.repeat(40)}`;
const OTHER = `0x${'d'.repeat(40)}`;
const checksum = (a: string) => `0x${a.slice(2).toUpperCase()}`;
let store: ReturnType<typeof agentPurchasesKv>;
beforeEach(() => { vi.resetAllMocks(); store = agentPurchasesKv(kv); });
afterAll(closeRedisLuaEngine);

describe('Agent bindings (real Lua CAS)', () => {
  it('bind / list / owner check normalize all addresses', async () => {
    const bound = await bindAgent(checksum(A), checksum(O));
    expect(bound).toMatchObject({ ok: true, address: A });
    if (!bound.ok) throw new Error('bind');
    expect(store.strings.get(`agent:bound:${A}`)).toBe(JSON.stringify({ owner: O, at: bound.boundAt }));
    expect(store.strings.get(`agent:owner:${O}`)).toBe(JSON.stringify([A]));
    expect(await listAgentBindings(checksum(O))).toEqual({ ok: true, addresses: [{ address: A, boundAt: bound.boundAt }] });
    expect(await isOwner(checksum(A), checksum(O))).toEqual({ ok: true, isOwner: true, boundAt: bound.boundAt });
    expect(await isOwner(A, OTHER)).toEqual({ ok: true, isOwner: false, boundAt: null });
  });

  it('rebind removes the old owner index while preserving other agents', async () => {
    await bindAgent(A, O);
    await bindAgent(B, O);
    expect((await bindAgent(A, OTHER)).ok).toBe(true);
    expect(store.strings.get(`agent:owner:${O}`)).toBe(JSON.stringify([B]));
    expect(await isOwner(A, O)).toEqual({ ok: true, isOwner: false, boundAt: null });
    expect(await listAgentBindings(O)).toMatchObject({ ok: true, addresses: [{ address: B }] });
    expect(await listAgentBindings(OTHER)).toMatchObject({ ok: true, addresses: [{ address: A }] });
  });

  it('rebind to the same owner is deduplicated', async () => {
    await bindAgent(A, O);
    await bindAgent(A, O);
    expect(store.strings.get(`agent:owner:${O}`)).toBe(JSON.stringify([A]));
  });

  it('unbind requires owner and deletes both keys when the last agent is removed', async () => {
    await bindAgent(A, O);
    expect(await unbindAgent(A, OTHER)).toEqual({ ok: false, reason: 'not_bound' });
    expect(await unbindAgent(checksum(A), checksum(O))).toEqual({ ok: true });
    expect(store.strings.size).toBe(0);
    expect(await unbindAgent(A, O)).toEqual({ ok: false, reason: 'not_bound' });
  });

  it('unbind preserves other entries', async () => {
    await bindAgent(A, O);
    await bindAgent(B, O);
    expect(await unbindAgent(A, O)).toEqual({ ok: true });
    expect(store.strings.get(`agent:owner:${O}`)).toBe(JSON.stringify([B]));
  });

  it('rejects the 21st binding without evicting any existing ownership', async () => {
    for (let i = 1; i <= 20; i++) expect((await bindAgent(`0x${i.toString(16).padStart(40, '0')}`, O)).ok).toBe(true);
    await bindAgent(A, OTHER);
    expect(await bindAgent(A, O)).toEqual({ ok: false, reason: 'binding_limit' });
    expect(await isOwner(A, OTHER)).toMatchObject({ ok: true, isOwner: true });
    expect(await listAgentBindings(O)).toMatchObject({ ok: true, addresses: expect.any(Array) });
    expect(JSON.parse(store.strings.get(`agent:owner:${O}`)!)).toHaveLength(20);
    expect((await bindAgent(`0x${'1'.padStart(40, '0')}`, O)).ok).toBe(true);
  });

  it('two concurrent binds to the same owner cannot lose an index entry', async () => {
    const results = await Promise.all([bindAgent(A, O), bindAgent(B, O)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'storage_error' });
    const index = JSON.parse(store.strings.get(`agent:owner:${O}`)!);
    expect(index).toHaveLength(1);
    expect(store.strings.has(`agent:bound:${index[0] === A ? B : A}`)).toBe(false);
  });

  it('concurrent new owners cannot both acquire an agent', async () => {
    const results = await Promise.all([bindAgent(A, O), bindAgent(A, OTHER)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'storage_error' });
    const owner = JSON.parse(store.strings.get(`agent:bound:${A}`)!).owner;
    expect(store.strings.has(`agent:owner:${owner === O ? OTHER : O}`)).toBe(false);
  });

  it('concurrent unbind and transfer leave only the winning ownership state', async () => {
    await bindAgent(A, O);
    const results = await Promise.all([unbindAgent(A, O), bindAgent(A, OTHER)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await listAgentBindings(O)).toEqual({ ok: true, addresses: [] });
    const raw = store.strings.get(`agent:bound:${A}`);
    if (raw) expect(JSON.parse(raw).owner).toBe(OTHER);
    else expect(store.strings.has(`agent:owner:${OTHER}`)).toBe(false);
  });

  it('stale owner index is not authoritative for list or isOwner', async () => {
    store.strings.set(`agent:owner:${O}`, JSON.stringify([A, B]));
    store.strings.set(`agent:bound:${A}`, JSON.stringify({ owner: OTHER, at: new Date().toISOString() }));
    expect(await listAgentBindings(O)).toEqual({ ok: true, addresses: [] });
    expect(await isOwner(A, O)).toEqual({ ok: true, isOwner: false, boundAt: null });
  });

  it.each(['{', 'null', '{"owner":"bad","at":"bad"}'])('corrupt bound record %s fails closed', async (raw) => {
    store.strings.set(`agent:bound:${A}`, raw);
    expect(await isOwner(A, O)).toEqual({ ok: false, reason: 'storage_error' });
    expect(await bindAgent(A, O)).toEqual({ ok: false, reason: 'storage_error' });
    expect(await unbindAgent(A, O)).toEqual({ ok: false, reason: 'storage_error' });
    expect(kv.kvEval).not.toHaveBeenCalled();
  });

  it.each(['{}', '{', '["bad"]', JSON.stringify([A, A])])('corrupt owner index %s cannot be overwritten', async (raw) => {
    store.strings.set(`agent:owner:${O}`, raw);
    expect(await listAgentBindings(O)).toEqual({ ok: false, reason: 'storage_error' });
    expect(await bindAgent(A, O)).toEqual({ ok: false, reason: 'storage_error' });
    expect(kv.kvEval).not.toHaveBeenCalled();
  });

  it('all public operations return a typed storage error on KV read failure', async () => {
    kv.kvGet.mockResolvedValue({ ok: false, reason: 'timeout' });
    for (const operation of [bindAgent(A, O), unbindAgent(A, O), isOwner(A, O), listAgentBindings(O)]) {
      expect(await operation).toEqual({ ok: false, reason: 'storage_error' });
    }
  });

  it('write failure and thrown reads do not produce false success', async () => {
    kv.kvEval.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    expect(await bindAgent(A, O)).toEqual({ ok: false, reason: 'storage_error' });
    expect(store.strings.size).toBe(0);
    await bindAgent(A, O);
    kv.kvEval.mockRejectedValueOnce(new Error('private detail'));
    expect(await unbindAgent(A, O)).toEqual({ ok: false, reason: 'storage_error' });
    kv.kvGet.mockRejectedValue(new Error('private detail'));
    expect(await listAgentBindings(O)).toEqual({ ok: false, reason: 'storage_error' });
  });
});
