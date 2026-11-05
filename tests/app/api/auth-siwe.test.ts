import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { encodeErrorResult, parseAbi, serializeErc8010Signature, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { supportedChains } from '@/lib/chains';
import * as Sentry from '@sentry/nextjs';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const h = vi.hoisted(() => {
  const ipRate = { allowed: true };
  return {
    cookieToken: undefined as string | undefined,
    kvConfigured: false,
    kvDel: vi.fn(),
    kvGet: vi.fn(),
    kvSet: vi.fn(),
    ipRate,
    checkIpRateLimit: vi.fn(
      async (_scope: string, hashedIp: string | null) =>
        hashedIp === null || ipRate.allowed,
    ),
    // null = 従来の offline provider (どの RPC も失敗)。C-1 のテストだけ RPC の応答を差し替える。
    rpc: null as ((args: { method: string; params?: unknown }) => Promise<unknown>) | null,
  };
});

// KV を境界 mock: 未設定状態を固定し env-gate (503) と「cookie 無し」分岐を決定的に検証。
// 署名検証フローの全分岐は lib/siwe (siwe.test) で担保。ここは route のアダプタ薄層を確認。
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => h.kvConfigured,
  kvGet: h.kvGet,
  kvSet: h.kvSet,
  kvDel: h.kvDel,
}));

vi.mock('@/lib/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains')>();
  const { custom } = await import('viem');
  return {
    ...actual,
    // Exercise viem's local EOA verification without any network requests.
    transportForChain: () => custom({
      request: async (args: { method: string; params?: unknown }) => {
        if (h.rpc) return h.rpc(args);
        throw new Error('offline test provider');
      },
    }, { retryCount: 0 }),
  };
});

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: h.checkIpRateLimit,
}));

// next/headers cookies() を request-scope 外でも使えるよう stub (cookie 無し状態)。
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === (process.env.NODE_ENV === 'production' ? '__Host-op_sess' : 'op_sess') && h.cookieToken !== undefined
        ? { value: h.cookieToken }
        : undefined,
  }),
}));

import { POST as noncePOST } from '@/app/api/auth/siwe/nonce/route';
import { POST as verifyPOST } from '@/app/api/auth/siwe/verify/route';
import { GET as meGET } from '@/app/api/auth/siwe/me/route';
import { POST as logoutPOST } from '@/app/api/auth/siwe/logout/route';
import { requireSession } from '@/lib/siweSession';
import { newSessionToken, sessionKey } from '@/lib/siwe';

const SESSION_TOKEN = '0123456789abcdef'.repeat(4);
const MALFORMED_TOKENS = [
  '',
  'not-a-session',
  'a'.repeat(63),
  'a'.repeat(65),
  'A'.repeat(64),
  'a'.repeat(63) + 'B',
  'g'.repeat(64),
  '0x' + 'a'.repeat(64),
  ' ' + 'a'.repeat(64),
  'a'.repeat(64) + '\n',
];

function nonceReq(ip?: string): Request {
  return new Request('http://localhost/api/auth/siwe/nonce', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-vercel-forwarded-for': ip } : {}) },
    body: '{}',
  });
}

