// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const kv = vi.hoisted(() => ({ kvLrange: vi.fn() }));
vi.mock('@/lib/kv', () => kv);
import { readPayerPurchases } from '@/lib/agent/purchases';

const A = `0x${'a'.repeat(40)}`;
const ENTRY = {
  at: '2026-09-23T00:00:00.000Z', source: 'usdc-vanilla', network: 'base', asset: 'USDC', amount: '0.01',
  resource: 'https://open-pay.jp/api/paid/test?secret=one#private', payer: A,
  payTo: `0x${'b'.repeat(40)}`, tx: `0x${'c'.repeat(64)}`,
};
const row = (overrides = {}) => JSON.stringify({ ...ENTRY, ...overrides });
beforeEach(() => { vi.resetAllMocks(); kv.kvLrange.mockResolvedValue({ ok: true, value: [] }); });

describe('payer purchases', () => {
  it.each([0, 199, 200, 201])('%i raw rows: at most 200 items and 201 signals truncated', async (count) => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: Array.from({ length: count }, (_, i) => row({ at: new Date(Date.parse(ENTRY.at) + i * 1000).toISOString() })) });
    const result = await readPayerPurchases(`0x${'A'.repeat(40)}`);
    expect(kv.kvLrange).toHaveBeenCalledWith(`x402:settle:payer:${A}`, 0, 200);
    expect(result).toMatchObject({ ok: true, since: '2026-09-22', truncated: count > 200 });
    if (!result.ok) throw new Error('read');
    expect(result.items).toHaveLength(Math.min(count, 200));
    if (count) expect(result.items[0].at).toBe(new Date(Date.parse(ENTRY.at) + (count - 1) * 1000).toISOString());
  });

  it('projects only public fields and strips query and fragment', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: [row({ arbitrarySecret: 'never return' })] });
    const result = await readPayerPurchases(A);
    expect(result).toMatchObject({ items: [{ resource: { host: 'open-pay.jp', path: '/api/paid/test' }, resourceOrigin: 'first-party' }] });
    if (!result.ok) throw new Error('read');
    expect(Object.keys(result.items[0]).sort()).toEqual(['at', 'source', 'network', 'asset', 'amount', 'resource', 'resourceOrigin', 'tx'].sort());
    expect(JSON.stringify(result)).not.toMatch(/secret|private|payTo|payer|never return/);
  });

  it.each(['usdc-dual-rail', 'jpyc-facilitator'])('%s derives origin from source, regardless of URL', async (source) => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: [row({ source, fee: '1' })] });
    expect(await readPayerPurchases(A)).toMatchObject({ items: [{ fee: '1', resourceOrigin: source === 'usdc-dual-rail' ? 'listed' : 'claimed' }] });
  });

  it.each(['external.test', 'www.open-pay.jp', 'open-pay.jp.attacker.test'])('hashes the full path for %s', async (host) => {
    const path = '/private/customer/abc';
    kv.kvLrange.mockResolvedValue({ ok: true, value: [row({ resource: `https://name:password@${host}${path}?token=secret#secret` })] });
    const result = await readPayerPurchases(A);
    expect(result).toMatchObject({ items: [{ resource: { host, path: null, pathTag: createHash('sha256').update(path).digest('hex').slice(0, 8) } }] });
    expect(JSON.stringify(result)).not.toMatch(/private|customer|abc|secret|password/);
  });

  it.each(['', 'not a URL', 'https://', 'javascript:secret'])('empty/invalid URL %s is not echoed', async (resource) => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: [row({ resource })] });
    expect(await readPayerPurchases(A)).toMatchObject({ items: [{ resource: { host: null, path: null } }] });
  });

  it('drops malformed rows and cross-payer rows, preserving raw truncation', async () => {
    const broken = ['{', 'null', row({ payer: `0x${'b'.repeat(40)}` }), row({ at: 'invalid' }), row({ source: 'new' }), row({ source: ['usdc-vanilla'] }), row({ amount: 1 }), row({ fee: {} }), row({ tx: {} }), row({ asset: 'unknown' }), row({ resource: {} })];
    kv.kvLrange.mockResolvedValue({ ok: true, value: [row(), ...Array.from({ length: 200 }, (_, i) => broken[i % broken.length])] });
    const result = await readPayerPurchases(A);
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (!result.ok) throw new Error('read');
    expect(result.items).toHaveLength(1);
  });

  it('storage failure is not an empty history', async () => {
    kv.kvLrange.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    expect(await readPayerPurchases(A)).toEqual({ ok: false, reason: 'storage_error' });
    kv.kvLrange.mockRejectedValueOnce(new Error('details'));
    expect(await readPayerPurchases(A)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('lists a row recorded late on the UTC start date (JST early morning of the next day)', async () => {
    // 2026-09-23 05:00 JST の購入 = 2026-09-22T20:00Z。since を JST の日付 (09-23) で書くと消えていた。
    kv.kvLrange.mockResolvedValue({ ok: true, value: [row({ at: '2026-09-22T20:00:00.000Z' })] });
    const result = await readPayerPurchases(A);
    expect(result.ok).toBe(true);
    expect(result.ok && result.items).toHaveLength(1);
  });
});
