#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackupError, LIMITS, PREFIXES, byteText, createManifest, createMeta, createRecord,
  isAllowedKey, parseKey, representBytes, verifyArchive, writeArchive } from './lib/kv-backup-core.mjs';
import { createUpstashClient, UpstashLimitError } from './lib/upstash-rest.mjs';
import { createR2Client, fileDigest } from './lib/r2.mjs';

const LENGTH = { list: 'LLEN', set: 'SCARD', zset: 'ZCARD', hash: 'HLEN' };
class TypeChanged extends Error {
  constructor(type) { super('type_changed'); this.type = type; }
}
class CaptureError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const smaller = (size, min) => Math.max(min, Math.floor(size / 2));
const identity = (bytes) => Buffer.from(bytes).toString('base64');

export async function scanKeys(client, limits = LIMITS) {
  const keys = new Map();
  for (const prefix of PREFIXES) {
    let cursor = '0', count = 500;
    const cursors = new Set();
    while (true) {
      let page;
      try { page = await client.command(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', count]); }
      catch (error) {
        if (error instanceof UpstashLimitError && count > limits.minChunk) { count = smaller(count, limits.minChunk); continue; }
        throw error; // Incomplete enumeration must never produce a complete heartbeat.
      }
      if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) throw new BackupError('invalid_scan');
      const next = byteText(page[0]);
      if (!/^\d+$/.test(next) || (next !== '0' && cursors.has(next))) throw new BackupError('invalid_scan_cursor');
      if (next !== '0') cursors.add(next);
      for (const key of page[1]) {
        if (!(key instanceof Uint8Array)) throw new BackupError('invalid_scan_key');
        if (isAllowedKey(key)) keys.set(identity(key), key);
        if (keys.size > limits.lines - 2) throw new BackupError('key_limit');
      }
      cursor = next;
      if (cursor === '0') break;
    }
  }
  return [...keys.values()];
}

export async function probeTypes(client, keys, limits = LIMITS) {
  const types = new Map();
  const readable = [];
  for (const key of keys) {
    try { readable.push([key, byteText(key)]); }
    catch { types.set(identity(key), new CaptureError('read_error')); }
  }
  let offset = 0, count = 500;
  while (offset < readable.length) {
    const batch = readable.slice(offset, offset + count);
    let response;
    try { response = await client.pipeline(batch.map(([, key]) => ['TYPE', key])); }
    catch (error) {
      if (error instanceof UpstashLimitError && count > limits.minChunk) { count = smaller(count, limits.minChunk); continue; }
      response = batch.map(() => error);
    }
    for (let i = 0; i < batch.length; i++) {
      const result = response[i];
      try { types.set(identity(batch[i][0]), result instanceof Error ? result : byteText(result)); }
      catch { types.set(identity(batch[i][0]), new CaptureError('read_error')); }
    }
    offset += batch.length;
  }
  return types;
}

function payloadBytes(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((total, item) => total + payloadBytes(item) + 1, 2);
  return 16;
}

function fullCommand(type, key) {
  if (type === 'list') return ['LRANGE', key, 0, -1];
  if (type === 'set') return ['SMEMBERS', key];
  if (type === 'zset') return ['ZRANGE', key, 0, -1, 'WITHSCORES'];
  return ['HGETALL', key];
}

export async function captureKey(client, keyBytes, initialType, { limits = LIMITS, now = Date.now } = {}) {
  const k = representBytes(keyBytes);
  if (initialType instanceof Error || typeof k !== 'string') return { k, error: 'read_error' };
  let type = initialType;
  async function transaction(command) {
    const capturedAt = now(); // This is immediately before sending the phase 2 request.
    const result = await client.multiExec([['TYPE', k], ['PTTL', k], command]);
    if (!Array.isArray(result) || result.length !== 3) throw new CaptureError('read_error');
    if (result[0] instanceof Error) throw result[0];
    const actual = byteText(result[0]);
    if (actual === 'none' || result[1] === -2) throw new CaptureError('missing_during_capture');
    if (actual !== type) throw new TypeChanged(actual);
    for (const value of result) if (value instanceof Error) throw value;
    const pttl = result[1];
    if (!Number.isSafeInteger(pttl) || pttl < -1) throw new CaptureError('read_error');
    return { capturedAt, pttl, value: result[2] };
  }
  function record(data, uncertain = false) {
    const value = createRecord({ key: keyBytes, type, ...data, uncertain });
    if (Buffer.byteLength(JSON.stringify(value)) + 1 > limits.lineBytes) throw new CaptureError('oversized');
    return value;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (type === 'none') throw new CaptureError('missing_during_capture');
      if (type === 'string') {
        let data;
        try { data = await transaction(['GET', k]); }
        catch (error) { if (error instanceof UpstashLimitError) throw new CaptureError('oversized'); throw error; }
        if (!(data.value instanceof Uint8Array)) throw new CaptureError('read_error');
        if (data.value.byteLength > limits.stringMax) throw new CaptureError('oversized');
        return record(data);
      }
      if (!Object.hasOwn(LENGTH, type)) throw new CaptureError('unsupported_type');
      const metadata = await transaction([LENGTH[type], k]);
      const length = metadata.value;
      if (!Number.isSafeInteger(length) || length < 0) throw new CaptureError('read_error');
      if (length * 3 > limits.lineBytes) throw new CaptureError('oversized');
      // Initial estimate: 1KiB per logical member/field. An actual full response over 1MiB
      // is discarded and captured in chunks; only an atomic full reread becomes certain.
      if (length <= limits.fullCollectionMax && length * 1024 <= limits.fullCollectionBytes) {
        try {
          const full = await transaction(fullCommand(type, k));
          const actualLength = Array.isArray(full.value) ? full.value.length / (type === 'hash' || type === 'zset' ? 2 : 1) : Infinity;
          if (actualLength <= limits.fullCollectionMax && payloadBytes(full.value) <= limits.fullCollectionBytes) return record(full);
        } catch (error) { if (!(error instanceof UpstashLimitError)) throw error; }
      }
      let count = limits.chunk, offset = 0, cursor = '0', first;
      const cursors = new Set(), members = new Map(), list = [];
      let encodedBytes = Buffer.byteLength(JSON.stringify(k)) + 256;
      while (true) {
        const command = type === 'list' ? ['LRANGE', k, offset, offset + count - 1]
          : type === 'zset' ? ['ZRANGE', k, offset, offset + count - 1, 'WITHSCORES']
          : [type === 'set' ? 'SSCAN' : 'HSCAN', k, cursor, 'COUNT', count];
        let chunk;
        try {
          chunk = await transaction(command);
          if (payloadBytes(chunk.value) > limits.reqBytes) throw new UpstashLimitError();
        } catch (error) {
          if (error instanceof UpstashLimitError) {
            if (count > limits.minChunk) { count = smaller(count, limits.minChunk); continue; }
            throw new CaptureError('oversized');
          }
          throw error;
        }
        if (!first) first = { capturedAt: chunk.capturedAt, pttl: chunk.pttl };
        let values = chunk.value;
        if (type === 'set' || type === 'hash') {
          if (!Array.isArray(values) || values.length !== 2) throw new CaptureError('read_error');
          cursor = byteText(values[0]);
          if (!/^\d+$/.test(cursor) || (cursor !== '0' && cursors.has(cursor))) throw new CaptureError('read_error');
          if (cursor !== '0') cursors.add(cursor);
          values = values[1];
        }
        if (!Array.isArray(values)) throw new CaptureError('read_error');
        const step = type === 'zset' || type === 'hash' ? 2 : 1;
        if (values.length % step) throw new CaptureError('read_error');
        for (let i = 0; i < values.length; i += step) {
          const item = values.slice(i, i + step);
          const id = identity(item[0]);
          const bytes = Buffer.byteLength(JSON.stringify(item.map(representBytes))) + 1;
          if (type === 'list') { list.push(item[0]); encodedBytes += bytes; }
          else {
            encodedBytes += bytes - (members.get(id)?.bytes ?? 0);
            members.set(id, { item, bytes }); // SCAN duplicates: set dedupe / latest field or score wins.
          }
          if (encodedBytes > limits.lineBytes) throw new CaptureError('oversized');
        }
        offset += count;
        if (type === 'list' || type === 'zset' ? offset >= length : cursor === '0') break;
      }
      // Detect disappearance/type changes at the end; equal lengths still provide no consistency proof.
      await transaction([LENGTH[type], k]);
      const value = type === 'list' ? list : [...members.values()].flatMap((entry) => entry.item);
      return record({ ...first, value }, true);
    } catch (error) {
      if (error instanceof TypeChanged) {
        if (attempt === 0) { type = error.type; continue; }
        return { k, error: 'type_changed' };
      }
      return { k, error: error instanceof CaptureError ? error.code : 'read_error' };
    }
  }
}

