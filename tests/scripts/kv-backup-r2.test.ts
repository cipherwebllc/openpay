// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createR2Client, fileDigest, validateObjectKey } from '@/scripts/lib/r2.mjs';
const env = { R2_ACCOUNT_ID: 'account', R2_ACCESS_KEY_ID: 'ACCESS', R2_SECRET_ACCESS_KEY: 'SECRET', R2_BUCKET: 'backup' };
const key = 'openpay-kv/2026/20260915T031700Z-r1-a1-full.jsonl.gz.enc';
const payload = Buffer.from('completed encrypted archive bytes');
const md5 = (value: Buffer | string) => createHash('md5').update(value).digest('hex');
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
let dir: string, file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kv-r2-test-')); file = join(dir, 'archive.enc'); await writeFile(file, payload); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const response = (body: BodyInit | null = null, status = 200, etag = md5(payload), size = payload.length) => new Response(body, { status, headers: { ETag: `"${etag}"`, 'Content-Length': String(size) } });
async function streamBytes(body: AsyncIterable<Buffer>) { const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
const list = (truncated: boolean, keys: string[], token = '') => new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${truncated}</IsTruncated>${keys.map((key) => `<Contents><Key>${key}</Key><Size>123</Size></Contents>`).join('')}${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}</ListBucketResult>`);

describe('R2 completed file transport', () => {
  it('PUT signs and streams exactly the digest file; HEAD matches size and local MD5', async () => {
    const fetch = vi.fn(async (_url: string, init: { method: string; body: AsyncIterable<Buffer>; headers: Record<string, string>; redirect: string }) => {
      expect(init.redirect).toBe('error');
      if (init.method === 'PUT') {
        expect(await streamBytes(init.body)).toEqual(payload);
        expect(init.headers['x-amz-content-sha256']).toBe(sha(payload));
        expect(init.headers['Content-Length']).toBe(String(payload.length));
        expect(init.headers['Content-MD5']).toBe(Buffer.from(md5(payload), 'hex').toString('base64'));
      }
      return response();
    });
    const client = createR2Client({ env, fetch });
    const digest = await client.putObject(file, key);
    expect(digest).toEqual({ size: payload.length, sha256: sha(payload), md5: md5(payload) });
    await expect(client.headObject(key, digest)).resolves.toEqual({ size: payload.length, md5: md5(payload) });
    expect(fetch.mock.calls[0][0]).toBe(`https://account.r2.cloudflarestorage.com/backup/${key}`);
  });
  it.each(['5xx', 'timeout'])('reopens the same file on %s, with at most three attempts', async (failure) => {
    const streams: unknown[] = [], bodies: Buffer[] = [];
    const fetch = vi.fn(async (_url: string, init: { body: AsyncIterable<Buffer> }) => {
      streams.push(init.body); bodies.push(await streamBytes(init.body));
      if (streams.length < 3) {
        if (failure === 'timeout') throw new DOMException('SECRET', 'TimeoutError');
        return response(null, 503);
      }
      return response();
    });
    await createR2Client({ env, fetch }).putObject(file, key);
    expect(new Set(streams).size).toBe(3);
    expect(bodies).toEqual([payload, payload, payload]);
    const failed = vi.fn(async () => response(null, 500));
    await expect(createR2Client({ env, fetch: failed }).putObject(file, key)).rejects.toMatchObject({ status: 500 });
    expect(failed).toHaveBeenCalledTimes(3);
  });
  it('rejects wrong PUT ETag, HEAD size/ETag mismatches, redirects and auth failures without retry', async () => {
    await expect(createR2Client({ env, fetch: async () => response(null, 200, '0'.repeat(32)) }).putObject(file, key)).rejects.toThrow('etag_mismatch');
    const digest = await fileDigest(file);
    for (const reply of [response(null, 200, md5(payload), 0), response(null, 200, '0'.repeat(32)), response(null, 200, 'multipart-2')]) {
      await expect(createR2Client({ env, fetch: async () => reply }).headObject(key, digest)).rejects.toThrow();
    }
    for (const status of [301, 307, 401, 403, 404]) {
      const fetch = vi.fn(async () => response(null, status));
      await expect(createR2Client({ env, fetch }).putObject(file, key)).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('GET downloads to a private file and validates ETag, size and SHA256 for the drill', async () => {
    const output = join(dir, 'download.enc');
    const client = createR2Client({ env, fetch: async () => response(payload) });
    const expected = await fileDigest(file);
    await expect(client.getObjectToFile(key, output, { expected })).resolves.toEqual(expected);
    expect(await readFile(output)).toEqual(payload);
    await expect(client.getObjectToFile(key, join(dir, 'bad'), { expected: { ...expected, sha256: '0'.repeat(64) } })).rejects.toThrow('digest_mismatch');
    await expect(client.getObjectToFile(key, join(dir, 'large'), { maxBytes: 1 })).rejects.toThrow('file_limit');
    expect((await readdir(dir)).sort()).toEqual(['archive.enc', 'download.enc']);
    // An existing caller file is never truncated during GET retries.
    await expect(client.getObjectToFile(key, file)).rejects.toThrow();
    expect(await readFile(file)).toEqual(payload);
  });
  it('paginates ListObjectsV2 including an empty page and opaque XML-escaped token', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(list(true, [], 'a/+==% &amp;x')).mockResolvedValueOnce(list(false, [key]));
    const result = await createR2Client({ env, fetch }).listObjects('openpay-kv/2026/');
    expect(result).toEqual([{ key, size: 123 }]);
    const url = new URL(fetch.mock.calls[1][0]);
    expect(url.searchParams.get('continuation-token')).toBe('a/+==% &x');
    expect(url.search).toContain('a%2F%2B%3D%3D%25%20%26x');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('openpay-kv/2026/');
  });
  it('restarts a timed-out GET at byte zero and removes partial files on final failure', async () => {
    const broken = () => new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('partial bytes to discard')); },
      pull(controller) { controller.error(new DOMException('timeout', 'TimeoutError')); },
    });
    const fetch = vi.fn().mockResolvedValueOnce(response(broken())).mockResolvedValueOnce(response(payload));
    const output = join(dir, 'retried.enc');
    await createR2Client({ env, fetch }).getObjectToFile(key, output);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(output)).toEqual(payload);
    const failure = vi.fn(async () => response(broken()));
    await expect(createR2Client({ env, fetch: failure }).getObjectToFile(key, join(dir, 'failed.enc'))).rejects.toThrow('timeout');
    expect(failure).toHaveBeenCalledTimes(3);
    expect((await readdir(dir)).sort()).toEqual(['archive.enc', 'retried.enc']);
  });
  it('rejects missing/repeated pagination tokens and malformed XML', async () => {
    for (const reply of [list(true, []), new Response('<Error>SECRET</Error>'), new Response('<!DOCTYPE x><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')]) {
      await expect(createR2Client({ env, fetch: async () => reply.clone() }).listObjects('openpay-kv/2026/')).rejects.toThrow('invalid_list_xml');
    }
    const fetch = vi.fn(async () => list(true, [], 'same'));
    await expect(createR2Client({ env, fetch }).listObjects('openpay-kv/2026/')).rejects.toThrow('invalid_continuation');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('restricts object names; never exposes credentials in URL or errors', async () => {
    for (const bad of ['a:b', 'a?b', 'a b', 'a%b', '日本', 'a/../b', 'a/./b', '']) expect(() => validateObjectKey(bad)).toThrow();
    expect(validateObjectKey('openpay-kv/2026/a_B-c.d')).toBe('openpay-kv/2026/a_B-c.d');
    const fetch = vi.fn(async (_url: string) => { throw new Error('SECRET'); });
    await expect(createR2Client({ env, fetch }).headObject(key)).rejects.not.toThrow('SECRET');
    expect(fetch.mock.calls[0][0]).not.toContain('SECRET');
    expect(() => createR2Client({ env: {} })).toThrow('missing_credentials');
    await expect(fileDigest(file, 1)).rejects.toThrow('file_limit');
  });
});
