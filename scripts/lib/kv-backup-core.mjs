import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

export const PREFIXES = Object.freeze(['x402:hosted:', 'store:', 'payment:claimed:', 'billing:settled:', 'x402:settle:ledger:']);
export const DENYLIST = Object.freeze(['store:quote:rl', 'store:license:verify:rpc', 'store:delivery:rpc', 'store:license:worker:lock']);
export const LIMITS = Object.freeze({
  fullCollectionMax: 1000, fullCollectionBytes: 1024 * 1024, chunk: 1000, minChunk: 50,
  reqBytes: 4 * 1024 * 1024, stringMax: 4 * 1024 * 1024,
  ciphertextBytes: 2 * 1024 ** 3, gunzipBytes: 4 * 1024 ** 3, lineBytes: 8 * 1024 ** 2, lines: 10_000_000,
});
const MAGIC = Buffer.from('OPKVB2');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const FIELDS = { string: 's', list: 'l', set: 'm', zset: 'z', hash: 'h' };
const ERRORS = new Set(['unsupported_type', 'oversized', 'missing_during_capture', 'type_changed', 'read_error']);

export class BackupError extends Error {
  constructor(code) {
    super(`KV backup ${code}`);
    this.name = 'BackupError';
    this.code = code;
  }
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function representBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new BackupError('expected_bytes');
  try {
    const text = decoder.decode(bytes);
    if (Buffer.from(encoder.encode(text)).equals(Buffer.from(bytes))) return text;
  } catch { /* Non-UTF-8 is preserved, never replaced or discarded. */ }
  return { b: Buffer.from(bytes).toString('base64') };
}

export function restoreBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value && Object.keys(value).length === 1 && typeof value.b === 'string') {
    const bytes = Buffer.from(value.b, 'base64');
    if (bytes.toString('base64') === value.b) return bytes;
  }
  throw new BackupError('invalid_byte_encoding');
}

export function isAllowedKey(key) {
  const bytes = typeof key === 'string' ? Buffer.from(key) : Buffer.from(key);
  const starts = (prefix) => bytes.subarray(0, Buffer.byteLength(prefix)).equals(Buffer.from(prefix));
  return PREFIXES.some(starts) && !DENYLIST.some((entry) => bytes.equals(Buffer.from(entry)) || starts(`${entry}:`));
}

export function byteText(bytes) {
  const value = representBytes(bytes);
  if (typeof value !== 'string') throw new BackupError('binary_argument_unsupported');
  return value;
}

export function createRecord({ key, type, capturedAt, pttl, value, uncertain = false }) {
  const k = typeof key === 'string' ? key : representBytes(key);
  if (pttl === -2 || type === 'none') return { k, error: 'missing_during_capture' };
  if (!Object.hasOwn(FIELDS, type)) return { k, error: 'unsupported_type' };
  if (!Number.isSafeInteger(pttl) || pttl < -1) throw new BackupError('invalid_pttl');
  const record = { k, t: type, capturedAt, expiresAt: pttl === -1 ? null : capturedAt + pttl };
  if (type === 'string') record.s = representBytes(value);
  else if (type === 'zset' || type === 'hash') {
    if (!Array.isArray(value) || value.length % 2) throw new BackupError('invalid_pairs');
    record[FIELDS[type]] = [];
    for (let i = 0; i < value.length; i += 2) {
      record[FIELDS[type]].push([representBytes(value[i]), type === 'zset' ? byteText(value[i + 1]) : representBytes(value[i + 1])]);
    }
  } else record[FIELDS[type]] = value.map(representBytes);
  if (uncertain) record.uncertain = true;
  validateRecord(record);
  return record;
}

export function createManifest({ name, host, startedAt }) {
  return {
    v: 2, kind: 'full', name, source: { hostSha256Hex16: sha256(host).slice(0, 16) },
    prefixes: [...PREFIXES], denylist: [...DENYLIST],
    limits: { fullCollectionMax: LIMITS.fullCollectionMax, chunk: LIMITS.chunk, reqBytes: LIMITS.reqBytes, stringMax: LIMITS.stringMax }, startedAt,
  };
}

const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validName = (value) => typeof value === 'string' && /^\d{8}T\d{6}Z-r\d+-a(?:\d+|[a-f0-9]{8})$/.test(value);

