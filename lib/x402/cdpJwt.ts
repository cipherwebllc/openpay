import 'server-only';

// Coinbase CDP API の Bearer JWT を依存追加なしで生成する (agentic.market 掲載裁定 2026-08-16)。
//
// 公式 SDK (@coinbase/cdp-sdk) を使わない理由: 必要なのは 2 分有効の JWT 1 種のみで、
// SDK は axios / Solana / jose ほか広い依存を引き込む (掟 16: 依存は最小・公式レジストリのみ)。
// 仕様は docs.cdp.coinbase.com/api-reference/v2/authentication で公開されている:
//   header: { alg: 'EdDSA' | 'ES256', kid: <keyId>, typ: 'JWT', nonce: <16 hex> }
//   claims: { iss: 'cdp', sub: <keyId>, aud: ['cdp_service'], nbf, exp (=nbf+120s),
//             uri: 'METHOD HOST/PATH' (例 'POST api.cdp.coinbase.com/platform/v2/x402/verify') }
// 鍵形式は 2 種:
//   - Ed25519 (現行既定): base64 の 64 byte (seed 32 + public 32)
//   - ECDSA P-256 (旧形式): PKCS8 DER の base64 または PEM
// 署名の失敗・形式不明は throw — 呼び出し側 (vanillaGate) が 503 に落とす (fail-closed・
// 買い手に課金は発生しない)。

import {
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

const CDP_JWT_TTL_SECONDS = 120;

// RFC 5958 PKCS8 で Ed25519 の 32 byte seed を包む固定 prefix (RFC 8410)。
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

type ParsedKey = { alg: 'EdDSA' | 'ES256'; key: KeyObject };

/** CDP API key secret を鍵形式ごとに KeyObject へ。判別不能は throw。 */
export function parseCdpKeySecret(secret: string): ParsedKey {
  const trimmed = secret.trim();
  if (trimmed.includes('-----BEGIN')) {
    // PEM (ECDSA 旧形式)。エスケープ済み \n を実改行へ戻す。
    return {
      alg: 'ES256',
      key: createPrivateKey(trimmed.replace(/\\n/g, '\n')),
    };
  }
  // コピー時に混入し得る内部の空白/改行を除去してから復号 (端の trim だけでは不足)。
  const compact = trimmed.replace(/\s+/g, '');
  const der = Buffer.from(compact, 'base64');
  if (der.length === 64 || der.length === 32) {
    // Ed25519: seed(32)+public(32) の完全形、または seed のみの 32 byte 形
    // (CDP ポータルの表示形に揺れがある・公開鍵は seed から導出されるため不要)。
    return {
      alg: 'EdDSA',
      key: createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, der.subarray(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      }),
    };
  }
  // base64 DER PKCS8 (ECDSA)。
  return {
    alg: 'ES256',
    key: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }),
  };
}

/**
 * 対象リクエスト 1 件に対する CDP Bearer JWT を生成する。
 * uri claim はリクエストに束縛されるため、verify と settle で毎回生成すること。
 */
export function generateCdpJwt(input: {
  keyId: string;
  keySecret: string;
  method: 'GET' | 'POST';
  url: string;
}): string {
  const { alg, key } = parseCdpKeySecret(input.keySecret);
  const { host, pathname } = new URL(input.url);

  const header = {
    alg,
    kid: input.keyId,
    typ: 'JWT',
    nonce: randomBytes(8).toString('hex'),
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'cdp',
    sub: input.keyId,
    aud: ['cdp_service'],
    nbf: nowSec,
    exp: nowSec + CDP_JWT_TTL_SECONDS,
    uri: `${input.method} ${host}${pathname}`,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature =
    alg === 'EdDSA'
      ? cryptoSign(null, Buffer.from(signingInput), key)
      : // ES256 は JOSE 形式 (raw r||s 64 byte) が必要 — DER ではなく ieee-p1363 で出す。
        cryptoSign('sha256', Buffer.from(signingInput), {
          key,
          dsaEncoding: 'ieee-p1363',
        });
  return `${signingInput}.${signature.toString('base64url')}`;
}
