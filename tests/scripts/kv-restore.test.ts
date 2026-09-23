// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareRecord, installCommand, main, parseArgs, preflight, RESTORE_LIMITS, runRestore } from '@/scripts/kv-restore.mjs';
import { createManifest, sha256, writeArchive, type BackupRecord } from '@/scripts/lib/kv-backup-core.mjs';

let dir: string, clock: number;
const env = { KV_BACKUP_KEY: 'ab'.repeat(32), KV_RESTORE_TARGET_TOKEN: 'SECRET_TARGET_TOKEN', USER: 'restore-operator' };
const rec = (k = 'store:k', extra: Partial<BackupRecord> = {}): BackupRecord => ({ k, t: 'string', ...(extra.t && extra.t !== 'string' ? {} : { s: '\uFEFFraw\u0000value' }), capturedAt: 100, expiresAt: null, ...extra });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'restore-test-')); clock = 1000; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function archive(records: BackupRecord[] = [rec()], host = 'source.test') {
  const file = join(dir, 'backup.enc');
  await writeArchive({ file, key: env.KV_BACKUP_KEY, records,
    manifest: createManifest({ name: '20260915T031700Z-r123-a1', host, startedAt: '2026-09-15T03:17:00Z' }), now: () => new Date('2026-09-15T03:18:00Z') });
  return file;
}
const options = () => ({ env, targetUrl: 'https://target.test', targetName: 'drill', reportDirectory: dir, now: () => clock });
type Command = (string | number)[];
function wire(value: unknown): unknown {
  if (typeof value === 'string') return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(wire);
  return value;
}
// Transport fake only. Actual Lua semantics have a separate real-Lua test suite.
function target(hook?: (cmd: Command, db: Map<string, BackupRecord>) => unknown) {
  const db = new Map<string, BackupRecord>(), commands: Command[] = [];
  const fetch = vi.fn(async (url: string, init: { body: string; headers: Record<string, string>; redirect: string }) => {
    expect(new URL(url).host).toBe('target.test');
    expect(url).not.toContain(env.KV_RESTORE_TARGET_TOKEN);
    expect(init.headers.Authorization).toBe(`Bearer ${env.KV_RESTORE_TARGET_TOKEN}`);
    expect(init.redirect).toBe('error');
    for (const [k, r] of db) if (r.expiresAt !== null && r.expiresAt! <= clock) db.delete(k);
    const batch = new URL(url).pathname !== '/';
    const argvs: Command[] = batch ? JSON.parse(init.body) : [JSON.parse(init.body)];
    const results = argvs.map((cmd) => {
      commands.push(cmd);
      const override = hook?.(cmd, db);
      if (override instanceof Error) return { error: override.message };
      if (override !== undefined) return { result: wire(override) };
      const key = String(cmd[1]), r = db.get(key);
      let result: unknown;
      switch (cmd[0]) {
        case 'DBSIZE': result = db.size; break;
        case 'TYPE': result = r?.t ?? 'none'; break;
        case 'EXISTS': result = r ? 1 : 0; break;
        case 'PTTL': result = !r ? -2 : r.expiresAt === null ? -1 : r.expiresAt! - clock; break;
        case 'GET': result = r?.s ?? null; break;
        case 'LLEN': result = r?.l?.length ?? 0; break;
        case 'SCARD': result = r?.m?.length ?? 0; break;
        case 'ZCARD': result = r?.z?.length ?? 0; break;
        case 'HLEN': result = r?.h?.length ?? 0; break;
        case 'LRANGE': result = r?.l ?? []; break;
        case 'SMEMBERS': result = r?.m ?? []; break;
        case 'ZRANGE': result = r?.z?.flat() ?? []; break;
        case 'HGETALL': result = r?.h?.flat() ?? []; break;
        case 'EVAL': {
          const k = String(cmd[3]), t = String(cmd[4]), ttl = Number(cmd[5]), data = cmd.slice(6).map(String);
          if (db.has(k)) { result = 'exists'; break; }
          const pairs: [string, string][] = [];
          for (let i = 0; i < data.length; i += 2) pairs.push([data[i], data[i + 1]]);
          db.set(k, { k, t, capturedAt: clock, expiresAt: ttl === -1 ? null : clock + ttl,
            ...(t === 'string' ? { s: data[0] } : t === 'list' ? { l: data } : t === 'set' ? { m: data }
              : t === 'hash' ? { h: pairs } : { z: pairs.map(([score, member]) => [member, String(Number(score))]) }) });
          result = 'applied'; break;
        }
        default: throw new Error('unexpected fake command');
      }
      return { result: wire(result) };
    });
    return new Response(JSON.stringify(batch ? results : results[0]));
  });
  return { db, commands, fetch };
}