function validateManifest(manifest) {
  if (manifest?.v !== 2 || manifest.kind !== 'full' || !validName(manifest.name)
    || !/^[a-f0-9]{16}$/.test(manifest.source?.hostSha256Hex16 ?? '') || !validTime(manifest.startedAt)
    || JSON.stringify(manifest.prefixes) !== JSON.stringify(PREFIXES)
    || JSON.stringify(manifest.denylist) !== JSON.stringify(DENYLIST)
    || ['fullCollectionMax', 'chunk', 'reqBytes', 'stringMax'].some((key) => manifest.limits?.[key] !== LIMITS[key])) {
    throw new BackupError('invalid_manifest');
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new BackupError('invalid_record');
  if (!isAllowedKey(restoreBytes(record.k))) throw new BackupError('out_of_scope_key');
  if (Object.hasOwn(record, 'error')) {
    if (!ERRORS.has(record.error) || Object.keys(record).some((k) => !['k', 'error', 'detail'].includes(k))
      || (record.detail !== undefined && typeof record.detail !== 'string')) throw new BackupError('invalid_error_record');
    return;
  }
  if (!Object.hasOwn(FIELDS, record.t) || !validCount(record.capturedAt)
    || (record.expiresAt !== null && (!validCount(record.expiresAt) || record.expiresAt < record.capturedAt))
    || (record.uncertain !== undefined && record.uncertain !== true)
    || Object.keys(record).some((k) => !['k', 't', 'capturedAt', 'expiresAt', 'uncertain', FIELDS[record.t]].includes(k))) {
    throw new BackupError('invalid_record');
  }
  const data = record[FIELDS[record.t]];
  if (record.t === 'string') restoreBytes(data);
  else {
    if (!Array.isArray(data)) throw new BackupError('invalid_collection');
    const seen = new Set();
    for (const item of data) {
      let member = item;
      if (record.t === 'zset' || record.t === 'hash') {
        if (!Array.isArray(item) || item.length !== 2) throw new BackupError('invalid_pairs');
        member = item[0];
        if (record.t === 'hash') restoreBytes(item[1]);
        // Redis scores include +/-inf. Capture preserves their original text too.
        else if (typeof item[1] !== 'string' || (!/^[+-]?inf$/.test(item[1])
          && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(item[1])
          || !Number.isFinite(Number(item[1]))))) throw new BackupError('invalid_score');
      }
      const identity = restoreBytes(member).toString('base64');
      if (record.t !== 'list' && seen.has(identity)) throw new BackupError('duplicate_member');
      seen.add(identity);
    }
  }
}

export async function* createJsonl(manifest, records, { limits = LIMITS, now = () => new Date(), onFooter = () => {} } = {}) {
  validateManifest(manifest);
  const hash = createHash('sha256');
  const seen = new Set();
  let keys = 0, errors = 0, uncertain = 0, lines = 0, bytes = 0;
  function encode(value, body = true) {
    const line = Buffer.from(`${JSON.stringify(value)}\n`);
    bytes += line.length;
    if (line.length > limits.lineBytes || ++lines > limits.lines || bytes > limits.gunzipBytes) throw new BackupError('jsonl_limit');
    if (body) hash.update(line);
    return line;
  }
  yield encode(manifest);
  for await (const record of records) {
    validateRecord(record);
    const identity = restoreBytes(record.k).toString('base64');
    if (seen.has(identity)) throw new BackupError('duplicate_key');
    seen.add(identity);
    keys++;
    if (record.error) errors++;
    if (record.uncertain) uncertain++;
    yield encode(record);
  }
  const footer = { end: true, keys, errors, uncertain, status: errors ? 'partial' : 'complete', finishedAt: now().toISOString(), bodySha256: hash.digest('hex') };
  yield encode(footer, false);
  onFooter(footer);
}

export function parseKey(hex) {
  if (typeof hex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hex)) throw new BackupError('invalid_key');
  return Buffer.from(hex, 'hex');
}

function byteLimit(max, code) {
  let size = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > max ? new BackupError(code) : null, chunk);
    },
  });
}

function encryptStream(hex) {
  const key = parseKey(hex);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, createHash('sha256').update(key).digest().subarray(0, 8), iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let started = false;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (!started) { this.push(header); started = true; }
      callback(null, cipher.update(chunk));
    },
    flush(callback) {
      if (!started) this.push(header);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      callback();
    },
  });
}

export async function writeArchive({ manifest, records, file, key, limits = LIMITS, now }) {
  const encryption = encryptStream(key);
  const handle = await open(file, 'wx', 0o600);
  let footer;
  try {
    await pipeline(
      Readable.from(createJsonl(manifest, records, { limits, now, onFooter: (value) => { footer = value; } })),
      createGzip(), encryption, byteLimit(limits.ciphertextBytes, 'ciphertext_limit'), handle.createWriteStream(),
    );
    return footer;
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
}

// Returns only authenticated gzip bytes. The caller owns cleanupStaging(path), including on success.
export async function decryptToStaging(file, hex, { limits = LIMITS, stagingRoot = tmpdir() } = {}) {
  const key = parseKey(hex);
  const input = await open(file, 'r');
  let directory;
  try {
    const { size } = await input.stat();
    if (size < 42) throw new BackupError('truncated_archive');
    if (size > limits.ciphertextBytes) throw new BackupError('ciphertext_limit');
    const header = Buffer.alloc(26), tag = Buffer.alloc(16);
    await input.read(header, 0, 26, 0);
    await input.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 6).equals(MAGIC)) throw new BackupError('invalid_header');
    if (!timingSafeEqual(header.subarray(6, 14), createHash('sha256').update(key).digest().subarray(0, 8))) throw new BackupError('wrong_key');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(14));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    directory = await mkdtemp(join(stagingRoot, 'openpay-kv-stage-'));
    const path = join(directory, 'authenticated.jsonl.gz');
    const output = await open(path, 'wx', 0o600);
    try {
      await pipeline(input.createReadStream({ start: 26, end: size - 17, autoClose: false }),
        byteLimit(limits.ciphertextBytes - 42, 'ciphertext_limit'), decipher, output.createWriteStream());
    } finally { await output.close(); }
    return path; // pipeline has called decipher.final(): no consumer can see unauthenticated data.
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (error instanceof BackupError) throw error;
    throw new BackupError('decryption_failed');
  } finally { await input.close(); }
}

