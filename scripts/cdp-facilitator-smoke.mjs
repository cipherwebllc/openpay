#!/usr/bin/env node
// CDP facilitator の認証スモーク (資金は動かさない)。X402_VANILLA_FACILITATOR=cdp を
// 点灯する前に、CDP API キーで Bearer JWT が通るかだけを確かめる:
//   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... node scripts/cdp-facilitator-smoke.mjs
// 判定: /verify へ「構造は正しいが無効な支払い」を送り、
//   - HTTP 401 → 認証が壊れている (鍵/JWT の問題)
//   - それ以外 (200 の isValid:false / 4xx) → 認証 OK (支払いが無効なのは想定どおり)
//
// ⚠️ JWT 生成の単一情報源は lib/x402/cdpJwt.ts。本スクリプトは 'server-only' を含む
// TS を node から直接 import できないための複製 (仕様変更時は両方直す)。
// lib と同じく両鍵形式に対応: Ed25519 (base64 64byte・現行既定) / ECDSA P-256
// (PEM または base64 PKCS8 DER・旧形式)。

import { createPrivateKey, randomBytes, sign } from 'node:crypto';

const keyId = process.env.CDP_API_KEY_ID;
const keySecret = process.env.CDP_API_KEY_SECRET;
if (!keyId || !keySecret) {
  console.error('CDP_API_KEY_ID / CDP_API_KEY_SECRET を export してください');
  process.exit(1);
}

const BASE = 'https://api.cdp.coinbase.com/platform/v2/x402';
const b64url = (b) => Buffer.from(b).toString('base64url');

// lib/x402/cdpJwt.ts の parseCdpKeySecret と同じ判定:
//   PEM ヘッダあり → ES256 / base64 64byte → Ed25519 / それ以外の base64 → PKCS8 DER (ES256)
function parseKey(secret) {
  const trimmed = secret.trim();
  if (trimmed.includes('-----BEGIN')) {
    return { alg: 'ES256', key: createPrivateKey(trimmed.replace(/\\n/g, '\n')) };
  }
  // 内部の空白/改行を除去してから復号 (コピー時の混入対策)。
  const compact = trimmed.replace(/\s+/g, '');
  const der = Buffer.from(compact, 'base64');
  if (der.length === 64 || der.length === 32) {
    // Ed25519: 完全形 (seed+public 64byte) または seed のみ 32byte (表示形の揺れ)。
    return {
      alg: 'EdDSA',
      key: createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          der.subarray(0, 32),
        ]),
        format: 'der',
        type: 'pkcs8',
      }),
    };
  }
  return {
    alg: 'ES256',
    key: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }),
  };
}

// 解釈失敗時の安全な診断 (秘密の値そのものは一切出力しない)。
function describeSecretShape(secret) {
  const trimmed = secret.trim();
  const compact = trimmed.replace(/\s+/g, '');
  const decoded = Buffer.from(compact, 'base64');
  return [
    `文字数=${trimmed.length}`,
    `内部空白=${trimmed.length !== compact.length ? 'あり' : 'なし'}`,
    `PEMヘッダ=${trimmed.includes('-----BEGIN') ? 'あり' : 'なし'}`,
    `base64url文字(-_)=${/[-_]/.test(compact) ? 'あり' : 'なし'}`,
    `base64復号後=${decoded.length}byte`,
  ].join(' / ');
}

function jwtFor(method, url) {
  let parsed;
  try {
    parsed = parseKey(keySecret);
  } catch (e) {
    console.error(`鍵の形式を解釈できません: ${e.message}`);
    console.error(`形状診断 (秘密は含まない): ${describeSecretShape(keySecret)}`);
    console.error('対応形式: Ed25519 (base64 32/64byte) / ECDSA P-256 (PEM or base64 PKCS8 DER)');
    console.error('CDP ポータルの「Secret API Key」の secret を使っているか確認してください');
    process.exit(1);
  }
  const { alg, key } = parsed;
  const { host, pathname } = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg, kid: keyId, typ: 'JWT', nonce: randomBytes(8).toString('hex') }));
  const c = b64url(JSON.stringify({ iss: 'cdp', sub: keyId, aud: ['cdp_service'], nbf: now, exp: now + 120, uri: `${method} ${host}${pathname}` }));
  const sig =
    alg === 'EdDSA'
      ? sign(null, Buffer.from(`${h}.${c}`), key)
      : sign('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' });
  console.log(`鍵形式: ${alg === 'EdDSA' ? 'Ed25519' : 'ECDSA P-256'} (alg=${alg})`);
  return `${h}.${c}.${sig.toString('base64url')}`;
}

