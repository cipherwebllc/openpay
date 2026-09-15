#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { BackupError, LIMITS, PREFIXES, byteText, cleanupStaging, decryptToStaging,
  isAllowedKey, restoreBytes, sha256, verifyJsonl } from './lib/kv-backup-core.mjs';
import { createUpstashClient, UpstashCommandError, UpstashTimeoutError } from './lib/upstash-rest.mjs';
import { fileDigest } from './lib/r2.mjs';
import { captureKey } from './kv-backup.mjs';
import { checkRecords } from './lib/kv-restore-check.mjs';

export const RESTORE_LIMITS = Object.freeze({ requestBytes: 3 * 1024 * 1024, members: 10_000, ttlToleranceMs: 5000 });
const FIELDS = { string: 's', list: 'l', set: 'm', zset: 'z', hash: 'h' };
const CATEGORIES = ['applied', 'exists', 'lua_error', 'timeout_verified_match', 'timeout_unverified',
  'expired_skipped', 'expired_during_verify', 'mismatch'];

// Every key is installed by one EVAL. Redis errors do NOT roll back earlier calls.
// ARGV = type, relative TTL (-1 = persistent), then raw UTF-8 arguments; no cjson round trip.
export const INSTALL_LUA = `
if redis.call('EXISTS',KEYS[1])==1 then return 'exists' end
local unpack=unpack or table.unpack
local kind=ARGV[1]
local ttl=tonumber(ARGV[2])
if kind=='string' then
  redis.call('SET',KEYS[1],ARGV[3])
else
  local command
  if kind=='list' then command='RPUSH'
  elseif kind=='set' then command='SADD'
  elseif kind=='zset' then command='ZADD'
  elseif kind=='hash' then command='HSET'
  else return redis.error_reply('unsupported_type') end
  for first=3,#ARGV,1000 do
    redis.call(command,KEYS[1],unpack(ARGV,first,math.min(first+999,#ARGV)))
  end
end
if ttl~=-1 then redis.call('PEXPIRE',KEYS[1],ARGV[2]) end
return 'applied'
`;

