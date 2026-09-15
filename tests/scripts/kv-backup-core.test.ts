// @vitest-environment node
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DENYLIST, LIMITS, PREFIXES, cleanupStaging, createJsonl, createManifest, createMeta, createRecord,
  decryptToStaging, isAllowedKey, parseKey, representBytes, restoreBytes, sha256, verifyArchive, verifyJsonl,
  writeArchive } from '@/scripts/lib/kv-backup-core.mjs';

const key = '12'.repeat(32);
const startedAt = '2026-09-15T03:17:00.000Z';
const name = '20260915T031700Z-r123-a1';
const manifest = createManifest({ name, host: 'private-db.upstash.io', startedAt });
const now = () => new Date(startedAt);
const record = createRecord({ key: 'store:one', type: 'string', capturedAt: 10, pttl: -1, value: Buffer.from('private signed tx') });
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kv-core-test-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function jsonl(records = [record]) {
  const parts = [];
  for await (const part of createJsonl(manifest, records, { now })) parts.push(part);
  return Buffer.concat(parts);
}
function seal(bytes: Buffer) {
  const secret = Buffer.from(key, 'hex');
  const iv = randomBytes(12);
  const header = Buffer.concat([Buffer.from('OPKVB2'), createHash('sha256').update(secret).digest().subarray(0, 8), iv]);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}
