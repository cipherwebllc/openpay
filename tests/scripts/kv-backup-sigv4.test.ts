// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { awsEncode, canonicalQuery, EMPTY_SHA256, signHeaders, signRequest } from '@/scripts/lib/sigv4.mjs';

// AWS aws-sig-v4-test-suite fixtures, mirrored by the AWS-maintained botocore repository:
// https://github.com/boto/botocore/tree/develop/tests/unit/auth/aws4_testsuite
// Each case embeds its .req input and .authz expected signature, not a locally generated oracle.
// get-vanilla is also published at:
// https://github.com/awslabs/aws-c-auth/blob/main/tests/aws-signing-test-suite/v4/get-vanilla/header-signed-request.txt
const fixtures = [
  { name: 'get-vanilla', method: 'GET', query: [], signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31' },
  // https://raw.githubusercontent.com/boto/botocore/develop/tests/unit/auth/aws4_testsuite/get-vanilla-query-order-key/get-vanilla-query-order-key.authz
  { name: 'get-vanilla-query-order-key', method: 'GET', query: [['Param1', 'value2'], ['Param1', 'Value1']], signature: 'eedbc4e291e521cf13422ffca22be7d2eb8146eecf653089df300a15b2382bd1' },
  // https://raw.githubusercontent.com/boto/botocore/develop/tests/unit/auth/aws4_testsuite/get-vanilla-query-order-key-case/get-vanilla-query-order-key-case.authz
  { name: 'get-vanilla-query-order-key-case', method: 'GET', query: [['Param2', 'value2'], ['Param1', 'value1']], signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500' },
  // https://raw.githubusercontent.com/boto/botocore/develop/tests/unit/auth/aws4_testsuite/post-vanilla/post-vanilla.authz
  { name: 'post-vanilla', method: 'POST', query: [], signature: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b' },
];
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const date = new Date('2015-08-30T12:36:00Z');

describe('AWS SigV4', () => {
  it.each(fixtures)('matches AWS public $name vector', ({ method, query, signature }) => {
    const result = signHeaders({ method, path: '/', query, payloadHash: EMPTY_SHA256, ...credentials,
      region: 'us-east-1', service: 'service', headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' } });
    expect(result.signature).toBe(signature);
    expect(result.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`);
  });
  it('sorts and normalizes mixed-case headers independent of insertion order', () => {
    const base = { method: 'POST', payloadHash: EMPTY_SHA256, ...credentials };
    const a = signHeaders({ ...base, headers: { Zebra: '  a   b  ', Host: 'example.test', 'X-Amz-Date': '20150830T123600Z', alpha: 'v' } });
    const b = signHeaders({ ...base, headers: { alpha: 'v', 'x-amz-date': '20150830T123600Z', host: 'example.test', zebra: 'a b' } });
    expect(a.signature).toBe(b.signature);
    expect(a.canonicalRequest).toContain('alpha:v\nhost:example.test\nx-amz-date:20150830T123600Z\nzebra:a b\n');
  });
  it('uses AWS URI/query encoding for real R2 names and opaque continuation tokens', () => {
    expect(awsEncode("a /+%='!*()日本")).toBe('a%20%2F%2B%25%3D%27%21%2A%28%29%E6%97%A5%E6%9C%AC');
    const query = [['prefix', 'openpay-kv/2026/'], ['list-type', '2'], ['continuation-token', 'a/+==% z']];
    expect(canonicalQuery(query)).toBe('continuation-token=a%2F%2B%3D%3D%25%20z&list-type=2&prefix=openpay-kv%2F2026%2F');
    const signed = signRequest({ method: 'GET', host: 'account.r2.cloudflarestorage.com', path: '/backup/', query,
      payloadHash: EMPTY_SHA256, ...credentials, now: date });
    expect(signed.url).toBe('https://account.r2.cloudflarestorage.com/backup/?continuation-token=a%2F%2B%3D%3D%25%20z&list-type=2&prefix=openpay-kv%2F2026%2F');
    expect(new URL(signed.url).searchParams.get('continuation-token')).toBe('a/+==% z');
    expect(signed.headers.Authorization).toContain('/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date,');
    expect(signed.headers['x-amz-content-sha256']).toBe(EMPTY_SHA256);
  });
  it('signs the completed payload hash and keeps object slashes unchanged', () => {
    const input = { method: 'PUT', host: 'account.r2.cloudflarestorage.com', path: '/bucket/openpay-kv/2026/20260915T031700Z-r1-a2-full.jsonl.gz.enc', ...credentials, now: date };
    const a = signRequest({ ...input, payloadHash: 'a'.repeat(64) });
    const b = signRequest({ ...input, payloadHash: 'b'.repeat(64) });
    expect(a.url).toBe(`https://${input.host}${input.path}`);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
    expect(() => signRequest({ ...input, payloadHash: 'UNSIGNED-PAYLOAD' })).toThrow();
  });
});
