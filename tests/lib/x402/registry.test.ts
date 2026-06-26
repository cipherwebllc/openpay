import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';

// kv を in-memory でモック (registry の保存/列挙ロジックを純粋に検証)。
const store = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  lists: new Map<string, string[]>(),
}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (k: string) => ({ ok: true as const, value: store.kv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    store.kv.set(k, v);
    return { ok: true as const, value: 'OK' as const };
  },
  kvLpush: async (k: string, v: string) => {
    const a = store.lists.get(k) ?? [];
    a.unshift(v);
    store.lists.set(k, a);
    return { ok: true as const, value: a.length };
  },
  kvLrange: async (k: string, start: number, stop: number) => {
    const a = store.lists.get(k) ?? [];
    const end = stop < 0 ? a.length : stop + 1;
    return { ok: true as const, value: a.slice(start, end) };
  },
}));

import {
  parseResourceInput,
  createResource,
  getResource,
  listResourcesForMerchant,
  listActiveResources,
  recordSettlement,
  resourceKey,
  RESOURCES_INDEX,
  type X402Resource,
} from '@/lib/x402/registry';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');

beforeEach(() => {
  store.kv.clear();
  store.lists.clear();
});

describe('lib/x402/registry parseResourceInput', () => {
  it('valid (payTo 省略 → owner)', () => {
    const r = parseResourceInput(
      { url: 'https://a.jp/x', description: 'd', priceJpyc: '100', category: 'api' },
      OWNER,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.payTo).toBe(OWNER);
      expect(r.input.merchant).toBe(OWNER);
    }
  });

  it('valid (payTo 指定 → checksum)', () => {
    const pt = '0x2222222222222222222222222222222222222222';
    const r = parseResourceInput(
      { url: 'https://a.jp/x', description: 'd', priceJpyc: '100', category: 'api', payTo: pt },
      OWNER,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.payTo).toBe(getAddress(pt));
  });

  it.each([
    ['invalid_url', { url: 'ftp://x', description: 'd', priceJpyc: '1', category: 'c' }],
    ['invalid_description', { url: 'https://a', description: '', priceJpyc: '1', category: 'c' }],
    ['invalid_price', { url: 'https://a', description: 'd', priceJpyc: '0', category: 'c' }],
    ['invalid_price', { url: 'https://a', description: 'd', priceJpyc: '1.5', category: 'c' }],
    ['invalid_category', { url: 'https://a', description: 'd', priceJpyc: '1', category: '' }],
    ['invalid_pay_to', { url: 'https://a', description: 'd', priceJpyc: '1', category: 'c', payTo: '0xzzz' }],
  ])('reject %s', (reason, body) => {
    expect(parseResourceInput(body, OWNER)).toEqual({ ok: false, reason });
  });
});

describe('lib/x402/registry store', () => {
  it('createResource → getResource 往復 + 一覧 (owner / discovery) に出る', async () => {
    const res = await createResource(
      { merchant: OWNER, url: 'https://a.jp/x', description: 'd', priceJpyc: '100', category: 'api', payTo: OWNER },
      'id1',
      1000,
    );
    expect(res).not.toBeNull();
    expect(res!.network).toBe('eip155:80002'); // testnet → Amoy CAIP-2
    expect(res!.active).toBe(true);
    expect(await getResource('id1')).toEqual(res);
    expect((await listResourcesForMerchant(OWNER)).map((r) => r.id)).toContain('id1');
    expect((await listActiveResources()).map((r) => r.id)).toContain('id1');
  });

  it('listActiveResources は inactive を除外', async () => {
    await createResource(
      { merchant: OWNER, url: 'https://a', description: 'd', priceJpyc: '1', category: 'c', payTo: OWNER },
      'act',
      1,
    );
    const inactive: X402Resource = {
      id: 'ina',
      merchant: OWNER,
      url: 'https://b',
      description: 'd',
      priceJpyc: '1',
      category: 'c',
      payTo: OWNER,
      network: 'eip155:80002',
      active: false,
      createdAt: 1,
    };
    store.kv.set(resourceKey('ina'), JSON.stringify(inactive));
    store.lists.set(RESOURCES_INDEX, ['ina', 'act']);
    const ids = (await listActiveResources()).map((r) => r.id);
    expect(ids).toContain('act');
    expect(ids).not.toContain('ina');
  });

  it('recordSettlement 保存 (会計記録)', async () => {
    const ok = await recordSettlement({
      id: 's1',
      payer: OWNER,
      payTo: OWNER,
      amount: '1000',
      fee: '10',
      txHash: `0x${'a'.repeat(64)}`,
      network: 'eip155:80002',
      createdAt: 1,
    });
    expect(ok).toBe(true);
    expect(store.kv.has('x402:settlement:s1')).toBe(true);
  });
});