export async function* captureRecords(client, options = {}) {
  const keys = await scanKeys(client, options.limits);
  const types = await probeTypes(client, keys, options.limits);
  for (const key of keys) yield await captureKey(client, key, types.get(identity(key)), options);
}

export function archiveIdentity(env = process.env, now = new Date()) {
  const id = env.GITHUB_RUN_ID || '0';
  const attempt = env.GITHUB_RUN_ATTEMPT || randomUUID().slice(0, 8);
  if (!/^\d+$/.test(id) || !/^(?:\d+|[a-f0-9]{8})$/.test(attempt)) throw new BackupError('invalid_run_identity');
  const ts = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const name = `${ts}-r${id}-a${attempt}`;
  const archiveKey = `openpay-kv/${ts.slice(0, 4)}/${name}-full.jsonl.gz.enc`;
  return { name, archiveKey, metaKey: archiveKey.replace(/\.jsonl\.gz\.enc$/, '.meta.json'),
    run: { id, attempt: env.GITHUB_RUN_ATTEMPT ? Number(attempt) : attempt } };
}

export async function runBackup({ env = process.env, client, r2, dryRun = false, out, now = () => new Date(), limits = LIMITS } = {}) {
  parseKey(env.KV_BACKUP_KEY);
  client ??= createUpstashClient({ env });
  if (!dryRun) r2 ??= createR2Client({ env });
  const started = now();
  const names = archiveIdentity(env, started);
  const directory = out ? resolve(out) : await mkdtemp(join(tmpdir(), 'openpay-kv-out-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const archiveFile = join(directory, `${names.name}-full.jsonl.gz.enc`);
  const metaFile = join(directory, `${names.name}-full.meta.json`);
  const manifest = createManifest({ name: names.name, host: client.host, startedAt: started.toISOString() });
  const footer = await writeArchive({ manifest, records: captureRecords(client, { limits, now: () => now().getTime() }),
    file: archiveFile, key: env.KV_BACKUP_KEY, limits, now });
  let digest;
  if (dryRun) digest = await fileDigest(archiveFile);
  else {
    digest = await r2.putObject(archiveFile, names.archiveKey);
    await r2.headObject(names.archiveKey, digest);
  }
  const meta = createMeta({ manifest, footer, archiveKey: names.archiveKey, digest, run: names.run });
  await writeFile(metaFile, `${JSON.stringify(meta)}\n`, { flag: 'wx', mode: 0o600 });
  if (!dryRun) {
    const metaDigest = await r2.putObject(metaFile, names.metaKey);
    await r2.headObject(names.metaKey, metaDigest);
  }
  return { archiveFile, metaFile, meta, exitCode: footer.status === 'complete' ? 0 : 1 };
}

export function parseArgs(args) {
  const options = {};
  if (args[0] === 'run') args = args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' && !options.dryRun) options.dryRun = true;
    else if (['--verify', '--out'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = arg.slice(2);
      if (options[key]) throw new BackupError('invalid_arguments');
      options[key] = args[++i];
    } else throw new BackupError('invalid_arguments');
  }
  if (options.verify && (options.dryRun || options.out)) throw new BackupError('invalid_arguments');
  return options;
}

export async function main(args = process.argv.slice(2), { env = process.env, log = console.log, error = console.error, ...dependencies } = {}) {
  try {
    const options = parseArgs(args);
    if (options.verify) {
      const summary = await verifyArchive(options.verify, env.KV_BACKUP_KEY);
      log(JSON.stringify({ prefixes: summary.prefixes, errors: summary.footer.errors, uncertain: summary.footer.uncertain, status: summary.footer.status }));
      return 0;
    }
    const result = await runBackup({ ...dependencies, ...options, env });
    log(JSON.stringify({ archiveFile: result.archiveFile, status: result.meta.status, counts: result.meta.counts }));
    if (result.exitCode) error('::error::KV backup capture is partial; archive and meta have been saved.');
    return result.exitCode;
  } catch (failure) {
    // Error classes in this tree carry stable codes and never embed credentials or server text.
    const code = typeof failure?.code === 'string' ? failure.code : 'unexpected';
    error(`::error::KV backup failed (${failure?.name ?? 'Error'}: ${code}); check configuration, transport, and archive integrity.`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