describe('SIWE routes', () => {
  beforeEach(() => {
    h.cookieToken = undefined;
    h.kvConfigured = false;
    h.kvDel.mockReset();
    h.kvDel.mockResolvedValue({ ok: true, value: 0 });
    h.kvGet.mockReset();
    h.kvGet.mockResolvedValue({ ok: false, reason: 'unconfigured' });
    h.kvSet.mockReset();
    h.kvSet.mockResolvedValue({ ok: false, reason: 'unconfigured' });
    h.ipRate.allowed = true;
    h.checkIpRateLimit.mockClear();
    h.rpc = null;
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each([['nonce', noncePOST], ['verify', verifyPOST], ['logout', logoutPOST]] as const)('%s CSRF', (path, post) => {
    function request(site: string | null, contentType: string | null, origin: string | null = null) {
      const headers = new Headers();
      if (site !== null) headers.set('sec-fetch-site', site);
      if (contentType !== null) headers.set('content-type', contentType);
      if (origin !== null) headers.set('origin', origin);
      return new Request(`http://localhost/api/auth/siwe/${path}`, {
        method: 'POST', headers,
        ...(contentType === null ? {} : { body: new TextEncoder().encode('{"message":"x","signature":"0x1","p":"="}') }),
      });
    }
    // 共通の CSRF 検査 (lib/net/crossOriginWrite) は Sec-Fetch-Site が same-origin のときだけ通す
    // (same-site のサブドメインと none も拒否する)。
    it.each([
      ['cross-site', 'application/json'], ['cross-site', 'text/plain'], ['cross-site', null],
      ['same-site', 'application/json'], ['same-site', 'text/plain'], ['same-site', null],
      ['none', 'application/json'], ['none', null],
    ])('rejects %s %s before storage or cookies', async (site, type) => {
      h.kvConfigured = true;
      h.cookieToken = 'live-session';
      const res = await post(request(site, type));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'cross_site_request' });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(h.kvSet).not.toHaveBeenCalled();
      expect(h.kvDel).not.toHaveBeenCalled();
      expect(h.checkIpRateLimit).not.toHaveBeenCalled();
    });
    it.each(['text/plain', 'text/plain; application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', ''])('rejects non-JSON %s without Fetch Metadata', async (type) => {
      h.kvConfigured = true;
      h.cookieToken = 'live-session';
      const res = await post(request(null, type));
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ ok: false, error: 'unsupported_media_type' });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(h.kvSet).not.toHaveBeenCalled();
      expect(h.kvDel).not.toHaveBeenCalled();
    });
    it.each(['https://attacker.example', 'http://sub.localhost', 'null'])('rejects Origin %s without Fetch Metadata before storage or cookies', async (origin) => {
      h.kvConfigured = true;
      h.cookieToken = 'live-session';
      const res = await post(request(null, 'application/json', origin));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'cross_site_request' });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(h.kvSet).not.toHaveBeenCalled();
      expect(h.kvDel).not.toHaveBeenCalled();
      expect(h.checkIpRateLimit).not.toHaveBeenCalled();
    });
    it.each(['same-origin', null])('handles legacy bodyless POST without Content-Type for %s', async (site) => {
      h.kvConfigured = true;
      h.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
      h.cookieToken = SESSION_TOKEN;
      const req = request(site, null);
      expect(req.headers.has('content-type')).toBe(false);
      expect(req.body).toBeNull();
      const res = await post(req);
      expect(res.status).toBe(path === 'verify' ? 415 : 200);
      if (path === 'nonce') expect(h.kvSet).toHaveBeenCalledOnce();
      if (path === 'logout') {
        expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
        expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
      }
      if (path === 'verify') {
        expect(res.headers.has('set-cookie')).toBe(false);
        expect(h.kvDel).not.toHaveBeenCalled();
        expect(h.kvSet).not.toHaveBeenCalled();
      }
    });
    it.each(['same-origin'])('rejects text/plain even for %s', async (site) => {
      h.kvConfigured = true;
      const res = await post(request(site, 'text/plain'));
      expect(res.status).toBe(415);
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(h.kvSet).not.toHaveBeenCalled();
      expect(h.kvDel).not.toHaveBeenCalled();
    });
    it.each([
      ['same-origin', null], [null, null], [null, 'http://localhost'],
    ])('preserves the JSON flow for Sec-Fetch-Site %s / Origin %s', async (site, origin) => {
      h.kvConfigured = true;
      h.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
      const res = await post(request(site, 'Application/JSON; charset=utf-8', origin));
      // Invalid SIWE messages still reach the existing validator; nonce/logout succeed.
      expect(res.status).toBe(path === 'verify' ? 400 : 200);
      if (path === 'nonce') expect(h.kvSet).toHaveBeenCalledOnce();
      if (path === 'logout') expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    });
  });

  it('nonce: KV 未設定 → 503 kv_not_configured', async () => {
    const res = await noncePOST(nonceReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('nonce: IP rate limit → nonce 生成/KV 書込前に 429 + Retry-After', async () => {
    h.kvConfigured = true;
    h.ipRate.allowed = false;
    vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');

    const res = await noncePOST(nonceReq('203.0.113.10'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(h.checkIpRateLimit).toHaveBeenCalledWith(
      'siwe-nonce',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      60,
      60,
    );
    expect(h.kvSet).not.toHaveBeenCalled();
  });

  it('nonce: IP_HASH_SECRET 未設定なら IP limiter は inert で既存フローを維持', async () => {
    h.kvConfigured = true;
    h.ipRate.allowed = false;
    h.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
    vi.stubEnv('IP_HASH_SECRET', '');

    const res = await noncePOST(nonceReq('203.0.113.10'));

    expect(res.status).toBe(200);
    expect(h.checkIpRateLimit).toHaveBeenCalledWith('siwe-nonce', null, 60, 60);
    expect(h.kvSet).toHaveBeenCalledOnce();
  });

  it.each(['same-origin', null])('verify: valid JSON login issues a session for %s', async (site) => {
    h.kvConfigured = true;
    h.kvGet.mockResolvedValue({ ok: true, value: '1' }); // 発行済みの nonce (存在だけを読む・C8)
    h.kvDel.mockResolvedValue({ ok: true, value: 1 });
    h.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
    // Fixed, test-only account; no real wallet, keystore, or RPC is used for this EOA signature.
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const issuedAt = new Date();
    const message = createSiweMessage({
      domain: 'localhost', uri: 'http://localhost', address: account.address,
      version: '1', chainId: supportedChains[0].id, nonce: 'csrf1234', issuedAt,
      expirationTime: new Date(issuedAt.getTime() + 600_000),
    });
    const signature = await account.signMessage({ message });
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    if (site) headers.set('sec-fetch-site', site);
    const res = await verifyPOST(new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST', headers, body: JSON.stringify({ message, signature }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: account.address });
    expect(res.headers.get('set-cookie')).toContain('op_sess=');
    expect(h.kvGet).toHaveBeenCalledWith('siwe:nonce:csrf1234');
    expect(h.kvDel).toHaveBeenCalledWith('siwe:nonce:csrf1234');
    expect(h.kvSet).toHaveBeenCalledOnce();
  });

  // 第 9 回レビュー C-1: 署名検証の public client が CCIP-Read (EIP-3668) を追うと、7702 委任済み EOA +
  // ERC-8010 形の署名 → viem verifyErc1271 → EOA 自身への eth_call → 委任先の OffchainLookup revert で、
  // revert data の任意の URL へサーバーが fetch する (正しい署名なしで届く SSRF)。verifySiweMessage は
  // mock せず viem の実際の経路を通し、RPC だけを custom transport で差し替える。
  describe('verify: CCIP-Read を追わない (C-1)', () => {
    const OFFCHAIN_LOOKUP_ABI = parseAbi([
      'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
    ]);
    const ATTACKER_URLS = ['http://169.254.169.254/latest/meta-data/{data}', 'https://ssrf.attacker.invalid/{sender}/{data}.json'];
    // 委任先 (攻撃者の contract のつもり)。実際の RPC と同じく eth_getCode は小文字の hex で返す。
    const DELEGATE = '0x000000000000000000000000000000000000c0de';
    // Fixed, test-only account; signs only a local 7702 authorization, no RPC or real wallet.
    const attacker = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    let fetchSpy: MockInstance<typeof fetch>;

    beforeEach(() => {
      // 外へは出さない (変異で ccipRead を戻したときも本物の通信をしない)。呼ばれた回数だけを見る。
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('blocked in test', { status: 500 }));
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    // 正しい署名を持たない攻撃者の形: 自分の EOA を 7702 で委任し、中身の署名は 65 byte の 0。
    async function attackerLogin() {
      h.kvConfigured = true;
      h.kvGet.mockResolvedValue({ ok: true, value: '1' }); // 発行済みの nonce (nonce だけで deps.verify まで届く)
      h.kvDel.mockResolvedValue({ ok: true, value: 1 });
      h.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
      const chainId = supportedChains[0].id;
      const authorization = await attacker.signAuthorization({ address: DELEGATE, chainId, nonce: 0 });
      const signature = serializeErc8010Signature({ authorization, signature: `0x${'00'.repeat(65)}` });
      const issuedAt = new Date();
      const message = createSiweMessage({
        domain: 'localhost', uri: 'http://localhost', address: attacker.address,
        version: '1', chainId, nonce: 'ccipread1234', issuedAt,
        expirationTime: new Date(issuedAt.getTime() + 600_000),
      });
      return verifyPOST(new Request('http://localhost/api/auth/siwe/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ message, signature }),
      }));
    }

    it('委任先が OffchainLookup で revert しても外へ fetch せず 401 invalid_signature (nonce も cookie もそのまま)', async () => {
      // sender = 呼び先 (EOA 自身) なので、ccipRead が有効なら viem は urls へ fetch する形。
      const lookupRevert: Hex = encodeErrorResult({
        abi: OFFCHAIN_LOOKUP_ABI,
        errorName: 'OffchainLookup',
        args: [attacker.address, ATTACKER_URLS, '0x', '0x12345678', '0x'],
      });
      expect(lookupRevert.slice(0, 10)).toBe('0x556f1830'); // viem utils/ccip.ts の offchainLookupSignature
      const calls: Array<{ method: string; params?: unknown }> = [];
      h.rpc = async (args) => {
        calls.push(args);
        // 委任済み (0xef0100 ‖ 委任先) と答え、viem を verifyErc8010 → verifyErc1271 の経路に進ませる。
        if (args.method === 'eth_getCode') return `0xef0100${DELEGATE.slice(2)}`;
        // JSON-RPC の revert 応答 (code 3 + data) と同じ形。
        if (args.method === 'eth_call') throw Object.assign(new Error('execution reverted'), { code: 3, data: lookupRevert });
        throw new Error('unexpected rpc in test: ' + args.method);
      };

      const res = await attackerLogin();

      expect(fetchSpy).not.toHaveBeenCalled();
      // fetch 0 回が空振りでないこと: EOA 自身への isValidSignature (0x1626ba7e) の eth_call まで実際に届いた。
      const erc1271Calls = calls.filter((c) => {
        if (c.method !== 'eth_call' || !Array.isArray(c.params)) return false;
        const tx = c.params[0] as { to?: string; data?: string };
        return tx.to?.toLowerCase() === attacker.address.toLowerCase() && tx.data?.startsWith('0x1626ba7e');
      });
      expect(erc1271Calls).toHaveLength(1);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_signature' });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(h.kvDel).not.toHaveBeenCalled();
      expect(h.kvSet).not.toHaveBeenCalled();
    });

    it('同じ経路で RPC が落ちて検証が throw しても route の catch で 503 verify_failed (500 にしない)', async () => {
      h.rpc = async () => {
        throw new Error('rpc down in test');
      };

      const res = await attackerLogin();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'verify_failed' });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(h.kvDel).not.toHaveBeenCalled();
      expect(h.kvSet).not.toHaveBeenCalled();
    });
  });

  it('verify: 本文が JSON の null → 400 invalid_json (verify_failed の 503 + Sentry にしない・B-R6f)', async () => {
    h.kvConfigured = true;
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('sec-fetch-site', 'same-origin');
    const res = await verifyPOST(new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST', headers, body: 'null',
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });
    expect(h.kvSet).not.toHaveBeenCalled();
  });

  it('verify: JSON-shaped bytes without Content-Type still fail before session writes', async () => {
    h.kvConfigured = true;
    const res = await verifyPOST(new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST', body: new TextEncoder().encode('{"message":"x","signature":"0x1"}'),
    }));
    expect(res.status).toBe(415);
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(h.kvDel).not.toHaveBeenCalled();
    expect(res.headers.has('set-cookie')).toBe(false);
  });

  it('verify: KV 未設定 → 503 (署名検証に到達しない)', async () => {
    const req = new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x', signature: '0x1' }),
    });
    const res = await verifyPOST(req);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('verify: unsigned foreign domain keeps 401 domain_mismatch without a Sentry event', async () => {
    h.kvConfigured = true;
    const message = createSiweMessage({
      domain: 'attacker.invalid', uri: 'https://attacker.invalid', version: '1',
      address: '0x0000000000000000000000000000000000000001',
      chainId: 80002, nonce: 'abcdefgh12345678',
      issuedAt: new Date(), expirationTime: new Date(Date.now() + 600_000),
    });
    const res = await verifyPOST(new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature: '0x1234' }),
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'domain_mismatch' });
    expect(res.headers.has('set-cookie')).toBe(false);
    expect(h.kvDel).not.toHaveBeenCalled();
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('verify: KV 設定時の 8KiB 超 body → JSON/署名検証前に 413', async () => {
    h.kvConfigured = true;
    const req = new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(9 * 1024), signature: '0x1' }),
    });
    const res = await verifyPOST(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'payload_too_large',
    });
  });

  it('verify: IP rate limit → body cap/署名検証前に 429 + Retry-After', async () => {
    h.kvConfigured = true;
    h.ipRate.allowed = false;
    vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
    const req = new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': '203.0.113.11',
      },
      body: JSON.stringify({ message: 'x'.repeat(9 * 1024), signature: '0x1' }),
    });

    const res = await verifyPOST(req);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(h.checkIpRateLimit).toHaveBeenCalledWith(
      'siwe-verify',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      30,
      60,
    );
    expect(h.kvDel).not.toHaveBeenCalled();
  });

  it('me: cookie 無し → 200 address:null (未ログインも正常状態)', async () => {
    const res = await meGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: null });
    expect(h.kvGet).not.toHaveBeenCalled();
  });

  describe.each(['test', 'production'])('session cookie shape (%s)', (nodeEnv) => {
    it.each(MALFORMED_TOKENS)('logout: malformed cookie %j is cleared without KV deletion', async (token) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = token;

      const res = await logoutPOST(new Request('http://localhost/api/auth/siwe/logout', { method: 'POST' }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(h.kvDel).not.toHaveBeenCalled();
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(nodeEnv === 'production' ? '__Host-op_sess=' : 'op_sess=');
      expect(setCookie.toLowerCase()).toContain('max-age=0');
      expect(setCookie.toLowerCase()).toContain('path=/');
      if (nodeEnv === 'production') expect(setCookie.toLowerCase()).toContain('secure');
    });

    it('logout: valid session is deleted from KV and the cookie is cleared', async () => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = SESSION_TOKEN;
      h.kvDel.mockResolvedValue({ ok: true, value: 1 });

      const res = await logoutPOST(new Request('http://localhost/api/auth/siwe/logout', { method: 'POST' }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(h.kvDel).toHaveBeenCalledOnce();
      expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
      expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
    });

    it.each(MALFORMED_TOKENS)('malformed cookie %j stays signed out without a KV read', async (token) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = token;
      h.kvGet.mockResolvedValue({ ok: true, value: null });

      const res = await meGET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, address: null });
      expect(res.headers.get('cache-control')).toBe('private, no-store');

      const session = await requireSession();
      expect(session.ok).toBe(false);
      if (session.ok) throw new Error('expected signed-out session');
      expect(session.response.status).toBe(401);
      expect(await session.response.json()).toEqual({ ok: false, error: 'unauthenticated' });
      expect(h.kvGet).not.toHaveBeenCalled();
    });

    it('server-issued cookie still authenticates through KV', async () => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = newSessionToken();
      const address = '0x1111111111111111111111111111111111111111';
      h.kvGet.mockResolvedValue({ ok: true, value: JSON.stringify({ address }) });

      const res = await meGET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, address });
      expect(await requireSession()).toEqual({ ok: true, address });
      expect(h.kvGet).toHaveBeenCalledTimes(2);
      expect(h.kvGet).toHaveBeenCalledWith(sessionKey(h.cookieToken));
    });
  });

  it('me: Cache-Control: private, no-store を返す (CDN キャッシュ汚染防止)', async () => {
    const res = await meGET();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('me: cookie 有りで KV 読取障害 → 503 (未ログイン成功に偽装しない)', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvGet.mockResolvedValue({ ok: false, reason: 'network_error' });

    const res = await meGET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'session_storage_unavailable',
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.kvGet).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
  });

  it('requireSession: cookie 有りで KV 読取障害 → 503 (401 と区別)', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvGet.mockResolvedValue({ ok: false, reason: 'timeout' });

    const session = await requireSession();

    expect(session.ok).toBe(false);
    if (session.ok) throw new Error('expected session read failure');
    expect(session.response.status).toBe(503);
    expect(await session.response.json()).toEqual({
      ok: false,
      error: 'session_storage_unavailable',
    });
  });

  it('me: cookie の KV record が miss → 従来どおり 200 address:null', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvGet.mockResolvedValue({ ok: true, value: null });

    const res = await meGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: null });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.kvGet).toHaveBeenCalledOnce();
    expect(h.kvGet).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
    const session = await requireSession();
    expect(session.ok).toBe(false);
    if (session.ok) throw new Error('expected unknown session');
    expect(session.response.status).toBe(401);
    expect(await session.response.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(h.kvGet).toHaveBeenCalledTimes(2);
  });

  it('logout: cookie 無しでも 200 (冪等) + op_sess を maxAge0 で失効', async () => {
    const res = await logoutPOST(new Request('http://localhost/api/auth/siwe/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('op_sess=');
    expect(setCookie.toLowerCase()).toContain('max-age=0');
  });

  // C7: 本番の cookie 名は `__Host-op_sess`。ブラウザの受理条件 (Secure + Path=/ +
  // Domain 属性なし) を 3 つとも満たしていなければ prefix cookie は黙って捨てられる。
  it('logout: 本番は __Host-op_sess を Secure + Path=/ + Domain 無しで失効させる', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await logoutPOST(new Request('http://localhost/api/auth/siwe/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-op_sess=');
    const lower = setCookie.toLowerCase();
    expect(lower).toContain('secure');
    expect(lower).toContain('path=/');
    expect(lower).not.toContain('domain=');
  });

  it('logout: セッションが既に無い (DEL=0) → 200 (冪等) + cookie 失効', async () => {
    h.cookieToken = SESSION_TOKEN;
    const res = await logoutPOST(new Request('http://localhost/api/auth/siwe/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
  });

  it('logout: KV 削除失敗 → 503 だが cookie は失効', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvDel.mockResolvedValue({ ok: false, reason: 'network_error' });
    const res = await logoutPOST(new Request('http://localhost/api/auth/siwe/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'session_revoke_failed' });
    expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
  });
});