class RestoreError extends Error {
  constructor(code) { super(`KV restore ${code}`); this.code = code; }
}
function endpointHost(url) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new RestoreError('invalid_target_url'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['', '/'].includes(endpoint.pathname)) throw new RestoreError('invalid_target_url');
  // URL canonicalizes case/default ports. DNS terminal dots name the same host too.
  return endpoint.hostname.replace(/\.$/, '').toLowerCase();
}
function validateOptions(options) {
  if (typeof options.file !== 'string' || !options.file || typeof options.targetUrl !== 'string'
    || typeof options.targetName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(options.targetName)) throw new RestoreError('invalid_arguments');
  endpointHost(options.targetUrl);
  if (options.prefix !== undefined && (typeof options.prefix !== 'string' || !PREFIXES.some((prefix) => options.prefix.startsWith(prefix))
    || !isAllowedKey(options.prefix) || /[\u0000-\u0020*?\[\]]/.test(options.prefix))) throw new RestoreError('invalid_prefix');
}
export function parseArgs(args) {
  const options = {}, seen = new Set();
  const names = { '--file': 'file', '--target-url': 'targetUrl', '--target-name': 'targetName', '--prefix': 'prefix' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new RestoreError('invalid_arguments');
    seen.add(arg);
    if (arg === '--apply' || arg === '--check') options[arg.slice(2)] = true;
    else if (Object.hasOwn(names, arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[names[arg]] = args[++i];
    else throw new RestoreError('invalid_arguments');
  }
  validateOptions(options);
  return options; // --check is explicit documentation of the mandatory checks; it never disables them.
}

async function readArchive(file, key) {
  const staging = await decryptToStaging(file, key);
  const input = createReadStream(staging), gunzip = createGunzip(), records = [];
  const pumping = pipeline(input, gunzip);
  pumping.catch(() => {});
  async function* collect() {
    let pending = Buffer.alloc(0), first = true;
    for await (const chunk of gunzip) {
      // The core verifier consumes/bounds each chunk before records become available to callers.
      yield chunk;
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const line = Buffer.concat([pending, chunk.subarray(start, end)]);
        const value = JSON.parse(line.toString('utf8'));
        if (!first && !value.end) records.push(value);
        first = false;
        pending = Buffer.alloc(0);
        start = end + 1;
      }
      pending = Buffer.concat([pending, chunk.subarray(start)]);
    }
  }
  try {
    const summary = await verifyJsonl(collect());
    await pumping;
    return { ...summary, records };
  } catch (error) {
    input.destroy(); gunzip.destroy(); await pumping.catch(() => {});
    throw error instanceof BackupError ? error : new RestoreError('invalid_gzip');
  } finally { await cleanupStaging(staging); }
}

export function installCommand(record, now) {
  const ttl = record.expiresAt === null ? '-1' : String(record.expiresAt - now);
  const data = record[FIELDS[record.t]];
  const args = record.t === 'string' ? [data] : record.t === 'zset' ? data.flatMap(([member, score]) => [score, member])
    : record.t === 'hash' ? data.flat() : data;
  return ['EVAL', INSTALL_LUA, 1, record.k, record.t, ttl, ...args];
}
const scoreNumber = (score) => /^\+?inf$/.test(score) ? Infinity : score === '-inf' ? -Infinity : Number(score);
const validScore = (score) => typeof score === 'string' && (/^[+-]?inf$/.test(score)
  || (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(score) && Number.isFinite(Number(score))));

export function preflight(records, now) {
  const violations = [], expired = [], ready = [], seen = new Set();
  for (const record of records) {
    const key = record.k, fail = (detail) => violations.push({ rule: 'preflight', key, detail });
    let id;
    try { id = restoreBytes(key).toString('base64'); } catch { fail('invalid_key'); continue; }
    if (seen.has(id)) fail('duplicate_key');
    seen.add(id);
    if (typeof key !== 'string') fail('binary_unsupported');
    if (!isAllowedKey(restoreBytes(key))) fail('out_of_scope_key');
    if (record.error) { fail('capture_error'); continue; }
    if (!Object.hasOwn(FIELDS, record.t)) { fail('unsupported_type'); continue; }
    if (record.expiresAt !== null && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0)) { fail('invalid_expiry'); continue; }
    if (record.expiresAt !== null && record.expiresAt <= now) { expired.push(key); continue; }
    const before = violations.length, data = record[FIELDS[record.t]];
    const byte = (value) => {
      if (typeof value !== 'string') fail(value && typeof value.b === 'string' ? 'binary_unsupported' : 'invalid_value');
      // JSON permits lone surrogates; REST's UTF-8 encoder cannot preserve them.
      if (typeof value === 'string' && Buffer.from(value).toString('utf8') !== value) fail('invalid_utf8_argument');
    };
    byte(key);
    if (record.t === 'string') byte(data);
    else if (!Array.isArray(data)) fail('invalid_collection');
    else {
      if (!data.length) fail('empty_collection'); // Redis has no persistent empty collection key.
      if (data.length > RESTORE_LIMITS.members) fail('member_limit');
      const members = new Set();
      for (const item of data) {
        let member = item;
        if (record.t === 'hash' || record.t === 'zset') {
          if (!Array.isArray(item) || item.length !== 2) { fail('invalid_pair'); continue; }
          member = item[0];
          if (record.t === 'hash') byte(item[1]);
          else if (!validScore(item[1])) fail('invalid_score');
        }
        byte(member);
        if (record.t !== 'list' && members.has(member)) fail('duplicate_member');
        members.add(member);
      }
    }
    if (violations.length === before) {
      if (Buffer.byteLength(JSON.stringify(installCommand(record, now))) > RESTORE_LIMITS.requestBytes) fail('request_bytes');
      else ready.push(record);
    }
  }
  return { violations, expired, ready };
}

export function compareRecord(expected, actual, now) {
  if (actual?.error === 'missing_during_capture') return expected.expiresAt !== null && expected.expiresAt <= now ? 'expired_during_verify' : 'mismatch';
  if (!actual || actual.error || expected.t !== actual.t) return 'mismatch';
  if (expected.expiresAt === null ? actual.expiresAt !== null
    : actual.expiresAt === null || Math.abs(expected.expiresAt - actual.expiresAt) > RESTORE_LIMITS.ttlToleranceMs) return 'mismatch';
  const bytes = (value) => restoreBytes(value).toString('base64');
  const data = (r) => {
    if (r.t === 'string') return bytes(r.s);
    if (r.t === 'list') return r.l.map(bytes);
    if (r.t === 'set') return r.m.map(bytes).sort();
    if (r.t === 'hash') return r.h.map(([field, value]) => [bytes(field), bytes(value)]).sort(([a], [b]) => a.localeCompare(b));
    return r.z.map(([member, score]) => [bytes(member), String(scoreNumber(score))]).sort(([a], [b]) => a.localeCompare(b));
  };
  return JSON.stringify(data(expected)) === JSON.stringify(data(actual)) ? 'match' : 'mismatch';
}
async function readback(client, record, now) {
  // Reuse Task A's byte-preserving, typed reads. The target is isolated, so 10k members
  // can be read atomically within the existing 4MiB response budget whenever possible.
  try {
    const type = byteText(await client.command(['TYPE', record.k]));
    return await captureKey(client, Buffer.from(record.k), type, {
      now, limits: { ...LIMITS, fullCollectionMax: RESTORE_LIMITS.members, fullCollectionBytes: LIMITS.reqBytes },
    });
  } catch {
    // Preserve an unreadable target as unknown; a read failure must not become successful equality.
    return { k: record.k, error: 'read_error' };
  }
}
const safeCode = (error) => error instanceof RestoreError || error instanceof BackupError ? error.code : 'operation_failed';

