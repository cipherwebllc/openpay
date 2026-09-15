// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { main, validateMeta, watchBackups } from '@/scripts/kv-backup-watch.mjs';
import { archiveIdentity } from '@/scripts/kv-backup.mjs';
import { createManifest, createMeta } from '@/scripts/lib/kv-backup-core.mjs';
import { createR2Client } from '@/scripts/lib/r2.mjs';
import { createHash } from 'node:crypto';
const now = new Date('2026-09-15T12:00:00Z');
function metaAt(finished: Date, partial = false, attempt = 1) {
  const identity = archiveIdentity({ GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: String(attempt) }, finished);
  const meta = createMeta({ manifest: createManifest({ name: identity.name, host: 'private-host', startedAt: finished.toISOString() }),
    footer: { keys: 1, errors: partial ? 1 : 0, uncertain: 0, status: partial ? 'partial' : 'complete', finishedAt: finished.toISOString() },
    archiveKey: identity.archiveKey, digest: { size: 123, sha256: 'a'.repeat(64) }, run: identity.run });
  return { key: identity.metaKey, meta };
}
function fake(entries: ReturnType<typeof metaAt>[], { missing = '', listFailure = false, extra = [] as string[] } = {}) {
  const keys = entries.flatMap(({ key, meta }) => [key, meta.archiveKey]).concat(extra).filter((key) => key !== missing);
  const listObjects = vi.fn(async (prefix: string) => {
    if (listFailure) throw new Error('listing SECRET failed');
    return keys.filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 123 }));
  });
  const paths: string[] = [];
  const getObjectToFile = vi.fn(async (key: string, file: string) => {
    paths.push(file);
    await writeFile(file, JSON.stringify(entries.find((entry) => entry.key === key)!.meta));
    return { size: 123, md5: 'a'.repeat(32), sha256: 'b'.repeat(64) };
  });
  const headObject = vi.fn(async (key: string) => {
    if (!keys.includes(key)) throw new Error('not found');
    return { size: 123, md5: 'a'.repeat(32) };
  });
  return { r2: { listObjects, getObjectToFile, headObject }, paths };
}

describe('KV backup watch', () => {
  it('accepts exactly 26h, fails one ms older and never lets partial advance freshness', async () => {
    const boundary = new Date(now.getTime() - 26 * 3600000);
    expect((await watchBackups({ ...fake([metaAt(boundary)]), now })).ageMs).toBe(26 * 3600000);
    const stale = metaAt(new Date(boundary.getTime() - 1));
    await expect(watchBackups({ ...fake([metaAt(now, true), stale]), now })).rejects.toThrow('stale_complete_backup');
    await expect(watchBackups({ ...fake([metaAt(now, true)]), now })).rejects.toThrow('stale_complete_backup');
  });
  it('GETs newest first, selects latest complete capture timestamp and cleans local metadata', async () => {
    const old = metaAt(new Date(now.getTime() - 20 * 3600000)), latest = metaAt(new Date(now.getTime() - 1000)), partial = metaAt(now, true);
    const fixture = fake([old, latest, partial]);
    const result = await watchBackups({ r2: fixture.r2, now });
    expect(result.completeFinishedAt).toBe(latest.meta.capture.finishedAt);
    expect(fixture.r2.getObjectToFile.mock.calls.map((call) => call[0])).toEqual([partial.key, latest.key, old.key]);
    expect(fixture.r2.headObject).toHaveBeenCalledTimes(6);
    for (const file of fixture.paths) await expect(readFile(file)).rejects.toThrow();
  });
  it.each(['archive', 'meta'])('detects missing %s in newest three, including archive-only identities', async (side) => {
    const recent = metaAt(now), old = metaAt(new Date(now.getTime() - 1000));
    const missing = side === 'archive' ? recent.meta.archiveKey : recent.key;
    await expect(watchBackups({ ...fake([recent, old], { missing }), now })).rejects.toThrow('not found');
  });
  it('checks only the newest three object pairs', async () => {
    const entries = Array.from({ length: 4 }, (_, i) => metaAt(new Date(now.getTime() - i * 1000)));
    const fixture = fake(entries, { missing: entries[3].meta.archiveKey });
    await expect(watchBackups({ r2: fixture.r2, now })).resolves.toMatchObject({ metaCount: 4 });
    expect(fixture.r2.headObject).toHaveBeenCalledTimes(6);
  });
  it('fails no-meta/list failure, malformed metadata, and archive size mismatch', async () => {
    for (const fixture of [fake([]), fake([metaAt(now)], { listFailure: true }), fake([], { extra: [metaAt(now).meta.archiveKey] })]) {
      const error = vi.fn();
      expect(await main([], { r2: fixture.r2, now, log: vi.fn(), error })).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('::error::'));
      expect(JSON.stringify(error.mock.calls)).not.toContain('SECRET');
    }
    const entry = metaAt(now);
    expect(() => validateMeta({ ...entry.meta, status: 'complete', counts: { keys: 1, errors: 1, uncertain: 0 } }, entry.key)).toThrow('invalid_meta');
    const invalid = fake([entry]); invalid.r2.headObject.mockResolvedValue({ size: 124, md5: 'a'.repeat(32) });
    await expect(watchBackups({ r2: invalid.r2, now })).rejects.toThrow('archive_size_mismatch');
  });
  it('lists previous year in January only, using UTC and accepting December freshness', async () => {
    const january = new Date('2027-01-01T01:00:00Z');
    const fixture = fake([metaAt(new Date('2026-12-31T23:00:00Z'))]);
    expect((await watchBackups({ r2: fixture.r2, now: january })).ageMs).toBe(2 * 3600000);
    expect(fixture.r2.listObjects.mock.calls).toEqual([['openpay-kv/2027/'], ['openpay-kv/2026/']]);
    const september = fake([metaAt(now)]); await watchBackups({ r2: september.r2, now });
    expect(september.r2.listObjects.mock.calls).toEqual([['openpay-kv/2026/']]);
  });
  it('integrates paginated real R2 client List/GET/HEAD with fake fetch', async () => {
    const entry = metaAt(now);
    const bytes = Buffer.from(JSON.stringify(entry.meta));
    const md5 = createHash('md5').update(bytes).digest('hex');
    const fetch = vi.fn(async (urlString: string, init: { method: string }) => {
      const url = new URL(urlString);
      if (url.searchParams.has('list-type')) {
        return new Response(url.searchParams.has('continuation-token')
          ? `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${entry.key}</Key><Size>${bytes.length}</Size></Contents></ListBucketResult>`
          : `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>${entry.meta.archiveKey}</Key><Size>123</Size></Contents><NextContinuationToken>page/+==</NextContinuationToken></ListBucketResult>`);
      }
      const isMeta = url.pathname.endsWith('.meta.json');
      return new Response(init.method === 'GET' ? bytes : null, { headers: { ETag: `"${isMeta ? md5 : 'a'.repeat(32)}"`, 'Content-Length': String(isMeta ? bytes.length : 123) } });
    });
    const r2 = createR2Client({ env: { R2_ACCOUNT_ID: 'account', R2_BUCKET: 'backup', R2_ACCESS_KEY_ID: 'ACCESS', R2_SECRET_ACCESS_KEY: 'SECRET' }, fetch });
    const log = vi.fn();
    expect(await main([], { r2, now, log, error: vi.fn() })).toBe(0);
    expect(fetch.mock.calls).toHaveLength(5);
    expect(log.mock.calls[0][0]).toContain('"metaCount":1');
  });
});
