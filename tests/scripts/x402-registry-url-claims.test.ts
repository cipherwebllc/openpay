// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { inventoryUrlClaims, main } from '@/scripts/x402-registry-url-claims.mjs';
import { preflight, parseArgs } from '@/scripts/kv-restore.mjs';
import { isAllowedKey } from '@/scripts/lib/kv-backup-core.mjs';

const record = (id: string, extra = {}) => ({ id, url: 'https://example.com/' + id,
  merchant: 'merchant-' + id, payTo: 'recipient-' + id, active: true, createdAt: 1, ...extra });

describe('complete registry claim inventory', () => {
  it('DRY-RUN scans beyond 500, includes unindexed hidden/inactive records and only reads', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => record(String(i)));
    rows.push(record('hidden', { url: 'HTTPS://EXAMPLE.COM:443/0', hidden: true }));
    rows.push(record('deleted', { url: 'https://example.com/0', active: false }));
    const keys = rows.map((r) => 'x402:resource:' + r.id);
    const values = new Map(rows.map((r, i) => [keys[i], JSON.stringify(r)]));
    const command = vi.fn(async (args: (string | number)[]) => {
      if (args[0] === 'SCAN') return args[1] === '0' ? ['123', keys.slice(0, 500)]
        : ['0', [...keys.slice(500), keys[0], 'x402:resource:urlclaim:abc']];
      if (args[0] === 'GET') return values.get(String(args[1]));
      throw new Error('dry-run must not write');
    });
    const log = vi.fn();
    const summary = await inventoryUrlClaims({ command }, { log });
    expect(summary).toMatchObject({ mode: 'DRY-RUN', records: 503, duplicates: 1, conflicts: 1, candidates: 500, claimed: 0 });
    expect(command.mock.calls.filter(([args]) => args[0] === 'SCAN')).toHaveLength(2);
    expect(command.mock.calls.filter(([args]) => args[0] === 'GET')).toHaveLength(503);
    const duplicate = log.mock.calls.map(([line]) => JSON.parse(line)).find((entry) => entry.duplicate);
    expect(duplicate).toEqual({ duplicate: 'https://example.com/0', activeCount: 2, records: [
      { id: '0', merchant: 'merchant-0', recipient: 'recipient-0', active: true, hidden: false, createdAt: 1 },
      { id: 'hidden', merchant: 'merchant-hidden', recipient: 'recipient-hidden', active: true, hidden: true, createdAt: 1 },
      { id: 'deleted', merchant: 'merchant-deleted', recipient: 'recipient-deleted', active: false, hidden: false, createdAt: 1 },
    ] });
  });

  it('blocks all apply writes when a malformed record makes inventory incomplete', async () => {
    const command = vi.fn(async (args: (string | number)[]) => {
      if (args[0] === 'SCAN') return ['0', ['x402:resource:good', 'x402:resource:bad']];
      if (args[0] === 'GET') return args[1] === 'x402:resource:good' ? JSON.stringify(record('good')) : '{';
      throw new Error('incomplete inventory must not write');
    });
    expect(await inventoryUrlClaims({ command }, { apply: true, log: vi.fn() })).toMatchObject({
      blocked: true, invalid: ['x402:resource:bad'], candidates: 1, claimed: 0,
    });
  });

  it('uses existing KV REST env and transport without leaking REST failure details', async () => {
    const log = vi.fn(), error = vi.fn();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(['SCAN', '0', 'MATCH', 'x402:resource:*', 'COUNT', '200']);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return new Response(JSON.stringify({ result: [Buffer.from('0').toString('base64'), []] }));
    });
    const env = { KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'secret' };
    expect(await main([], { env, fetch: fetchMock as typeof fetch, log, error })).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('DRY-RUN');
    fetchMock.mockRejectedValueOnce(new Error('Bearer secret'));
    expect(await main([], { env, fetch: fetchMock as typeof fetch, log, error })).toBe(1);
    expect(error).toHaveBeenLastCalledWith('Registry URL claim inventory failed');
    expect(await main(['--unknown'], { env, fetch: fetchMock as typeof fetch, log, error })).toBe(1);
    expect(await main([], { env: {}, fetch: fetchMock as typeof fetch, log, error })).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('KV backup/restore allowlist excludes external resources and their claims', () => {
    // Registry hidden restoration is reverify; the standalone restore tool only
    // handles hosted/store namespaces. Fence that boundary so it cannot bypass CAS.
    for (const key of ['x402:resource:a', 'x402:resource:urlclaim:abc', 'x402:resources:index']) {
      expect(isAllowedKey(Buffer.from(key))).toBe(false);
      const result = preflight([{ k: key, t: 'string', s: JSON.stringify(record('a')), capturedAt: 0, expiresAt: null }], 1);
      expect(result.violations).toContainEqual({ rule: 'preflight', key, detail: 'out_of_scope_key' });
    }
    expect(() => parseArgs(['--file', 'test.enc', '--target-url', 'https://kv.example.com', '--target-name', 'drill', '--prefix', 'x402:resource:']))
      .toThrow('invalid_prefix');
  });
});
