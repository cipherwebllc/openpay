#!/usr/bin/env node
// dual-rail 402 (JPYC + USDC/Base 並記) の USDC 面を購入するリファレンス買い手。
//
// なぜ専用スクリプトか: 標準クライアント x402-fetch (1.2.0 現在) は 402 の accepts **全件**を
// v1 ネットワーク名 enum で厳格 parse するため、JPYC 面の CAIP-2 表記 ('eip155:137') を含む
// dual-rail 402 では支払い先を選ぶ前に throw する。本スクリプトは network==='base' の accept
// だけを選び、EIP-3009 (TransferWithAuthorization) に署名して X-PAYMENT で支払う。
//
// 使い方 (鍵はファイルに書かない・env で渡す):
//   BUYER_PRIVATE_KEY=0x... RESOURCE_URL=https://seller.example/api/paid/x \
//     [MAX_USDC=0.01] node x402-dual-buyer-example.mjs
//
// 金銭ガード:
//   - asset が Base mainnet の native USDC (0x8335…2913) でなければ支払わない
//   - 要求額が MAX_USDC (既定 0.01 = 1 セント) を超えたら支払わない
//   - 支払い先 (payTo) と額を表示してから署名する
// ガス代は不要 (署名のみ・broadcast は facilitator 側)。ウォレットには USDC だけあれば良い。

import { privateKeyToAccount } from 'viem/accounts';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const TARGET = process.env.RESOURCE_URL;
if (!TARGET) {
  console.error('RESOURCE_URL env が必要です (購入する dual-rail 402 の URL)');
  process.exit(1);
}
const MAX_USDC = process.env.MAX_USDC ?? '0.01';
const m = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(MAX_USDC);
if (!m) {
  console.error(`MAX_USDC の形式が不正です (例: 0.01): ${MAX_USDC}`);
  process.exit(1);
}
const MAX_ATOMIC = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));

const pk = process.env.BUYER_PRIVATE_KEY;
if (!pk || !pk.startsWith('0x')) {
  console.error('BUYER_PRIVATE_KEY env (0x...) が必要です');
  process.exit(1);
}
const account = privateKeyToAccount(pk);
console.log('buyer :', account.address);
console.log('buying:', TARGET);

const challenge = await fetch(TARGET);
if (challenge.status !== 402) {
  console.error('402 ではありません:', challenge.status, (await challenge.text()).slice(0, 200));
  process.exit(1);
}
const { accepts } = await challenge.json();
const accept = (accepts || []).find(
  (a) => a && a.scheme === 'exact' && a.network === 'base',
);
if (!accept) {
  console.error(
    'USDC (base) の accept がありません。並記レール:',
    JSON.stringify((accepts || []).map((a) => a?.network)),
  );
  process.exit(1);
}
if (String(accept.asset).toLowerCase() !== BASE_USDC.toLowerCase()) {
  console.error('asset が Base native USDC ではないため中止:', accept.asset);
  process.exit(1);
}
const amount = BigInt(accept.maxAmountRequired);
if (amount > MAX_ATOMIC) {
  console.error(`要求額 ${accept.maxAmountRequired} が上限 MAX_USDC=${MAX_USDC} を超過`);
  process.exit(1);
}
console.log(`price : ${accept.maxAmountRequired} atomic (= $${Number(amount) / 1e6})`);
console.log('payTo :', accept.payTo);

const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
const nonce =
  '0x' +
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const signature = await account.signTypedData({
  domain: {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: 8453,
    verifyingContract: accept.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: account.address,
    to: accept.payTo,
    value: amount,
    validAfter: 0n,
    validBefore,
    nonce,
  },
});
const header = Buffer.from(
  JSON.stringify({
    scheme: 'exact',
    network: 'base',
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: accept.payTo,
        value: accept.maxAmountRequired,
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  }),
  'utf8',
).toString('base64');

const res = await fetch(TARGET, { headers: { 'x-payment': header } });
console.log('HTTP', res.status);
const text = await res.text();
console.log('body :', text.slice(0, 600));
const receipt = res.headers.get('x-payment-response');
if (receipt) {
  console.log('settlement:', JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')));
} else {
  console.log('settlement: (x-payment-response ヘッダなし)');
}
