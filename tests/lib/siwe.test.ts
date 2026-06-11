import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSiweMessage, generateSiweNonce, verifySiweMessage } from 'viem/siwe';
import { createPublicClient, getAddress, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { supportedChains, isSupportedChainId } from '@/lib/chains';
import {
  newSessionToken,
  sessionKey,
  nonceKey,
  parseSessionRecord,
  verifySiweLogin,
  isAllowedSiweDomain,
  type SiweVerifyDeps,
} from '@/lib/siwe';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const DOMAIN = 'openpay.test';

// issuedAt/expirationTime は verifySiweLogin の鮮度チェックに必須 (REM-21)。
// 正規クライアントと同様に issued=now、exp=now+10min を既定値とする。
const NOW = new Date('2026-06-11T00:00:00.000Z');
const EXP_10M = new Date(NOW.getTime() + 10 * 60 * 1000);

function message(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  return createSiweMessage({
    domain: DOMAIN,
    address: ADDR,
    uri: `https://${DOMAIN}`,
    version: '1',
    chainId: 137,
    nonce: 'abc12345',
    issuedAt: NOW,
    expirationTime: EXP_10M,
    ...overrides,
  });
}

function deps(overrides: Partial<SiweVerifyDeps> = {}): SiweVerifyDeps {
  return {
    isSupportedChainId: (id) => id === 137,
    isAllowedDomain: (d) => d === DOMAIN,
    verify: vi.fn().mockResolvedValue(true),
    consumeNonce: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue('tok-123'),
    ...overrides,
  };
}

describe('lib/siwe helpers', () => {
  it('newSessionToken は 64hex でほぼ一意', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('sessionKey / nonceKey は prefix 付き', () => {
    expect(sessionKey('t')).toBe('siwe:sess:t');
    expect(nonceKey('n')).toBe('siwe:nonce:n');
  });

  it('parseSessionRecord: 正常 JSON → checksum address', () => {
    const rec = parseSessionRecord(JSON.stringify({ address: ADDR.toLowerCase() }));
    expect(rec).toEqual({ address: getAddress(ADDR) });
  });

  it('parseSessionRecord: null / 壊れた JSON / 非アドレス → null', () => {
    expect(parseSessionRecord(null)).toBeNull();
    expect(parseSessionRecord('{not json')).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ address: 'nope' }))).toBeNull();
  });
});

describe('isAllowedSiweDomain (Host ヘッダ非依存・サーバ制御)', () => {
  const ORIG = process.env.SIWE_ALLOWED_DOMAINS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.SIWE_ALLOWED_DOMAINS;
    else process.env.SIWE_ALLOWED_DOMAINS = ORIG;
  });

  it('canonical 本番 host (open-pay.jp) は許可', () => {
    expect(isAllowedSiweDomain('open-pay.jp')).toBe(true);
  });

  it('攻撃者 domain (evil.com) は拒否 — phishing replay を弾く', () => {
    delete process.env.SIWE_ALLOWED_DOMAINS;
    expect(isAllowedSiweDomain('evil.com')).toBe(false);
  });

  it('開発時 (NODE_ENV != production) は localhost:port を許可', () => {
    // vitest の NODE_ENV は 'test' (= 非 production) なので localhost が通る。
    expect(isAllowedSiweDomain('localhost:3000')).toBe(true);
    expect(isAllowedSiweDomain('127.0.0.1:3001')).toBe(true);
  });

  it('SIWE_ALLOWED_DOMAINS で追加 host を許可 (preview/別 domain)', () => {
    process.env.SIWE_ALLOWED_DOMAINS = 'staging.open-pay.jp, pay.example';
    expect(isAllowedSiweDomain('staging.open-pay.jp')).toBe(true);
    expect(isAllowedSiweDomain('pay.example')).toBe(true);
    expect(isAllowedSiweDomain('evil.com')).toBe(false);
  });
});

