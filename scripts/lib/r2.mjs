import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { EMPTY_SHA256, signRequest } from './sigv4.mjs';

export class R2Error extends Error {
  constructor(code, status) {
    super(`R2 ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'R2Error';
    this.code = code;
    this.status = status;
  }
}

export function validateObjectKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9/_.-]+$/.test(key)
    || key.split('/').some((part) => part === '.' || part === '..')) throw new R2Error('invalid_object_key');
  // Dot segments are rejected because fetch URL normalization would sign a different path.
  return key;
}

export async function fileDigest(file, maxBytes = 1024 ** 3) {
  const sha = createHash('sha256'), md5 = createHash('md5');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > maxBytes) throw new R2Error('file_limit'); // v1 uses a single PUT, no multipart (§12).
    sha.update(chunk);
    md5.update(chunk);
  }
  return { size, sha256: sha.digest('hex'), md5: md5.digest('hex') };
}

function responseEtag(response) {
  const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
  if (!/^[a-fA-F0-9]{32}$/.test(etag ?? '')) throw new R2Error('invalid_etag');
  return etag.toLowerCase();
}

function xmlText(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) throw new R2Error('invalid_list_xml');
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code > 0x10ffff || code === 0 || (code >= 0xd800 && code <= 0xdfff)) throw new R2Error('invalid_list_xml');
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[entity];
  });
}

function xmlElement(xml, name, required = true) {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([^<]*)<\/${name}>`, 'g'))];
  if (matches.length !== 1) {
    if (!required && matches.length === 0) return undefined;
    throw new R2Error('invalid_list_xml');
  }
  return xmlText(matches[0][1]);
}

export function createR2Client({ env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = 60_000, now = () => new Date() } = {}) {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = env;
  if (!account || !accessKeyId || !secretAccessKey || !bucket) throw new R2Error('missing_credentials');
  if (!/^[a-zA-Z0-9-]+$/.test(account) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new R2Error('invalid_endpoint');
  const host = `${account}.r2.cloudflarestorage.com`;

  async function request({ method, key = '', query = [], digest, file, consume }) {
    if (key) validateObjectKey(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body, response;
      try {
        const signed = signRequest({ method, host, path: `/${bucket}/${key}`, query,
          payloadHash: digest?.sha256 ?? EMPTY_SHA256, accessKeyId, secretAccessKey, now: now() });
        if (file) {
          body = createReadStream(file); // A new stream for every retry, never reuse an exhausted body.
          signed.headers['Content-Length'] = String(digest.size);
          signed.headers['Content-MD5'] = Buffer.from(digest.md5, 'hex').toString('base64');
        }
        response = await fetchImpl(signed.url, {
          method, headers: signed.headers, redirect: 'error', signal: controller.signal,
          ...(body ? { body, duplex: 'half' } : {}),
        });
        if (!response.ok) throw new R2Error('http_error', response.status);
        return await consume(response);
      } catch (error) {
        const timeout = controller.signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError';
        if (attempt < 2 && (timeout || (error instanceof R2Error && error.status >= 500 && error.status <= 599))) continue;
        if (timeout) throw new R2Error('timeout');
        if (error instanceof R2Error) throw error;
        // fetch/filesystem messages can contain authorization material or response bodies.
        throw new R2Error('request_failed');
      } finally {
        clearTimeout(timer);
        body?.destroy();
        response?.body?.cancel().catch(() => {}); // Cleanup must not wait for an unconsumed tee branch.
      }
    }
  }

  async function putObject(file, key) {
    validateObjectKey(key);
    const digest = await fileDigest(file);
    await request({ method: 'PUT', key, file, digest, consume: async (response) => {
      if (responseEtag(response) !== digest.md5) throw new R2Error('etag_mismatch');
    } });
    return digest;
  }

  async function headObject(key, expected) {
    validateObjectKey(key);
    return request({ method: 'HEAD', key, consume: async (response) => {
      const length = response.headers.get('content-length');
      if (!/^\d+$/.test(length ?? '') || !Number.isSafeInteger(Number(length))) throw new R2Error('invalid_length');
      const result = { size: Number(length), md5: responseEtag(response) };
      if (expected && (result.size !== expected.size || result.md5 !== expected.md5)) throw new R2Error('head_mismatch');
      return result;
    } });
  }

  async function getObjectToFile(key, file, { maxBytes = 2 * 1024 ** 3, expected } = {}) {
    validateObjectKey(key);
    // Reserve the destination once; retries truncate only our own file, never a caller's existing file.
    const handle = await open(file, 'wx', 0o600);
    try {
      return await request({ method: 'GET', key, consume: async (response) => {
        await handle.truncate(0);
        const sha = createHash('sha256'), md5 = createHash('md5');
        let size = 0;
        if (!response.body) throw new R2Error('empty_response');
        for await (const value of response.body) {
          const chunk = Buffer.from(value);
          if (size + chunk.length > maxBytes) throw new R2Error('file_limit');
          sha.update(chunk); md5.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, size + offset);
            if (!bytesWritten) throw new R2Error('file_write_failed');
            offset += bytesWritten;
          }
          size += chunk.length;
        }
        const digest = { size, sha256: sha.digest('hex'), md5: md5.digest('hex') };
        if (responseEtag(response) !== digest.md5) throw new R2Error('etag_mismatch');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) throw new R2Error('length_mismatch');
        if (expected && (size !== expected.size || digest.sha256 !== expected.sha256)) throw new R2Error('digest_mismatch');
        return digest;
      } });
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    } finally { await handle.close(); }
  }

  async function listObjects(prefix) {
    validateObjectKey(prefix);
    const objects = [], tokens = new Set();
    let token;
    do {
      const query = [['list-type', '2'], ['prefix', prefix]];
      if (token !== undefined) query.push(['continuation-token', token]);
      const xml = await request({ method: 'GET', query, consume: async (response) => {
        const chunks = [];
        let size = 0;
        if (!response.body) throw new R2Error('empty_response');
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 16 * 1024 * 1024) throw new R2Error('list_limit');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
      } });
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>\s*$/.test(xml)) throw new R2Error('invalid_list_xml');
      const truncated = xmlElement(xml, 'IsTruncated');
      if (!['true', 'false'].includes(truncated)) throw new R2Error('invalid_list_xml');
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = validateObjectKey(xmlElement(match[1], 'Key'));
        if (!key.startsWith(prefix)) throw new R2Error('invalid_list_prefix');
        const size = Number(xmlElement(match[1], 'Size'));
        if (!Number.isSafeInteger(size) || size < 0) throw new R2Error('invalid_list_xml');
        objects.push({ key, size });
        if (objects.length > 10_000_000) throw new R2Error('list_limit');
      }
      token = truncated === 'true' ? xmlElement(xml, 'NextContinuationToken') : undefined;
      if (token !== undefined && (!token || tokens.has(token))) throw new R2Error('invalid_continuation');
      if (token !== undefined) tokens.add(token);
    } while (token !== undefined);
    return objects;
  }

  return { putObject, headObject, getObjectToFile, listObjects };
}
