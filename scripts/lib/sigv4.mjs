import { createHash, createHmac } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
export const EMPTY_SHA256 = hash('');

// AWS encodes UTF-8 bytes, spaces as %20, and hex digits in uppercase (never form '+').
export function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQuery(query = []) {
  return [...query].map(([key, value]) => [awsEncode(String(key)), awsEncode(String(value))])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
}

// The generic canonicalizer is also checked against the AWS public service test suite.
export function signHeaders({ method, path = '/', query = [], headers, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3' }) {
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error('SigV4 invalid payload hash');
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    const text = String(value).trim().replace(/\s+/g, ' ');
    normalized[name] = normalized[name] === undefined ? text : `${normalized[name]},${text}`;
  }
  const names = Object.keys(normalized).sort();
  const signedHeaders = names.join(';');
  const canonicalUri = path.split('/').map(awsEncode).join('/');
  const queryString = canonicalQuery(query);
  const canonicalRequest = [method, canonicalUri, queryString,
    names.map((name) => `${name}:${normalized[name]}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const date = normalized['x-amz-date'];
  if (!/^\d{8}T\d{6}Z$/.test(date ?? '') || !normalized.host) throw new Error('SigV4 invalid headers');
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date.slice(0, 8)), region), service), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { canonicalRequest, stringToSign, signature, authorization, canonicalUri, queryString };
}

export function signRequest({ method, host, path, query = [], payloadHash, accessKeyId, secretAccessKey, now = new Date() }) {
  const headers = {
    host, 'x-amz-content-sha256': payloadHash,
    'x-amz-date': now.toISOString().replace(/[-:]|\.\d{3}/g, ''),
  };
  const signed = signHeaders({ method, path, query, headers, payloadHash, accessKeyId, secretAccessKey });
  return {
    url: `https://${host}${signed.canonicalUri}${signed.queryString ? `?${signed.queryString}` : ''}`,
    headers: { ...headers, Authorization: signed.authorization },
  };
}