export async function cleanupStaging(path) {
  // A bad caller path must not turn staging cleanup into removal of another directory.
  if (basename(path) !== 'authenticated.jsonl.gz' || !basename(dirname(path)).startsWith('openpay-kv-stage-')) throw new BackupError('invalid_staging_path');
  await rm(dirname(path), { recursive: true, force: true });
}

export async function verifyJsonl(source, { limits = LIMITS } = {}) {
  const hash = createHash('sha256');
  const seen = new Set();
  const prefixes = Object.fromEntries(PREFIXES.map((prefix) => [prefix, 0]));
  let manifest, footer, pending = Buffer.alloc(0), size = 0, lines = 0, errors = 0, uncertain = 0;
  function consume(line) {
    if (++lines > limits.lines || line.length > limits.lineBytes) throw new BackupError('jsonl_limit');
    if (footer) throw new BackupError('data_after_footer');
    let record;
    try { record = JSON.parse(decoder.decode(line.subarray(0, -1))); } catch { throw new BackupError('invalid_jsonl'); }
    if (!manifest) { validateManifest(record); manifest = record; }
    else if (record?.end === true) {
      if (!validCount(record.keys) || !validCount(record.errors) || !validCount(record.uncertain)
        || record.keys !== seen.size || record.errors !== errors || record.uncertain !== uncertain
        || record.status !== (errors ? 'partial' : 'complete') || !validTime(record.finishedAt)
        || Date.parse(record.finishedAt) < Date.parse(manifest.startedAt)
        || !validDigest(record.bodySha256) || record.bodySha256 !== hash.digest('hex')) throw new BackupError('invalid_footer');
      footer = record;
      return;
    } else {
      validateRecord(record);
      const bytes = restoreBytes(record.k), identity = bytes.toString('base64');
      if (seen.has(identity)) throw new BackupError('duplicate_key');
      seen.add(identity);
      for (const prefix of PREFIXES) if (bytes.subarray(0, prefix.length).equals(Buffer.from(prefix))) prefixes[prefix]++;
      if (record.error) errors++;
      if (record.uncertain) uncertain++;
    }
    hash.update(line);
  }
  for await (const value of source) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > limits.gunzipBytes) throw new BackupError('gunzip_limit');
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      const part = chunk.subarray(start, end + 1);
      if (pending.length + part.length > limits.lineBytes) throw new BackupError('jsonl_limit');
      consume(pending.length ? Buffer.concat([pending, part]) : part);
      pending = Buffer.alloc(0);
      start = end + 1;
    }
    if (pending.length + chunk.length - start > limits.lineBytes) throw new BackupError('jsonl_limit');
    pending = Buffer.concat([pending, chunk.subarray(start)]);
  }
  if (pending.length) throw new BackupError('unterminated_line');
  if (!footer) throw new BackupError('missing_footer');
  return { manifest, footer, prefixes };
}

export async function verifyArchive(file, key, options = {}) {
  const staging = await decryptToStaging(file, key, options);
  const gunzip = createGunzip();
  const input = createReadStream(staging);
  const pumping = pipeline(input, gunzip);
  // Attach a handler immediately; corrupt gzip must not become an unhandled rejection.
  pumping.catch(() => {});
  try {
    const summary = await verifyJsonl(gunzip, options);
    await pumping;
    return summary;
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    await pumping.catch(() => {});
    if (error instanceof BackupError) throw error;
    throw new BackupError('invalid_gzip');
  } finally { await cleanupStaging(staging); }
}

export function createMeta({ manifest, footer, archiveKey, digest, run }) {
  // Deliberately construct a closed schema: no records, URLs, tokens, or error details.
  return {
    v: 1, name: manifest.name, archiveKey, ciphertextSha256: digest.sha256, size: digest.size,
    source: { hostSha256Hex16: manifest.source.hostSha256Hex16 },
    capture: { startedAt: manifest.startedAt, finishedAt: footer.finishedAt },
    run: { id: run.id, attempt: run.attempt },
    counts: { keys: footer.keys, errors: footer.errors, uncertain: footer.uncertain }, status: footer.status,
  };
}
