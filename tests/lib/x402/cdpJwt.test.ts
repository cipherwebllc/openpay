// CDP Bearer JWT (lib/x402/cdpJwt) のフェンス。実鍵を生成して署名→検証まで往復する
// (モックでなく node:crypto の実検証 — 形式ドリフトすると CDP 側で 401 になる系なので、
// ここで壊れたら実環境でも壊れている)。

import { describe, it, expect, vi } from 'vitest';
import {
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
} from 'node:crypto';

vi.mock('server-only', () => ({}));

import { generateCdpJwt, parseCdpKeySecret } from '@/lib/x402/cdpJwt';

const URL_UNDER_TEST = 'https://api.cdp.coinbase.com/platform/v2/x402/verify';

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/** CDP 形式の Ed25519 secret (base64 64byte = seed+public) をテスト用に生成する。 */
function makeEd25519Secret(): { secret: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(
    (privateKey.export({ format: 'jwk' }) as { d: string }).d,
    'base64url',
  );
  const pub = Buffer.from(
    (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  return { secret: Buffer.concat([seed, pub]).toString('base64'), publicKey };
}

describe('generateCdpJwt', () => {
  it('Ed25519 (現行既定形式): header/claims の形と実署名が検証を通る', () => {
    const { secret, publicKey } = makeEd25519Secret();
    const jwt = generateCdpJwt({
      keyId: 'org/key-1',
      keySecret: secret,
      method: 'POST',
      url: URL_UNDER_TEST,
    });
    const [h, c, sig] = jwt.split('.');
    const header = decodeSegment(h);
    const claims = decodeSegment(c);

    expect(header).toMatchObject({ alg: 'EdDSA', kid: 'org/key-1', typ: 'JWT' });
    expect(String(header.nonce)).toMatch(/^[0-9a-f]{16}$/);
    expect(claims).toMatchObject({
      iss: 'cdp',
      sub: 'org/key-1',
      aud: ['cdp_service'],
      uri: 'POST api.cdp.coinbase.com/platform/v2/x402/verify',
    });
    expect(Number(claims.exp) - Number(claims.nbf)).toBe(120);

    const ok = cryptoVerify(
      null,
      Buffer.from(`${h}.${c}`),
      publicKey,
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('Ed25519 の seed のみ 32byte 形式も受理し、完全形と同じ鍵に解決する', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = Buffer.from(
      (privateKey.export({ format: 'jwk' }) as { d: string }).d,
      'base64url',
    );
    const jwt = generateCdpJwt({
      keyId: 'k-seed',
      keySecret: seed.toString('base64'),
      method: 'POST',
      url: URL_UNDER_TEST,
    });
    const [h, c, sig] = jwt.split('.');
    expect(decodeSegment(h).alg).toBe('EdDSA');
    const ok = cryptoVerify(
      null,
      Buffer.from(`${h}.${c}`),
      publicKey,
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('内部に改行/空白が混入した base64 も受理する (コピー事故対策)', () => {
    const { secret, publicKey } = makeEd25519Secret();
    const messy = `${secret.slice(0, 20)}\n${secret.slice(20, 44)} ${secret.slice(44)}`;
    const jwt = generateCdpJwt({
      keyId: 'k-messy',
      keySecret: messy,
      method: 'POST',
      url: URL_UNDER_TEST,
    });
    const [h, c, sig] = jwt.split('.');
    const ok = cryptoVerify(
      null,
      Buffer.from(`${h}.${c}`),
      publicKey,
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('ECDSA P-256 (旧形式・PKCS8 DER base64): ES256 + ieee-p1363 署名が検証を通る', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const secret = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const jwt = generateCdpJwt({
      keyId: 'k2',
      keySecret: secret,
      method: 'POST',
      url: 'https://api.cdp.coinbase.com/platform/v2/x402/settle',
    });
    const [h, c, sig] = jwt.split('.');
    expect(decodeSegment(h).alg).toBe('ES256');
    expect(decodeSegment(c).uri).toBe(
      'POST api.cdp.coinbase.com/platform/v2/x402/settle',
    );
    // JOSE 形式 (raw r||s) は 64 byte 固定。
    expect(Buffer.from(sig, 'base64url')).toHaveLength(64);
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('uri claim は method + host + path に束縛される (query は含めない)', () => {
    const { secret } = makeEd25519Secret();
    const jwt = generateCdpJwt({
      keyId: 'k',
      keySecret: secret,
      method: 'GET',
      url: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=5',
    });
    expect(decodeSegment(jwt.split('.')[1]).uri).toBe(
      'GET api.cdp.coinbase.com/platform/v2/x402/discovery/resources',
    );
  });

  it('形式不明の secret は throw (無言の 401 より設定時に落とす)', () => {
    expect(() => parseCdpKeySecret('not-a-key!!!')).toThrow();
  });
});
