// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

const kv = vi.hoisted(() => ({ kvGet: vi.fn(), kvMget: vi.fn(), kvGetDel: vi.fn(), kvSetNxGet: vi.fn(), kvEval: vi.fn(), kvLrange: vi.fn() }));
const session = vi.hoisted(() => ({ token: 'ab'.repeat(32) as string | undefined }));
vi.mock('@/lib/kv', () => kv);
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => session.token ? { value: session.token } : undefined }) }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: vi.fn() }));

import { GET as challengeGET } from '@/app/api/agent/proof/challenge/route';
import { POST as verifyPOST } from '@/app/api/agent/proof/verify/route';
import { POST as unbindPOST } from '@/app/api/agent/proof/unbind/route';
import { GET as purchasesGET } from '@/app/api/agent/purchases/route';
import { GET as bindingsGET } from '@/app/api/agent/purchases/bindings/route';
import { agentProofTypedData, issueAgentProofChallenge } from '@/lib/agent/proof';
import { bindAgent } from '@/lib/agent/bindings';
import { sessionKey } from '@/lib/siwe';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { hashIp } from '@/lib/net/ipHash';
import { agentPurchasesKv } from '../../_helpers/agentPurchasesKv';
import { closeRedisLuaEngine } from '../../_helpers/redisLua';