describe('CLI contract', () => {
  const required = ['--file', 'backup.enc', '--target-url', 'https://target.test', '--target-name', 'drill'];
  it('keeps the packaged private-output helper shared with the DR script', async () => {
    const helper = resolve('packages/x402-mcp/src/privateOutput.mjs');
    for (const entry of ['scripts/kv-restore.mjs', 'packages/x402-mcp/scripts/steward-bootstrap.mjs']) {
      const source = await readFile(entry, 'utf8');
      const imported = source.match(/from '([^']*privateOutput\.mjs)'/);
      expect(imported).not.toBeNull();
      expect(resolve(dirname(entry), imported![1])).toBe(helper);
    }
    const manifest = JSON.parse(await readFile('packages/x402-mcp/package.json', 'utf8'));
    expect(manifest.files).toContain('src'); // The shared helper must also ship with bootstrap.
    expect(await readFile(helper, 'utf8')).toContain('export async function openPrivateOutput');
  });
  it('explains private report path refusals without exposing raw errors', async () => {
    const fake = target(), log = vi.fn(), error = vi.fn();
    expect(await main([...required, '--report', resolve('restore-report-forbidden.json')], { ...options(), fetch: fake.fetch, log, error })).toBe(1);
    expect(error).toHaveBeenLastCalledWith('KV restore failed: Private output must be outside a git repository');
    const existing = join(dir, 'existing.json');
    await writeFile(existing, 'previous');
    expect(await main([...required, '--report', existing], { ...options(), fetch: fake.fetch, log, error })).toBe(1);
    expect(error).toHaveBeenLastCalledWith('KV restore failed: Private output already exists; choose a new path');
    expect(await readFile(existing, 'utf8')).toBe('previous');
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it('requires explicit target/file/name and defaults to dry-run', () => {
    expect(parseArgs(required)).toEqual({ file: 'backup.enc', targetUrl: 'https://target.test', targetName: 'drill' });
    expect(parseArgs([...required, '--check', '--apply', '--prefix', 'store:own:']).apply).toBe(true);
    for (let i = 0; i < required.length; i += 2) expect(() => parseArgs(required.filter((_, j) => j !== i && j !== i + 1))).toThrow();
  });
  it.each([['--force'], ['--resume'], ['--token', 'SECRET'], ['--dry-run'], ['--apply', '--apply'], ['--file', 'other'], ['--prefix', ''], ['--prefix', 'store*'], ['--prefix', 'session:'], ['--prefix', 'store:license:worker:lock:']])('rejects unknown/contradictory/widening options %j', (...extra) => {
    expect(() => parseArgs([...required, ...extra])).toThrow();
  });
  it.each(['https://user:SECRET@target.test', 'https://target.test?token=SECRET', 'https://target.test/path', 'http://target.test', 'https://target.test#SECRET'])('rejects credential-bearing or non-REST URLs', (url) => {
    expect(() => parseArgs(['--file', 'f', '--target-url', url, '--target-name', 'drill'])).toThrow();
  });
});

describe('preflight all records before mutation', () => {
  it.each<[string, BackupRecord]>([
    ['unsupported_type', rec('store:bad', { t: 'stream' })],
    ['binary_unsupported', rec('store:bad', { s: { b: '/w==' } })],
    ['binary_unsupported', rec('store:bad', { t: 'list', l: [{ b: '/w==' }] })],
    ['binary_unsupported', rec('store:bad', { t: 'set', m: [{ b: '/w==' }] })],
    ['binary_unsupported', rec('store:bad', { t: 'hash', h: [[{ b: '/w==' }, 'v']] })],
    ['binary_unsupported', rec('store:bad', { t: 'hash', h: [['f', { b: '/w==' }]] })],
    ['binary_unsupported', rec('store:bad', { t: 'zset', z: [[{ b: '/w==' }, '1']] })],
    ['member_limit', rec('store:bad', { t: 'list', l: Array(10_001).fill('v') })],
    ['invalid_score', rec('store:bad', { t: 'zset', z: [['m', 'NaN']] })],
    ['invalid_score', rec('store:bad', { t: 'zset', z: [['m', ' ']] })],
    ['invalid_score', rec('store:bad', { t: 'zset', z: [['m', '1e999']] })],
    ['duplicate_key', rec()],
    ['invalid_expiry', rec('store:bad', { expiresAt: undefined })],
    ['empty_collection', rec('store:bad', { t: 'list', l: [] })],
    ['duplicate_member', rec('store:bad', { t: 'hash', h: [['f', 'a'], ['f', 'b']] })],
    ['invalid_utf8_argument', rec('store:bad', { s: '\ud800' })],
    ['out_of_scope_key', rec('session:bad')],
    ['request_bytes', rec('store:bad', { s: '\u0000'.repeat(600_000) })],
    ['capture_error', { k: 'store:bad', error: 'read_error' }],
  ])('%s rejects a later record, leaving the whole plan invalid', (detail, bad) => {
    const result = preflight([rec(), bad], clock);
    expect(result.violations).toContainEqual(expect.objectContaining({ detail }));
  });
  it('measures the complete JSON-encoded EVAL including script and escaping, at the boundary', () => {
    const overhead = Buffer.byteLength(JSON.stringify(installCommand(rec('store:k', { s: '' }), clock)));
    const max = rec('store:k', { s: 'a'.repeat(RESTORE_LIMITS.requestBytes - overhead) });
    expect(preflight([max], clock).violations).toEqual([]);
    expect(preflight([{ ...max, s: `${max.s}a` }], clock).violations[0].detail).toBe('request_bytes');
    expect(preflight([rec('store:z', { t: 'zset', z: [['a', '-inf'], ['b', '1e2']] })], clock).violations).toEqual([]);
  });
  it('skips past and exactly-now expiry; leaves null and future deadlines', () => {
    const result = preflight([rec('store:a', { expiresAt: clock - 1 }), rec('store:b', { expiresAt: clock }), rec('store:c', { expiresAt: clock + 1 }), rec()], clock);
    expect(result.expired).toEqual(['store:a', 'store:b']); expect(result.ready).toHaveLength(2);
  });
});

describe('restore execution with fake fetch', () => {
  it('defaults to a private temporary report outside the checkout', async () => {
    const fake = target();
    const result = await runRestore({ ...options(), reportDirectory: undefined, file: await archive(), fetch: fake.fetch });
    try {
      expect(result.exitCode).toBe(0);
      expect(resolve(result.reportPath).startsWith(resolve(process.cwd()) + sep)).toBe(false);
      expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(result.reportPath))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(result.reportPath, { force: true });
      if (basename(dirname(result.reportPath)).startsWith('openpay-kv-restore-')) await rm(dirname(result.reportPath), { recursive: true, force: true });
    }
  });
  it('accepts --report and rejects a repository destination before network requests', async () => {
    const fake = target();
    const file = await archive();
    const args = ['--file', file, '--target-url', 'https://target.test', '--target-name', 'drill', '--report', join(dir, 'chosen.json')];
    const parsed = parseArgs(args);
    const result = await runRestore({ ...options(), ...parsed, fetch: fake.fetch });
    expect(result.reportPath).toBe(join(dir, 'chosen.json'));
    expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
    fake.fetch.mockClear();
    await expect(runRestore({ ...options(), ...parseArgs([...args.slice(0, -1), resolve('restore-report-forbidden.json')]), fetch: fake.fetch })).rejects.toThrow();
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it('restores payer lists with remaining TTL and persistent bindings, skipping expired indexes', async () => {
    const payer = '0x' + '1'.repeat(40), owner = '0x' + '2'.repeat(40);
    const expiresAt = 100 + 400 * 24 * 60 * 60 * 1000;
    const records = [
      rec(`x402:settle:payer:${payer}`, { t: 'list', l: ['{"payer":"' + payer + '","resource":"https://example.test"}'], expiresAt }),
      rec(`agent:bound:${payer}`, { s: JSON.stringify({ owner, at: '2026-09-23T00:00:00Z' }) }),
      rec(`agent:owner:${owner}`, { s: JSON.stringify([payer]) }),
      rec('x402:settle:payer:expired', { t: 'list', l: ['expired'], expiresAt: clock }),
    ];
    const fake = target();
    const result = await runRestore({ ...options(), file: await archive(records), fetch: fake.fetch, apply: true });
    expect(result.exitCode).toBe(0);
    expect(result.report.results.applied).toEqual(records.slice(0, 3).map((r) => r.k));
    expect(result.report.results.expired_skipped).toEqual(['x402:settle:payer:expired']);
    for (const r of records.slice(0, 3)) expect(fake.db.get(String(r.k))).toMatchObject({ ...r, capturedAt: clock });
    expect(fake.commands.find((cmd) => cmd[0] === 'EVAL' && cmd[3] === records[0].k)?.[5]).toBe(String(expiresAt - clock));
  });
  it('dry-run performs archive/selection checks and DBSIZE but never writes', async () => {
    const fake = target(); const result = await runRestore({ ...options(), file: await archive(), fetch: fake.fetch });
    expect(result.exitCode).toBe(0); expect(result.report.status).toBe('dry_run');
    expect(fake.commands).toEqual([['DBSIZE']]); expect(result.report.checks.archive).not.toBeNull();
    expect(result.report.checks.selection).not.toBeNull(); expect(result.report.checks.target).toBeNull();
    expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(result.reportPath, 'utf8'))).toMatchObject({ operator: env.USER, mode: 'dry-run', archiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('installs all five types, preserves bytes and reads each back', async () => {
    const records = [rec(), rec('store:l', { t: 'list', l: ['b', 'a', 'b'] }), rec('store:m', { t: 'set', m: ['b', 'a'] }),
      rec('store:h', { t: 'hash', h: [['f', '\u0000秘密']] }), rec('store:z', { t: 'zset', z: [['a', '1.2500']] }), rec('store:ttl', { expiresAt: 10_123 })];
    const fake = target(); const result = await runRestore({ ...options(), file: await archive(records), apply: true, fetch: fake.fetch });
    expect(result.exitCode).toBe(0); expect(result.report.results.applied).toEqual(records.map((r) => r.k));
    expect(result.report.dbsize).toEqual({ start: 0, end: 6, expected: 6 });
    expect(result.report.checks.target?.summary.records).toBe(6);
    expect(fake.commands.filter((cmd) => cmd[0] === 'EVAL')).toHaveLength(6);
    expect(fake.db.get('store:ttl')?.expiresAt).toBe(10_123);
  });
  it('prefix narrows selection and graph violations are reported without blocking isolated installs', async () => {
    const fake = target();
    const result = await runRestore({ ...options(), file: await archive([rec('store:a'), rec('store:b'), rec('payment:claimed:1:tx')]), prefix: 'store:a', apply: true, fetch: fake.fetch });
    expect(result.report.results.applied).toEqual(['store:a']); expect(result.report.checks.archive?.summary.records).toBe(3);
    expect(result.report.checks.selection?.summary.records).toBe(1);
  });
  it.each(['binary', 'members', 'request_bytes', 'capture_error'])('preflight %s on the last key prevents every EVAL', async (kind) => {
    const bad = kind === 'binary' ? rec('store:bad', { s: { b: '/w==' } }) : kind === 'members' ? rec('store:bad', { t: 'list', l: Array(10_001).fill('v') })
      : kind === 'capture_error' ? { k: 'store:bad', error: 'read_error' } : rec('store:bad', { s: '\u0000'.repeat(600_000) });
    const fake = target(); const result = await runRestore({ ...options(), file: await archive([rec(), bad]), apply: true, fetch: fake.fetch });
    expect(result.report.failure).toBe('preflight_failed'); expect(fake.commands).toEqual([['DBSIZE']]);
    expect((await readFile(result.reportPath, 'utf8'))).not.toContain(env.KV_RESTORE_TARGET_TOKEN);
  });
  it('does not fall back to a backup token when the target token is missing', async () => {
    const fake = target();
    const result = await runRestore({ ...options(), env: { KV_BACKUP_KEY: env.KV_BACKUP_KEY, KV_BACKUP_REST_TOKEN: 'backup-only' }, file: await archive(), fetch: fake.fetch });
    expect(result.report.failure).toBe('missing_target_token'); expect(fake.fetch).not.toHaveBeenCalled();
  });
  it('rejects a nonempty DB even when its only key is outside the allowlist', async () => {
    const fake = target(); fake.db.set('session:other', rec('session:other'));
    const result = await runRestore({ ...options(), file: await archive(), apply: true, fetch: fake.fetch });
    expect(result.report.failure).toBe('target_not_empty'); expect(fake.commands).toEqual([['DBSIZE']]);
  });
  it('rejects archive source fingerprint and writes failure evidence', async () => {
    const fake = target(); const result = await runRestore({ ...options(), file: await archive([rec()], 'target.test'), apply: true, fetch: fake.fetch });
    expect(result.report.failure).toBe('source_target_same_host'); expect(fake.fetch).not.toHaveBeenCalled();
    expect(result.report.targetFingerprint).toBe(sha256('target.test').slice(0, 16));
  });
  it('rejects local backup host, including case, port and terminal-dot aliases', async () => {
    const fake = target(); const result = await runRestore({ ...options(), env: { ...env, KV_BACKUP_REST_URL: 'https://TARGET.test.:444/' }, file: await archive(), fetch: fake.fetch });
    expect(result.report.failure).toBe('backup_target_same_host'); expect(fake.fetch).not.toHaveBeenCalled();
  });
  it.each(['tag', 'wrong_key', 'truncated'])('rejects %s before any target request and saves a report', async (kind) => {
    const file = await archive(); const bytes = await readFile(file);
    if (kind === 'tag') { bytes[bytes.length - 1] ^= 1; await writeFile(file, bytes); }
    if (kind === 'truncated') await writeFile(file, bytes.subarray(0, 40));
    const fake = target(); const result = await runRestore({ ...options(), env: { ...env, KV_BACKUP_KEY: kind === 'wrong_key' ? 'cd'.repeat(32) : env.KV_BACKUP_KEY }, file, apply: true, fetch: fake.fetch });
    expect(result.exitCode).toBe(1); expect(fake.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(result.reportPath, 'utf8')).status).toBe('failed');
  });
  it('timeout with matching EXISTS+readback is classified without replay or writer attribution', async () => {
    const r = rec();
    const fake = target((cmd, db) => {
      if (cmd[0] === 'EVAL') { db.set(String(r.k), r); throw new DOMException('SECRET header', 'TimeoutError'); }
    });
    const result = await runRestore({ ...options(), file: await archive([r]), apply: true, fetch: fake.fetch });
    expect(result.exitCode).toBe(0); expect(result.report.results.timeout_verified_match).toEqual([r.k]);
    expect(result.report.results.applied).toEqual([]);
    expect(fake.commands.filter((c) => c[0] === 'EVAL')).toHaveLength(1);
    expect(fake.commands.findIndex((c) => c[0] === 'EXISTS')).toBeGreaterThan(fake.commands.findIndex((c) => c[0] === 'EVAL'));
  });
  it.each(['absent', 'mismatch', 'read_error'])('timeout %s is unverified, stops later writes and saves the report', async (kind) => {
    const fake = target((cmd, db) => {
      if (cmd[0] === 'EVAL') {
        if (kind !== 'absent') db.set('store:k', rec('store:k', { s: kind === 'mismatch' ? 'other' : 'value' }));
        throw new DOMException('private', 'AbortError');
      }
      if (kind === 'read_error' && cmd[0] === 'TYPE') return new Error('SECRET');
    });
    const result = await runRestore({ ...options(), file: await archive([rec(), rec('store:later')]), apply: true, fetch: fake.fetch });
    expect(result.report.results.timeout_unverified).toEqual(['store:k']); expect(result.exitCode).toBe(1);
    expect(fake.commands.filter((c) => c[0] === 'EVAL')).toHaveLength(1);
    const saved = await readFile(result.reportPath, 'utf8'); expect(saved).toContain('timeout_unverified'); expect(saved).not.toContain('SECRET');
  });
  it.each(['exists', 'lua_error'] as const)('mid-run %s records previous installs and does not write following keys', async (kind) => {
    const fake = target((cmd, db) => {
      if (cmd[0] === 'EVAL' && cmd[3] === 'store:bad') {
        db.set('store:bad', rec('store:bad', { s: 'partial' }));
        return kind === 'exists' ? 'exists' : new Error('secret signed transaction');
      }
    });
    const result = await runRestore({ ...options(), file: await archive([rec(), rec('store:bad'), rec('store:later')]), apply: true, fetch: fake.fetch });
    expect(result.exitCode).toBe(1); expect(result.report.results[kind]).toEqual(['store:bad']);
    expect(result.report.results.applied).toEqual(['store:k']); expect(fake.db.has('store:later')).toBe(false);
    expect(result.report.inFlight).toBe('store:bad');
    const saved = JSON.parse(await readFile(result.reportPath, 'utf8')); expect(saved.checks.target).not.toBeNull(); expect(saved.finishedAt).not.toBeNull();
  });
  it('readback mismatch is explicit, retains target observations for graph checking', async () => {
    const fake = target((cmd) => cmd[0] === 'GET' ? 'changed private value' : undefined);
    const result = await runRestore({ ...options(), file: await archive(), apply: true, fetch: fake.fetch });
    expect(result.report.results.mismatch).toEqual(['store:k']); expect(result.exitCode).toBe(1);
    expect(result.report.checks.target?.summary.records).toBe(1);
  });
  it('separates expired_skipped from expired_during_verify and compares final live DB size', async () => {
    const fake = target((cmd) => { if (cmd[0] === 'TYPE') clock = 2000; });
    const result = await runRestore({ ...options(), file: await archive([rec('store:past', { expiresAt: 1000 }), rec('store:short', { expiresAt: 1500 })]), apply: true, fetch: fake.fetch });
    expect(result.report.results.expired_skipped).toEqual(['store:past']);
    expect(result.report.results.expired_during_verify).toEqual(['store:short']);
    expect(result.report.dbsize).toEqual({ start: 0, end: 0, expected: 0 }); expect(result.exitCode).toBe(0);
  });
  it('classifies an earlier key that expires during later readbacks', async () => {
    const fake = target((cmd) => { if (cmd[0] === 'TYPE' && cmd[1] === 'store:later') clock = 2000; });
    const result = await runRestore({ ...options(), file: await archive([rec('store:short', { expiresAt: 1500 }), rec('store:later')]), apply: true, fetch: fake.fetch });
    expect(result.report.results.expired_during_verify).toEqual(['store:short']);
    expect(result.report.results.applied).toEqual(['store:later']); expect(result.exitCode).toBe(0);
  });
  it('an unreadable target is a mismatch and remains unverifiable in the target check', async () => {
    const fake = target((cmd) => cmd[0] === 'TYPE' ? new Error('read denied') : undefined);
    const result = await runRestore({ ...options(), file: await archive(), apply: true, fetch: fake.fetch });
    expect(result.report.results.mismatch).toEqual(['store:k']);
    expect(result.report.checks.target?.unverifiable).toContainEqual({ rule: 'record', key: 'store:k', detail: 'capture_error' });
    expect(result.exitCode).toBe(1);
  });
  it('records graph violations on all three stages without blocking the isolated restore', async () => {
    const key = `x402:hosted:h_${'1'.repeat(32)}`;
    const fake = target();
    const result = await runRestore({ ...options(), file: await archive([rec(key, { s: JSON.stringify({ id: `h_${'2'.repeat(32)}`, contentRevision: 1 }) })]), apply: true, fetch: fake.fetch });
    expect(result.exitCode).toBe(0);
    for (const check of Object.values(result.report.checks)) expect(check?.violations.some((v) => v.rule === 'identity')).toBe(true);
    expect(result.report.quarantine_candidates).toContain(key);
  });
  it('detects extra keys from another writer at the final DBSIZE', async () => {
    let sizes = 0;
    const fake = target((cmd, db) => { if (cmd[0] === 'DBSIZE' && ++sizes === 2) db.set('foreign:k', rec('foreign:k')); });
    const result = await runRestore({ ...options(), file: await archive(), apply: true, fetch: fake.fetch });
    expect(result.report.failure).toBe('final_dbsize_mismatch');
  });
  it('reserves a private report before writing and refuses to overwrite previous evidence', async () => {
    const fake = target(); const file = await archive();
    // The report name carries the run's UTC timestamp, so a dry-run and an apply for the same
    // target name never collide; an identical clock reproduces the same name and must be refused.
    const name = `restore-report-drill-${new Date(clock).toISOString().replace(/[-:]|\.\d{3}/g, '')}.json`;
    await writeFile(join(dir, name), 'previous');
    await expect(runRestore({ ...options(), file, apply: true, fetch: fake.fetch })).rejects.toThrow();
    expect(fake.fetch).not.toHaveBeenCalled(); expect(await readFile(join(dir, name), 'utf8')).toBe('previous');
  });
  it('console output cannot leak values, target URLs, tokens or server errors', async () => {
    const file = await archive(); const log = vi.fn(), error = vi.fn();
    const fake = target((cmd) => cmd[0] === 'EVAL' ? new Error('private value SECRET_TARGET_TOKEN') : undefined);
    expect(await main(['--file', file, '--target-url', 'https://target.test', '--target-name', 'drill', '--apply'], { ...options(), fetch: fake.fetch, log, error })).toBe(1);
    const output = JSON.stringify([log.mock.calls, error.mock.calls]);
    for (const value of ['private', 'SECRET_TARGET_TOKEN', 'target.test', 'store:k', 'raw']) expect(output).not.toContain(value);
  });
});

describe('readback comparison', () => {
  it('compares raw bytes, list order, sets/hash order independently, and scores numerically', () => {
    expect(compareRecord(rec(), rec('store:k', { s: 'raw\u0000value' }), clock)).toBe('mismatch');
    expect(compareRecord(rec('store:l', { t: 'list', l: ['a', 'b'] }), rec('store:l', { t: 'list', l: ['b', 'a'] }), clock)).toBe('mismatch');
    expect(compareRecord(rec('store:s', { t: 'set', m: ['a', 'b'] }), rec('store:s', { t: 'set', m: ['b', 'a'] }), clock)).toBe('match');
    expect(compareRecord(rec('store:h', { t: 'hash', h: [['f', '1'], ['g', '2']] }), rec('store:h', { t: 'hash', h: [['g', '2'], ['f', '1']] }), clock)).toBe('match');
    expect(compareRecord(rec('store:z', { t: 'zset', z: [['a', '1.000'], ['b', '+inf']] }), rec('store:z', { t: 'zset', z: [['b', 'inf'], ['a', '1']] }), clock)).toBe('match');
    expect(compareRecord(rec('store:z', { t: 'zset', z: [['a', '1']] }), rec('store:z', { t: 'zset', z: [['a', '2']] }), clock)).toBe('mismatch');
  });
  it('enforces TTL ±5s and never confuses persistent/missing/expired', () => {
    const r = rec('store:k', { expiresAt: 10_000 });
    expect(compareRecord(r, { ...r, expiresAt: 15_000 }, clock)).toBe('match');
    expect(compareRecord(r, { ...r, expiresAt: 15_001 }, clock)).toBe('mismatch');
    expect(compareRecord(r, rec(), clock)).toBe('mismatch');
    expect(compareRecord(rec(), r, clock)).toBe('mismatch');
    const missing = { k: r.k, error: 'missing_during_capture' };
    expect(compareRecord(r, missing, 9999)).toBe('mismatch');
    expect(compareRecord(r, missing, 10_000)).toBe('expired_during_verify');
    expect(compareRecord(rec(), missing, 10_000)).toBe('mismatch');
  });
});