export async function runRestore({ env = process.env, fetch = globalThis.fetch, now = Date.now, reportDirectory = process.cwd(),
  timeoutMs = 30_000, ...options } = {}) {
  validateOptions(options);
  const stamp = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const reportPath = join(resolve(reportDirectory), `restore-report-${options.targetName}-${stamp}.json`);
  // Reserve the report before any network mutation; never overwrite an earlier drill's evidence
  // (dry-run and apply for the same target name naturally get distinct files).
  const handle = await open(reportPath, 'wx', 0o600);
  const report = { v: 1, archiveDigest: null, archiveName: null, targetFingerprint: sha256(endpointHost(options.targetUrl)).slice(0, 16),
    targetName: options.targetName, mode: options.apply ? 'apply' : 'dry-run', operator: env.USER ?? null,
    startedAt: new Date(now()).toISOString(), finishedAt: null, status: 'running', failure: null, inFlight: null,
    results: Object.fromEntries(CATEGORIES.map((category) => [category, []])),
    checks: { archive: null, selection: null, target: null }, preflight: null, uncertain: [], quarantine_candidates: [],
    dbsize: { start: null, end: null, expected: null }, counts: {} };
  async function checkpoint() {
    report.counts = Object.fromEntries(CATEGORIES.map((category) => [category, report.results[category].length]));
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    await handle.sync();
  }
  let client, selected = [], attempted = false;
  const observed = new Map(), installed = [], attemptedRecords = [], verified = new Set(), incomplete = new Set();
  async function verifyInstalled(r, category) {
    const actual = await readback(client, r, now);
    const comparison = compareRecord(r, actual, now());
    if (actual.error !== 'missing_during_capture') observed.set(r.k, actual);
    else observed.delete(r.k);
    if (comparison !== 'match') {
      report.results[category] = report.results[category].filter((key) => key !== r.k);
      report.results[comparison].push(r.k);
    }
    verified.add(r.k);
  }
  function checkTarget() {
    if (!attempted) return;
    for (const r of selected) if (!observed.has(r.k)) {
      const m = typeof r.k === 'string' && r.k.match(/^x402:hosted:(h_[0-9a-f]{32}):license:reservation:/);
      if (m) incomplete.add(m[1]);
    }
    report.checks.target = checkRecords([...observed.values()], { incompleteReservationProducts: [...incomplete] });
  }
  try {
    await checkpoint();
    report.archiveDigest = (await fileDigest(options.file)).sha256;
    const archive = await readArchive(options.file, env.KV_BACKUP_KEY);
    report.archiveName = archive.manifest.name;
    report.checks.archive = checkRecords(archive.records);
    report.uncertain = archive.records.filter((r) => r.uncertain).map((r) => r.k);
    const selectionTime = now();
    selected = archive.records.filter((r) => {
      const key = restoreBytes(r.k);
      if (options.prefix && !key.subarray(0, Buffer.byteLength(options.prefix)).equals(Buffer.from(options.prefix))) return false;
      if (!r.error && r.expiresAt !== null && r.expiresAt <= selectionTime) { report.results.expired_skipped.push(r.k); return false; }
      return true;
    });
    const selectedKeys = new Set(selected.map((r) => JSON.stringify(r.k)));
    for (const r of archive.records) if (!selectedKeys.has(JSON.stringify(r.k))) {
      const m = typeof r.k === 'string' && r.k.match(/^x402:hosted:(h_[0-9a-f]{32}):license:reservation:/);
      if (m) incomplete.add(m[1]);
    }
    report.checks.selection = checkRecords(selected, { incompleteReservationProducts: [...incomplete] });
    const targetHost = endpointHost(options.targetUrl);
    const sourceFingerprints = [targetHost, new URL(options.targetUrl).host].map((host) => sha256(host).slice(0, 16));
    if (sourceFingerprints.includes(archive.manifest.source.hostSha256Hex16)) throw new RestoreError('source_target_same_host');
    if (env.KV_BACKUP_REST_URL && endpointHost(env.KV_BACKUP_REST_URL) === targetHost) throw new RestoreError('backup_target_same_host');
    if (!env.KV_RESTORE_TARGET_TOKEN) throw new RestoreError('missing_target_token');
    client = createUpstashClient({ url: options.targetUrl, token: env.KV_RESTORE_TARGET_TOKEN, fetch, timeoutMs });
    report.dbsize.start = await client.command(['DBSIZE']);
    if (report.dbsize.start !== 0) throw new RestoreError('target_not_empty');
    const plan = preflight(selected, now());
    report.preflight = { violations: plan.violations, ready: plan.ready.length };
    report.results.expired_skipped.push(...plan.expired);
    if (plan.violations.length) throw new RestoreError('preflight_failed');
    await checkpoint();
    if (!options.apply) { report.status = 'dry_run'; return { reportPath, report, exitCode: 0 }; }
    attempted = true;
    for (const r of plan.ready) {
      const sendTime = now();
      if (r.expiresAt !== null && r.expiresAt <= sendTime) { report.results.expired_skipped.push(r.k); continue; }
      report.inFlight = r.k;
      await checkpoint(); // A forced process kill leaves the possibly partial key identifiable.
      const command = installCommand(r, sendTime);
      attemptedRecords.push(r);
      let result;
      try { result = byteText(await client.command(command)); }
      catch (error) {
        if (error instanceof UpstashTimeoutError) {
          let actual, comparison;
          try {
            if (await client.command(['EXISTS', r.k]) === 1) {
              actual = await readback(client, r, now); comparison = compareRecord(r, actual, now());
              if (!actual.error) observed.set(r.k, actual);
            }
          } catch { /* A read failure cannot turn an uncertain write into a successful restore. */ }
          if (comparison === 'match') {
            report.results.timeout_verified_match.push(r.k); installed.push([r, 'timeout_verified_match']);
            report.inFlight = null; await checkpoint(); continue;
          }
          report.results.timeout_unverified.push(r.k);
          throw new RestoreError('timeout_unverified');
        }
        if (error instanceof UpstashCommandError) report.results.lua_error.push(r.k);
        else report.results.timeout_unverified.push(r.k); // Network/HTTP failure cannot prove absence of a write.
        throw new RestoreError(error instanceof UpstashCommandError ? 'lua_error' : 'write_unverified');
      }
      if (result === 'exists') { report.results.exists.push(r.k); throw new RestoreError('key_exists'); }
      if (result !== 'applied') { report.results.lua_error.push(r.k); throw new RestoreError('unexpected_lua_result'); }
      report.results.applied.push(r.k); installed.push([r, 'applied']);
      report.inFlight = null;
      await checkpoint();
    }
    for (const [r, category] of installed) {
      await verifyInstalled(r, category);
      await checkpoint();
    }
    // Earlier reads may have expired while later keys were being verified.
    for (const [r, category] of installed) if (r.expiresAt !== null && r.expiresAt <= now() && report.results[category].includes(r.k)) {
      await verifyInstalled(r, category);
    }
    checkTarget();
    report.dbsize.end = await client.command(['DBSIZE']);
    // Count installs still present, including content-confirmed timeouts (no writer attribution).
    report.dbsize.expected = report.results.applied.length + report.results.timeout_verified_match.length;
    if (report.dbsize.end !== report.dbsize.expected) throw new RestoreError('final_dbsize_mismatch');
    if (report.results.mismatch.length) throw new RestoreError('readback_mismatch');
    report.status = 'restored';
    return { reportPath, report, exitCode: 0 };
  } catch (error) {
    report.status = 'failed'; report.failure = safeCode(error);
    if (attempted) {
      // Failure evidence includes partial Lua writes and earlier installs, without resuming writes.
      for (const [r, category] of installed) if (!verified.has(r.k)) await verifyInstalled(r, category);
      for (const r of attemptedRecords) if (!observed.has(r.k) && !verified.has(r.k)) {
        const actual = await readback(client, r, now);
        if (actual.error !== 'missing_during_capture') observed.set(r.k, actual);
      }
      report.dbsize.expected = report.results.applied.length + report.results.timeout_verified_match.length;
      try { report.dbsize.end = await client.command(['DBSIZE']); } catch { /* The failed report retains an unknown end size. */ }
    }
    return { reportPath, report, exitCode: 1 };
  } finally {
    checkTarget();
    report.quarantine_candidates = [...new Set(Object.values(report.checks).flatMap((check) => check?.summary.quarantine_candidates ?? []))];
    report.finishedAt = new Date(now()).toISOString();
    try { await checkpoint(); } finally { await handle.close(); }
  }
}

export async function main(args = process.argv.slice(2), { env = process.env, log = console.log, error = console.error, ...dependencies } = {}) {
  try {
    const result = await runRestore({ ...dependencies, ...parseArgs(args), env });
    // Closed output: no values, keys, URLs, credentials, or server-provided error strings.
    log(JSON.stringify({ status: result.report.status, counts: result.report.counts, failure: result.report.failure }));
    return result.exitCode;
  } catch { error('KV restore failed'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