describe('verifySiweLogin (DI core)', () => {
  it('成功: 構造 OK + domain 一致 + 署名 OK + nonce 消費 OK → token + checksum address', async () => {
    const d = deps();
    const r = await verifySiweLogin(
      { message: message(), signature: '0xdead' },
      d,
    );
    expect(r).toEqual({ ok: true, token: 'tok-123', address: getAddress(ADDR) });
    expect(d.verify).toHaveBeenCalledOnce();
    expect(d.consumeNonce).toHaveBeenCalledWith('abc12345');
    expect(d.createSession).toHaveBeenCalledWith(getAddress(ADDR));
  });

  it('invalid_request: message 非 string / signature 非 hex', async () => {
    const a = await verifySiweLogin(
      { message: 123, signature: '0xdead' },
      deps(),
    );
    expect(a).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });
    const b = await verifySiweLogin(
      { message: message(), signature: 'not-hex' },
      deps(),
    );
    expect(b).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });
  });

  it('invalid_message: SIWE として parse 不能 (address 欠落)', async () => {
    const r = await verifySiweLogin(
      { message: 'これは SIWE ではない', signature: '0xdead' },
      deps(),
    );
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_message' });
  });

  it('unsupported_chain: 対応外 chainId', async () => {
    const r = await verifySiweLogin(
      { message: message({ chainId: 999 }), signature: '0xdead' },
      deps({ isSupportedChainId: () => false }),
    );
    expect(r).toMatchObject({ ok: false, status: 400, error: 'unsupported_chain' });
  });

  it('domain_mismatch: 許可外 domain は署名検証より前に弾く (verify 未呼出)', async () => {
    // message の domain (openpay.test) が許可リストに無い状況を再現。
    const d = deps({ isAllowedDomain: () => false });
    const r = await verifySiweLogin({ message: message(), signature: '0xdead' }, d);
    expect(r).toMatchObject({ ok: false, status: 401, error: 'domain_mismatch' });
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('invalid_signature: verify=false なら nonce を消費しない (再送可)', async () => {
    const d = deps({ verify: vi.fn().mockResolvedValue(false) });
    const r = await verifySiweLogin(
      { message: message(), signature: '0xdead' },
      d,
    );
    expect(r).toMatchObject({ ok: false, status: 401, error: 'invalid_signature' });
    expect(d.consumeNonce).not.toHaveBeenCalled();
  });

  it('nonce_invalid: 署名 OK でも nonce 消費失敗 (replay/期限切れ) → session 未作成', async () => {
    const d = deps({ consumeNonce: vi.fn().mockResolvedValue(false) });
    const r = await verifySiweLogin(
      { message: message(), signature: '0xdead' },
      d,
    );
    expect(r).toMatchObject({ ok: false, status: 401, error: 'nonce_invalid' });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  // --- REM-21: expirationTime 必須化 + 15 分 cap ---
  it('expirationTime 無し → 400 invalid_message (署名検証に到達しない)', async () => {
    const d = deps();
    const r = await verifySiweLogin(
      { message: message({ expirationTime: undefined }), signature: '0xdead' },
      d,
    );
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_message' });
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('issuedAt 無し → 400 invalid_message', async () => {
    const d = deps();
    const r = await verifySiweLogin(
      { message: message({ issuedAt: undefined }), signature: '0xdead' },
      d,
    );
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_message' });
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('expirationTime - issuedAt が 16 分 → 400 invalid_message (cap 超過)', async () => {
    const iat = NOW;
    const expOver = new Date(iat.getTime() + 16 * 60 * 1000);
    const d = deps();
    const r = await verifySiweLogin(
      { message: message({ issuedAt: iat, expirationTime: expOver }), signature: '0xdead' },
      d,
    );
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_message' });
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('expirationTime - issuedAt が 10 分 → 署名検証段階まで到達 (valid_message)', async () => {
    const iat = NOW;
    const exp10m = new Date(iat.getTime() + 10 * 60 * 1000);
    const d = deps();
    const r = await verifySiweLogin(
      { message: message({ issuedAt: iat, expirationTime: exp10m }), signature: '0xdead' },
      d,
    );
    // verify が呼ばれた = 鮮度チェックを通過。
    expect(d.verify).toHaveBeenCalledOnce();
    // 成功フロー (verify=true, consumeNonce=true 固定)
    expect(r).toMatchObject({ ok: true });
  });

  it('createSession が throw (session 永続化失敗) → verifySiweLogin も reject (route が 503 に倒す)', async () => {
    const d = deps({
      createSession: vi.fn().mockRejectedValue(new Error('session_persist_failed')),
    });
    await expect(
      verifySiweLogin({ message: message(), signature: '0xdead' }, d),
    ).rejects.toThrow('session_persist_failed');
  });
});

describe('verifySiweLogin: 実 EOA 署名の統合 (viem 本物・network 不要)', () => {
  // 実鍵で署名 → 実 verifySiweMessage で検証。EOA の ECDSA recover はローカルなので RPC 不要。
  // isSupportedChainId / isAllowedSiweDomain も本物を注入し、crypto+domain+chain を通しで確認。
  it('実鍵で署名 → ok・address は署名者・session 発行', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const chain = supportedChains[0];
    const iat = new Date();
    const message = createSiweMessage({
      domain: 'open-pay.jp',
      address: account.address,
      uri: 'https://open-pay.jp',
      version: '1',
      chainId: chain.id,
      nonce: generateSiweNonce(),
      issuedAt: iat,
      expirationTime: new Date(iat.getTime() + 10 * 60 * 1000),
    });
    const signature = await account.signMessage({ message });
    const client = createPublicClient({ chain, transport: http() });

    const result = await verifySiweLogin(
      { message, signature },
      {
        isSupportedChainId,
        isAllowedDomain: isAllowedSiweDomain,
        verify: (p) =>
          verifySiweMessage(client, {
            message: p.message,
            signature: p.signature,
            address: p.address,
            domain: p.domain,
            nonce: p.nonce,
          }),
        consumeNonce: async () => true,
        createSession: async (addr) => `sess-${addr}`,
      },
    );
    expect(result).toEqual({
      ok: true,
      token: `sess-${account.address}`,
      address: account.address,
    });
  });

  it('許可外 domain で署名 (evil.com) → domain_mismatch・署名検証に到達しない', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const chain = supportedChains[0];
    const iat2 = new Date();
    const message = createSiweMessage({
      domain: 'evil.com',
      address: account.address,
      uri: 'https://evil.com',
      version: '1',
      chainId: chain.id,
      nonce: generateSiweNonce(),
      issuedAt: iat2,
      expirationTime: new Date(iat2.getTime() + 10 * 60 * 1000),
    });
    const signature = await account.signMessage({ message });
    const verify = vi.fn();
    const result = await verifySiweLogin(
      { message, signature },
      {
        isSupportedChainId,
        isAllowedDomain: isAllowedSiweDomain,
        verify,
        consumeNonce: async () => true,
        createSession: async () => 't',
      },
    );
    expect(result).toMatchObject({ ok: false, error: 'domain_mismatch' });
    expect(verify).not.toHaveBeenCalled();
  });
});