async function fixture(bytes: Buffer, filename = 'fixture.enc') {
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

describe('scope and lossless byte records', () => {
  it('allows precisely the five prefixes and denies exact keys / colon families', () => {
    for (const prefix of PREFIXES) expect(isAllowedKey(`${prefix}one`)).toBe(true);
    for (const denied of DENYLIST) {
      expect(isAllowedKey(denied)).toBe(false);
      expect(isAllowedKey(`${denied}:child`)).toBe(false);
      expect(isAllowedKey(`${denied}x`)).toBe(true);
    }
    for (const other of ['store', 'x402fac:reservation:v1:a', 'session:a', 'payment:claim:a']) expect(isAllowedKey(other)).toBe(false);
  });
  it.each([
    [Buffer.from('\uFEFFhello'), '\uFEFFhello'],
    [Buffer.from('\uFFFD'), '\uFFFD'],
    [Buffer.from([0xff, 0x80, 0]), { b: '/4AA' }],
    [Buffer.from([0xc0, 0xaf]), { b: 'wK8=' }],
    [Buffer.alloc(0), ''],
    [Buffer.from('\u0000\r\n'), '\u0000\r\n'],
  ])('preserves BOM, replacement character, binary and controls (%j)', (bytes, expected) => {
    expect(representBytes(bytes)).toEqual(expected);
    expect(restoreBytes(representBytes(bytes))).toEqual(bytes);
  });
  it('preserves bytes in every collection position and score text', () => {
    const binary = Buffer.from([255]), bom = Buffer.from('\uFEFFvalue');
    const make = (type: string, value: Buffer[]) => createRecord({ key: 'store:k', type, capturedAt: 20, pttl: 0, value });
    expect(make('list', [binary, bom])).toMatchObject({ l: [{ b: '/w==' }, '\uFEFFvalue'], expiresAt: 20 });
    expect(make('set', [binary])).toMatchObject({ m: [{ b: '/w==' }] });
    expect(make('zset', [binary, Buffer.from('1.2300e+3')])).toMatchObject({ z: [[{ b: '/w==' }, '1.2300e+3']] });
    for (const score of ['inf', '+inf', '-inf']) expect(make('zset', [binary, Buffer.from(score)])).toMatchObject({ z: [[{ b: '/w==' }, score]] });
    expect(make('hash', [binary, bom])).toMatchObject({ h: [[{ b: '/w==' }, '\uFEFFvalue']] });
    expect(createRecord({ key: 'store:k', type: 'none', capturedAt: 20, pttl: -2 })).toEqual({ k: 'store:k', error: 'missing_during_capture' });
  });
  it('strictly validates hex keys and byte encodings', () => {
    for (const bad of ['', `0x${key}`, `${key}\n`, key.slice(2), 'gg'.repeat(32)]) expect(() => parseKey(bad)).toThrow();
    expect(parseKey('AB'.repeat(32))).toHaveLength(32);
    for (const bad of [{ b: '***' }, { b: '/w==', extra: true }, { s: 'text' }]) expect(() => restoreBytes(bad)).toThrow();
  });
});

describe('JSONL integrity and limits', () => {
  it('hashes exactly manifest through the newline before footer; partial is valid', async () => {
    const bytes = await jsonl([record, { k: 'store:bad', error: 'read_error' }]);
    const lines = bytes.toString().trimEnd().split('\n');
    const summary = await verifyJsonl([bytes]);
    expect(summary.footer).toMatchObject({ keys: 2, errors: 1, uncertain: 0, status: 'partial', bodySha256: sha256(`${lines.slice(0, -1).join('\n')}\n`) });
    expect(summary.prefixes.store).toBeUndefined();
    expect(summary.prefixes['store:']).toBe(2);
  });
  it('accepts chunked byte input including split UTF-8 and LF', async () => {
    const bytes = await jsonl([{ ...record, s: '\uFEFF日本語' }]);
    const source = Array.from(bytes, (byte) => Buffer.from([byte]));
    expect((await verifyJsonl(source)).footer.keys).toBe(1);
  });
  it('keeps uncertain captures complete when there are no read errors', async () => {
    const summary = await verifyJsonl([await jsonl([{ ...record, uncertain: true }])]);
    expect(summary.footer).toMatchObject({ keys: 1, errors: 0, uncertain: 1, status: 'complete' });
  });
  it('rejects missing/wrong manifest, missing footer, duplicate keys, trailing data and body tampering', async () => {
    const bytes = await jsonl();
    const lines = bytes.toString().trimEnd().split('\n');
    const failures = [
      `${lines.slice(1).join('\n')}\n`, `${lines.slice(0, -1).join('\n')}\n`,
      `${lines[0]}\n${lines[1]}\n${lines[1]}\n${lines[2]}\n`,
      `${bytes}{}\n`, `${bytes}\n`, bytes.toString().replace('private signed tx', 'changed'),
      bytes.toString().replace('"v":2', '"v":3'), bytes.toString().replace('"s":"private signed tx"', '"s":{"x":"unsupported"}'),
    ];
    for (const text of failures) await expect(verifyJsonl([Buffer.from(text)])).rejects.toThrow();
    await expect(verifyJsonl([bytes.subarray(0, -1)])).rejects.toThrow('unterminated_line');
  });
  it('bounds bytes, a line without LF, and line count while reading/writing', async () => {
    const bytes = await jsonl();
    await expect(verifyJsonl([bytes], { limits: { ...LIMITS, gunzipBytes: bytes.length - 1 } })).rejects.toThrow('gunzip_limit');
    await expect(verifyJsonl([Buffer.alloc(101, 32)], { limits: { ...LIMITS, lineBytes: 100 } })).rejects.toThrow('jsonl_limit');
    await expect(verifyJsonl([bytes], { limits: { ...LIMITS, lines: 2 } })).rejects.toThrow('jsonl_limit');
    await expect(writeArchive({ manifest, records: [record], key, file: join(dir, 'limited'), now,
      limits: { ...LIMITS, ciphertextBytes: 50 } })).rejects.toThrow('ciphertext_limit');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('authenticated private staging', () => {
  it('round trips, uses fresh IVs and private files, and removes verified staging', async () => {
    const files = [join(dir, 'a.enc'), join(dir, 'b.enc')];
    for (const file of files) await writeArchive({ manifest, records: [record], key, file, now });
    const [a, b] = await Promise.all(files.map((file) => readFile(file)));
    expect(a.subarray(0, 6).toString()).toBe('OPKVB2');
    expect(a.subarray(14, 26)).not.toEqual(b.subarray(14, 26));
    expect((await stat(files[0])).mode & 0o777).toBe(0o600);
    const path = await decryptToStaging(files[0], key, { stagingRoot: dir });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(gunzipSync(await readFile(path))).toEqual(await jsonl());
    await cleanupStaging(path);
    expect((await verifyArchive(files[0], key, { stagingRoot: dir })).footer.status).toBe('complete');
    expect((await readdir(dir)).sort()).toEqual(['a.enc', 'b.enc']);
  });
  it('rejects wrong key, header/keyId/IV/cipher/tag changes, truncation and appended garbage', async () => {
    const original = seal(gzipSync(await jsonl()));
    const variants = [original.subarray(0, 20), original.subarray(0, -1), Buffer.concat([original, Buffer.from('garbage')])];
    for (const offset of [0, 6, 14, 26, original.length - 1]) {
      const changed = Buffer.from(original); changed[offset] ^= 1; variants.push(changed);
    }
    const file = await fixture(original);
    await expect(decryptToStaging(file, '23'.repeat(32), { stagingRoot: dir })).rejects.toThrow('wrong_key');
    for (const variant of variants) {
      await writeFile(file, variant);
      await expect(decryptToStaging(file, key, { stagingRoot: dir })).rejects.toThrow();
      expect(await readdir(dir)).toEqual(['fixture.enc']);
    }
  });
  it('does not hand plaintext to a consumer before GCM final succeeds', async () => {
    // Even authenticated-looking JSONL is never parsed while the tag is invalid.
    const encrypted = seal(gzipSync(Buffer.from('sensitive invalid JSONL')));
    encrypted[encrypted.length - 1] ^= 1;
    const file = await fixture(encrypted);
    let consumed = false;
    await expect(decryptToStaging(file, key, { stagingRoot: dir }).then(async (path: string) => {
      consumed = true; return readFile(path);
    })).rejects.toThrow('decryption_failed');
    expect(consumed).toBe(false);
    expect(await readdir(dir)).toEqual(['fixture.enc']);
  });
  it('cleans up authenticated invalid gzip/JSONL and enforces decompression/ciphertext bounds', async () => {
    const file = await fixture(seal(Buffer.from('not gzip')));
    await expect(verifyArchive(file, key, { stagingRoot: dir })).rejects.toThrow('invalid_gzip');
    await writeFile(file, seal(gzipSync(Buffer.from('not JSONL\n'))));
    await expect(verifyArchive(file, key, { stagingRoot: dir })).rejects.toThrow('invalid_jsonl');
    await writeFile(file, seal(gzipSync(await jsonl())));
    await expect(verifyArchive(file, key, { stagingRoot: dir, limits: { ...LIMITS, gunzipBytes: 10 } })).rejects.toThrow('gunzip_limit');
    await expect(decryptToStaging(file, key, { stagingRoot: dir, limits: { ...LIMITS, ciphertextBytes: 50 } })).rejects.toThrow('ciphertext_limit');
    expect(await readdir(dir)).toEqual(['fixture.enc']);
  });
  it('creates a closed metadata schema without source host, values or credentials', async () => {
    const footer = (await verifyJsonl([await jsonl()])).footer;
    const meta = createMeta({ manifest: { ...manifest, token: 'DO_NOT_COPY' }, footer: { ...footer, value: 'DO_NOT_COPY' },
      archiveKey: `openpay-kv/2026/${name}-full.jsonl.gz.enc`, digest: { size: 123, sha256: 'a'.repeat(64), md5: 'b'.repeat(32) }, run: { id: '123', attempt: 1, token: 'DO_NOT_COPY' } });
    expect(meta).toMatchObject({ v: 1, name, size: 123, status: 'complete', counts: { keys: 1, errors: 0, uncertain: 0 } });
    for (const secret of ['DO_NOT_COPY', 'private signed tx', 'private-db.upstash.io']) expect(JSON.stringify(meta)).not.toContain(secret);
  });
});