const agent = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const A = agent.address.toLowerCase();
const O = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
const SHAPED_PROOF = encode({ v: 1, address: A, nonce: `0x${'1'.repeat(64)}`, signature: `0x${'2'.repeat(130)}` });
const POST_HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' };
function get(path: string, query = '') {
  return new Request(`https://test.local/api/agent/${path}${query}`, { headers: { 'x-forwarded-for': '203.0.113.10' } });
}
function post(path: string, body: unknown, headers: HeadersInit = POST_HEADERS) {
  return new Request(`https://test.local/api/agent/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const routes = [
  { name: 'challenge', run: () => challengeGET(get('proof/challenge', `?address=${A}`)), max: 20, day: 200, auth: false },
  { name: 'verify', run: () => verifyPOST(post('proof/verify', { proof: SHAPED_PROOF })), max: 10, day: 100, auth: true },
  { name: 'unbind', run: () => unbindPOST(post('proof/unbind', { address: A })), max: 30, day: null, auth: true },
  { name: 'purchases', run: () => purchasesGET(get('purchases', `?address=${A}`)), max: 60, day: 1000, auth: true },
  { name: 'bindings', run: () => bindingsGET(get('purchases/bindings')), max: 60, day: null, auth: true },
];
let store: ReturnType<typeof agentPurchasesKv>;
function signIn(owner = O) {
  session.token = 'ab'.repeat(32);
  store.strings.set(sessionKey(session.token), JSON.stringify({ address: owner }));
}
async function signedProof() {
  const challenge = await issueAgentProofChallenge(A);
  if (!challenge.ok) throw new Error('challenge');
  return encode({ v: 1, address: A, nonce: challenge.nonce, signature: await agent.signTypedData(agentProofTypedData(agent.address, challenge)) });
}
function noStore(response: Response) { expect(response.headers.get('Cache-Control')).toBe('private, no-store'); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ENABLE_AGENT_PURCHASES', '1');
  vi.stubEnv('IP_HASH_SECRET', 'agent-purchases-test-secret-32-bytes');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected fetch')));
  store = agentPurchasesKv(kv);
  signIn();
  vi.mocked(checkIpRateLimit).mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(closeRedisLuaEngine);

describe('Agent purchases routes', () => {
  it.each(routes)('$name: server flag OFF returns 404 before rate limit, auth or storage', async ({ run }) => {
    vi.stubEnv('ENABLE_AGENT_PURCHASES', '');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_AGENT_PURCHASES', '1');
    const response = await run();
    expect(response.status).toBe(404);
    noStore(response);
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(kv.kvGet).not.toHaveBeenCalled();
    expect(kv.kvSetNxGet).not.toHaveBeenCalled();
  });

  it.each(routes.filter((r) => r.auth))('$name: missing SIWE returns 401', async ({ run }) => {
    session.token = undefined;
    const response = await run();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reason: 'not_signed_in' });
    noStore(response);
    expect(kv.kvGetDel).not.toHaveBeenCalled();
    expect(kv.kvEval).not.toHaveBeenCalled();
  });

  it.each(routes.filter((r) => r.auth))('$name: SIWE KV failure is 503, not signed-out', async ({ run }) => {
    kv.kvGet.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const response = await run();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ reason: 'storage_error' });
    noStore(response);
  });

  it.each(routes)('$name: minute rate limit rejects before KV', async ({ run, name, max }) => {
    vi.mocked(checkIpRateLimit).mockResolvedValue(false);
    const response = await run();
    expect(response.status).toBe(429);
    noStore(response);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(checkIpRateLimit).toHaveBeenCalledWith(`agent-purchases-${name}`, hashIp('203.0.113.10'), max, 60);
    expect(checkIpRateLimit).toHaveBeenCalledTimes(1);
    expect(kv.kvGet).not.toHaveBeenCalled();
    expect(kv.kvSetNxGet).not.toHaveBeenCalled();
  });

  it.each(routes.filter((r) => r.day))('$name: daily rate limit also rejects before KV', async ({ run, name, day }) => {
    vi.mocked(checkIpRateLimit).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = await run();
    expect(response.status).toBe(429);
    noStore(response);
    expect(response.headers.get('Retry-After')).toBe('86400');
    expect(checkIpRateLimit).toHaveBeenNthCalledWith(2, `agent-purchases-${name}-day`, hashIp('203.0.113.10'), day, 86400);
    expect(kv.kvGet).not.toHaveBeenCalled();
  });

  it('challenge is anonymous, private, and returns only the three challenge fields', async () => {
    session.token = undefined;
    const response = await challengeGET(get('proof/challenge', `?address=${agent.address}`));
    expect(response.status).toBe(200);
    noStore(response);
    const result = await response.json();
    expect(Object.keys(result).sort()).toEqual(['nonce', 'issuedAt', 'expiresAt'].sort());
    expect(result.expiresAt - result.issuedAt).toBe(300);
    expect(kv.kvGet).not.toHaveBeenCalled();
    expect(kv.kvSetNxGet.mock.calls[0][0]).toBe(`agent:proof:nonce:${A}:${result.nonce}`);
    expect(checkIpRateLimit).toHaveBeenCalledTimes(2);
  });

  it.each(['', '?address=bad', `?address=${A}0`, `?address=${A}%0A`, `?address=${A}&address=${A}`, `?address=${A}&extra=1`])('malformed challenge query %s skips the KV limiter and nonce storage', async (query) => {
    const response = await challengeGET(get('proof/challenge', query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: 'malformed' });
    noStore(response);
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(kv.kvSetNxGet).not.toHaveBeenCalled();
  });

  it('malformed challenge query remains 404 when disabled', async () => {
    vi.stubEnv('ENABLE_AGENT_PURCHASES', '');
    const response = await challengeGET(get('proof/challenge', '?address=bad'));
    expect(response.status).toBe(404);
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(kv.kvSetNxGet).not.toHaveBeenCalled();
  });

  it.each(['', '?address=bad', `?address=${A}0`, `?address=${A}%0A`, `?address=${A}&address=${A}`, `?address=${A}&extra=1`])('invalid address query %s is private 400', async (query) => {
    for (const handler of [challengeGET, purchasesGET]) {
      const response = await handler(get('purchases', query));
      expect(response.status).toBe(400);
      noStore(response);
    }
    expect(kv.kvLrange).not.toHaveBeenCalled();
    expect(kv.kvSetNxGet).not.toHaveBeenCalled();
  });

  it.each([{}, { proof: 'a'.repeat(1025) }, { proof: 'e30' }, { proof: SHAPED_PROOF, extra: true }, null, []])('malformed verify body %j is rejected before SIWE', async (body) => {
    const response = await verifyPOST(post('proof/verify', body));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reason: 'malformed' });
    noStore(response);
    expect(kv.kvGet).not.toHaveBeenCalled();
  });

  it('rejects non-JSON and oversized JSON even without Content-Length', async () => {
    for (const request of [
      post('proof/verify', { proof: SHAPED_PROOF }, { 'content-type': 'text/plain' }),
      post('proof/verify', { proof: 'a'.repeat(3000) }),
      new Request('https://test.local/api/agent/proof/verify', { method: 'POST', headers: POST_HEADERS, body: '{' }),
    ]) {
      const response = await verifyPOST(request);
      expect(response.status).toBe(401);
      noStore(response);
    }
    expect(kv.kvGet).not.toHaveBeenCalled();
  });

  it('actual proof binds, permits purchases, rebinds away from old owner, then unbinds', async () => {
    let response = await verifyPOST(post('proof/verify', { proof: await signedProof() }));
    expect(response.status).toBe(200);
    noStore(response);
    const bound = await response.json();
    expect(bound).toMatchObject({ address: A, boundAt: expect.any(String) });
    response = await bindingsGET(get('purchases/bindings'));
    expect(await response.json()).toEqual({ addresses: [bound] });
    noStore(response);
    store.lists.set(`x402:settle:payer:${A}`, [JSON.stringify({
      at: '2026-09-23T00:00:00.000Z', source: 'jpyc-facilitator', network: 'eip155:137', asset: 'JPYC', amount: '100', fee: '1',
      payer: A, payTo: OTHER, resource: 'https://third.test/private/customer?token=secret#secret', tx: '0x123',
    })]);
    response = await purchasesGET(get('purchases', `?address=${A}`));
    expect(response.status).toBe(200);
    noStore(response);
    const history = await response.json();
    expect(history).toMatchObject({ ok: true, since: '2026-09-22', truncated: false, boundAt: bound.boundAt, items: [{ amount: '100', fee: '1', resource: { host: 'third.test', path: null, pathTag: expect.stringMatching(/^[0-9a-f]{8}$/) }, resourceOrigin: 'claimed' }] });
    expect(JSON.stringify(history)).not.toMatch(/payTo|payer|private|customer|secret/);

    signIn(OTHER);
    response = await verifyPOST(post('proof/verify', { proof: await signedProof() }));
    expect(response.status).toBe(200);
    signIn(O);
    expect(await (await bindingsGET(get('purchases/bindings'))).json()).toEqual({ addresses: [] });
    response = await purchasesGET(get('purchases', `?address=${A}`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reason: 'not_bound' });
    response = await unbindPOST(post('proof/unbind', { address: A }));
    expect(response.status).toBe(404);
    noStore(response);
    signIn(OTHER);
    response = await unbindPOST(post('proof/unbind', { address: agent.address }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    noStore(response);
    expect(store.strings.has(`agent:bound:${A}`)).toBe(false);
    expect(store.strings.has(`agent:owner:${OTHER}`)).toBe(false);
  });

  it('missing and other-owner bindings have the same private response without reading history', async () => {
    const first = await purchasesGET(get('purchases', `?address=${A}`));
    await bindAgent(A, OTHER);
    const second = await purchasesGET(get('purchases', `?address=${A}`));
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(await first.json()).toEqual(await second.json());
    noStore(first); noStore(second);
    expect(kv.kvLrange).not.toHaveBeenCalled();
  });

  it('verify storage save failure is 503 after consuming proof; no false binding success', async () => {
    const proof = await signedProof();
    kv.kvEval.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const response = await verifyPOST(post('proof/verify', { proof }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ reason: 'storage_error' });
    noStore(response);
    expect(kv.kvGetDel).toHaveBeenCalledTimes(1);
    expect(store.strings.has(`agent:bound:${A}`)).toBe(false);
  });

  it.each(['challenge', 'nonce', 'ownership', 'history', 'bindings', 'unbind'])('%s KV failure returns private 503', async (step) => {
    await bindAgent(A, O);
    let response: Response;
    if (step === 'challenge') {
      kv.kvSetNxGet.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      response = await challengeGET(get('proof/challenge', `?address=${A}`));
    } else if (step === 'nonce') {
      const proof = await signedProof();
      kv.kvGetDel.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      response = await verifyPOST(post('proof/verify', { proof }));
    } else if (step === 'history') {
      kv.kvLrange.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      response = await purchasesGET(get('purchases', `?address=${A}`));
    } else if (step === 'unbind') {
      kv.kvEval.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      response = await unbindPOST(post('proof/unbind', { address: A }));
    } else {
      kv.kvGet.mockResolvedValueOnce({ ok: true, value: JSON.stringify({ address: O }) }).mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      response = step === 'bindings' ? await bindingsGET(get('purchases/bindings')) : await purchasesGET(get('purchases', `?address=${A}`));
    }
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ reason: 'storage_error' });
    noStore(response);
  });

  it('request Host never changes the signed audience', async () => {
    const proof = await signedProof();
    const response = await verifyPOST(post('proof/verify', { proof }, { ...POST_HEADERS, host: 'attacker.test', 'x-forwarded-host': 'attacker.test' }));
    expect(response.status).toBe(200);
    noStore(response);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['expired_or_unknown', 'signature_mismatch', 'already_used'])('verify %s is private 401 without binding', async (reason) => {
    const proof = await signedProof();
    let submitted = proof;
    if (reason === 'expired_or_unknown') {
      const key = [...store.strings.keys()].find((key) => key.startsWith('agent:proof:nonce:'))!;
      store.strings.delete(key);
    } else if (reason === 'signature_mismatch') {
      submitted = encode({ ...JSON.parse(Buffer.from(proof, 'base64url').toString()), signature: `0x${'0'.repeat(130)}` });
    } else {
      kv.kvGetDel.mockResolvedValueOnce({ ok: true, value: null });
    }
    const response = await verifyPOST(post('proof/verify', { proof: submitted }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reason });
    noStore(response);
    expect(kv.kvEval).not.toHaveBeenCalled();
  });

  it('a full owner list rejects bind without moving the agent away from its previous owner', async () => {
    await bindAgent(A, OTHER);
    store.strings.set(`agent:owner:${O}`, JSON.stringify(Array.from({ length: 20 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`)));
    const response = await verifyPOST(post('proof/verify', { proof: await signedProof() }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reason: 'binding_limit' });
    noStore(response);
    expect(JSON.parse(store.strings.get(`agent:bound:${A}`)!).owner).toBe(OTHER);
  });

  it.each([{ address: `${A}\n` }, { address: A, extra: true }, {}, { address: 'a'.repeat(2049) }])('unbind rejects malformed JSON body %j', async (body) => {
    const response = await unbindPOST(post('proof/unbind', body));
    expect(response.status).toBe(400);
    noStore(response);
    expect(kv.kvEval).not.toHaveBeenCalled();
  });
});