// 本番 (lib/x402/vanillaGate) と同一の v2 封筒を、本番の実 402 から組む。
//   - accepts は v1 JSON body から、resource (serviceName/tags/iconUrl 含む) と extensions.bazaar は
//     v2 PAYMENT-REQUIRED ヘッダから写す = 本番が verify/settle に送るものと同じ
//   - TARGET_URL で任意の endpoint を検査できる (既定 hello)。2026-08-23 の transfers verify 400
//     (resource.description が長すぎ) のような「形式で拒否」を、資金を動かさずに CDP の
//     errorMessage として読むのが目的
// 署名は資金ゼロの捨て鍵による本物の EIP-3009 — 全通なら CDP は 4xx {isValid:false}
// (insufficient_funds 等) を返すはず。判定 body が無い 4xx なら形式拒否 = body を全文表示する。
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');

const TARGET = process.env.TARGET_URL ?? 'https://open-pay.jp/api/paid/hello';
const helloRes = await fetch(TARGET);
const hello = await helloRes.json();
const a = hello.accepts[0];
const prHeader = helloRes.headers.get('payment-required');
const pr = prHeader ? JSON.parse(Buffer.from(prHeader, 'base64').toString('utf8')) : null;
console.log(`target: ${TARGET}`);
if (pr?.resource?.description) {
  console.log(`resource.description: ${pr.resource.description.length} chars | serviceName: ${pr.resource.serviceName ?? '-'} | tags: ${(pr.resource.tags ?? []).length} | extensions: ${pr.extensions ? Object.keys(pr.extensions).join(',') : '-'}`);
}
const caip2 = a.network === 'base' ? 'eip155:8453' : a.network;
const account = privateKeyToAccount(generatePrivateKey());
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const signature = await account.signTypedData({
  domain: { name: a.extra.name, version: a.extra.version, chainId: 8453, verifyingContract: a.asset },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
  primaryType: 'TransferWithAuthorization',
  message: { from: account.address, to: a.payTo, value: BigInt(a.maxAmountRequired),
    validAfter: 0n, validBefore, nonce },
});
const accept = {
  scheme: 'exact', network: caip2, amount: a.maxAmountRequired, asset: a.asset,
  payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, extra: a.extra,
};
const url = `${BASE}/verify`;
const body = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    accepted: accept,
    payload: { signature, authorization: {
      from: account.address, to: a.payTo, value: a.maxAmountRequired,
      validAfter: '0', validBefore: validBefore.toString(), nonce } },
    resource: pr?.resource ?? { url: a.resource, description: a.description, mimeType: 'application/json' },
    ...(pr?.extensions ? { extensions: pr.extensions } : {}),
  },
  paymentRequirements: accept,
};
console.log(`署名者 (資金ゼロ捨て鍵): ${account.address}`);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${jwtFor('POST', url)}` },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text.slice(0, 1200));
if (res.status === 401 || res.status === 403) {
  console.error('\n判定: 認証 NG — 鍵か JWT 形式を確認');
  process.exit(1);
}
// CDP は invalid な支払いを 200 でなく 4xx + 正規の判定 body で返す (2026-08-20 実測:
// 400 {isValid:false, invalidReason:'invalid_payload', payer:...})。判定 body が読めれば
// 認証もワイヤも通っている — 資金ゼロの捨て鍵なので isValid:false が正常。
let judged = null;
try {
  judged = JSON.parse(text);
} catch {
  judged = null;
}
if (judged && typeof judged === 'object' && 'isValid' in judged) {
  console.log('\n判定: 全通 — 認証もワイヤも OK (isValid:false は資金ゼロのため想定どおり)');
} else {
  console.log('\n判定: 認証は OK・ワイヤが拒否されている — 上の body の errorMessage が原因');
  process.exit(1);
}
