#!/usr/bin/env node
// CDP facilitator の認証スモーク (資金は動かさない)。X402_VANILLA_FACILITATOR=cdp を
// 点灯する前に、CDP API キーで Bearer JWT が通るかだけを確かめる:
//   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... node scripts/cdp-facilitator-smoke.mjs
// 判定: /verify へ「構造は正しいが無効な支払い」を送り、
//   - HTTP 401 → 認証が壊れている (鍵/JWT の問題)
//   - それ以外 (200 の isValid:false / 4xx) → 認証 OK (支払いが無効なのは想定どおり)
//
// ⚠️ JWT 生成の単一情報源は lib/x402/cdpJwt.ts。本スクリプトは 'server-only' を含む
// TS を node から直接 import できないための Ed25519 限定の複製 (仕様変更時は両方直す)。

import { createPrivateKey, randomBytes, sign } from 'node:crypto';

const keyId = process.env.CDP_API_KEY_ID;
const keySecret = process.env.CDP_API_KEY_SECRET;
if (!keyId || !keySecret) {
  console.error('CDP_API_KEY_ID / CDP_API_KEY_SECRET を export してください');
  process.exit(1);
}

const BASE = 'https://api.cdp.coinbase.com/platform/v2/x402';
const b64url = (b) => Buffer.from(b).toString('base64url');

function jwtFor(method, url) {
  const der = Buffer.from(keySecret.trim(), 'base64');
  if (der.length !== 64) {
    console.error('本スクリプトは Ed25519 (base64 64byte) 鍵のみ対応 (ECDSA は lib 側で対応)');
    process.exit(1);
  }
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      der.subarray(0, 32),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const { host, pathname } = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce: randomBytes(8).toString('hex') }));
  const c = b64url(JSON.stringify({ iss: 'cdp', sub: keyId, aud: ['cdp_service'], nbf: now, exp: now + 120, uri: `${method} ${host}${pathname}` }));
  const sig = sign(null, Buffer.from(`${h}.${c}`), key);
  return `${h}.${c}.${sig.toString('base64url')}`;
}

const url = `${BASE}/verify`;
const body = {
  x402Version: 1,
  paymentPayload: {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: { signature: `0x${'11'.repeat(65)}`, authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1', validAfter: '0', validBefore: '1', nonce: `0x${'22'.repeat(32)}`,
    } },
  },
  paymentRequirements: {
    scheme: 'exact', network: 'base', maxAmountRequired: '1',
    resource: 'https://open-pay.jp/api/paid/usdc/stores', description: 'auth smoke',
    mimeType: 'application/json', payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 300, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    extra: { name: 'USD Coin', version: '2' },
  },
};

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${jwtFor('POST', url)}` },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text.slice(0, 400));
if (res.status === 401 || res.status === 403) {
  console.error('\n判定: 認証 NG — 鍵か JWT 形式を確認');
  process.exit(1);
}
console.log('\n判定: 認証 OK (支払いが invalid なのは想定どおり)');
