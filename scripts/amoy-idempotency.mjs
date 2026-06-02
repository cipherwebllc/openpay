// Amoy 実 chain での B2 idempotency 検証。同一 authorization (同一 intentSalt→同一 commitment
// nonce) を 2 回 POST する。B2 が効くと: 1 件は first→submit→success、もう 1 件は claimIdempotency が
// duplicate を返し submit せず pending (再 broadcast しない=revert gas を浪費しない)。on-chain は
// settle が 1 回だけ (feeReceiver +fee / buyer -(merchant+fee))。
//
// KV 未設定 (fail-open) との差分が B2 の価値: KV 無しだと両方 submit され、片方は on-chain
// _authorizationStates で revert (二重支払いは防げるが gas を浪費)。KV 有りだと duplicate を
// submit 前に弾き pending を返す。
//
// 前提: .env.local に KV_REST_API_*・RELAYER_PRIVATE_KEY・AMOY_TEST_BUYER_KEY(JPYC保有) 設定済、
//       dev server を KV 設定後に再起動済。
// 使い方: RELAY_URL=http://localhost:3000/api/relay/jpyc node scripts/amoy-idempotency.mjs

import {
  createPublicClient, http, keccak256, encodeAbiParameters, toHex, getAddress, formatUnits,
} from 'viem';
import { polygonAmoy } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(join(__dirname, '..', '.env.local'));

const CHAIN_ID = 80002;
const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const RPC = process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology';
const FORWARDER = getAddress(process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY);
const FEE_RECEIVER = getAddress(process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS);
const FEE_VALUE = (() => {
  const raw = process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC;
  return (raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 2n) * 10n ** 18n;
})();
const MERCHANT_VALUE = 1n * 10n ** 18n;
const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3000/api/relay/jpyc';

const COMMIT_VERSION = keccak256(toHex('openpay.eip3009.forwarder.v1'));
const DOMAIN = { name: 'JPY Coin', version: '1', chainId: CHAIN_ID, verifyingContract: JPYC };
const TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

function buildNonce(p, forwarder) {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' },
     { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [COMMIT_VERSION, p.from, p.merchant, p.merchantValue, p.feeReceiver, p.feeValue, p.validAfter, p.validBefore, p.intentSalt, BigInt(CHAIN_ID), forwarder],
  ));
}

function selfCheck() {
  const golden = buildNonce({
    from: '0x1111111111111111111111111111111111111111', merchant: '0x2222222222222222222222222222222222222222',
    merchantValue: 1000n * 10n ** 18n, feeReceiver: '0x3333333333333333333333333333333333333333', feeValue: 2n * 10n ** 18n,
    validAfter: 0n, validBefore: 1_000_000_000_000n, intentSalt: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  }, '0x4444444444444444444444444444444444444444');
  if (golden !== '0xf1e88a8b02d5ff7edf8990e30fc9679ad4be8ba70f76bdbeb6a49742a84d20ab') {
    throw new Error('golden vector mismatch');
  }
  console.log('✅ golden vector 一致');
}

const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];
const client = createPublicClient({ chain: polygonAmoy, transport: http(RPC) });

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return { configured: false };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(['GET', key]),
    });
    const j = await res.json();
    return { configured: true, value: j.result ?? null };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

async function postAuth(body, label) {
  const start = Date.now();
  try {
    const res = await fetch(RELAY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { label, status: res.status, json, ms: Date.now() - start };
  } catch (e) {
    return { label, status: 0, json: { error: e.message }, ms: Date.now() - start };
  }
}

function kindOf(r) {
  const j = r.json || {};
  return j.ok ? 'success' : j.pending ? 'pending' : j.reverted ? 'reverted' : `error:${j.error || r.status}`;
}

async function main() {
  selfCheck();
  const buyerKey = process.env.AMOY_TEST_BUYER_KEY;
  if (!buyerKey) { console.error('❌ AMOY_TEST_BUYER_KEY 未設定'); process.exit(1); }
  const buyer = privateKeyToAccount(buyerKey);
  const kvOn = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  console.log(`buyer=${buyer.address} KV=${kvOn ? 'ON' : 'OFF (fail-open・B2 は効かない)'} relay=${RELAY_URL}`);

  const total = MERCHANT_VALUE + FEE_VALUE;
  const [buyerBefore, frBefore] = await Promise.all([
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [buyer.address] }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [FEE_RECEIVER] }),
  ]);
  console.log(`buyer JPYC=${formatUnits(buyerBefore, 18)} feeReceiver JPYC=${formatUnits(frBefore, 18)}`);
  if (buyerBefore < total) { console.error(`❌ buyer JPYC 不足 (>=${formatUnits(total, 18)} 必要)`); process.exit(1); }

  // 1 個の authorization A を構築 (fresh salt)。
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const intentSalt = `0x${randomBytes(32).toString('hex')}`;
  const p = { from: buyer.address, merchant, merchantValue: MERCHANT_VALUE, feeReceiver: FEE_RECEIVER, feeValue: FEE_VALUE, validAfter: 0n, validBefore, intentSalt };
  const nonce = buildNonce(p, FORWARDER);
  const signature = await buyer.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from: buyer.address, to: FORWARDER, value: total, validAfter: 0n, validBefore, nonce },
  });
  const body = {
    chainId: CHAIN_ID, from: p.from, merchant, merchantValue: MERCHANT_VALUE.toString(), feeValue: FEE_VALUE.toString(),
    validAfter: '0', validBefore: validBefore.toString(), intentSalt, signature,
  };
  console.log(`\nauthorization nonce=${nonce}`);

  // === シナリオ1: 同一 authorization を 2 回 同時 POST ===
  console.log('\n[1] 同一 authorization を 2 回同時 POST (duplicate を submit 前に弾けるか)...');
  const [a1, a2] = await Promise.all([postAuth(body, 'A1'), postAuth(body, 'A2')]);
  for (const r of [a1, a2]) console.log(`  ${r.label} [${r.status}] ${kindOf(r)} tx=${r.json?.txHash || '-'} (${r.ms}ms)`);

  // KV の idem key を直接確認 (B2 が claim したか)。
  const idemKey = `relay:idem:${CHAIN_ID}:${buyer.address.toLowerCase()}:${nonce.toLowerCase()}`;
  const kv = await kvGet(idemKey);
  console.log(`  KV idem key ${kvOn ? `= ${JSON.stringify(kv.value)}` : '(KV OFF)'}`);

  console.log('\n15s 待って on-chain 照合...');
  await new Promise((r) => setTimeout(r, 15_000));

  const [buyerAfter, frAfter] = await Promise.all([
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [buyer.address] }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [FEE_RECEIVER] }),
  ]);
  const frDelta = frAfter - frBefore, buyerDelta = buyerBefore - buyerAfter;

  // === シナリオ2: 確定後にもう一度 POST (authState 既使用 → pending) ===
  console.log('\n[2] settle 確定後に同一 authorization を再 POST (authState 既使用→pending)...');
  const a3 = await postAuth(body, 'A3');
  console.log(`  ${a3.label} [${a3.status}] ${kindOf(a3)} tx=${a3.json?.txHash || '-'} (${a3.ms}ms)`);

  // === 判定 ===
  const kinds = [kindOf(a1), kindOf(a2)];
  const successN = kinds.filter((k) => k === 'success').length;
  const pendingN = kinds.filter((k) => k === 'pending').length;
  const revertN = kinds.filter((k) => k === 'reverted').length;
  // duplicate を submit 前に弾いた = pending が 1 件・かつ速い (<3s)・revert 無し。
  const fastPending = [a1, a2].some((r) => kindOf(r) === 'pending' && r.ms < 3000);

  console.log('\n=== B2 idempotency 判定 ===');
  console.log(`同時POST: success=${successN} pending=${pendingN} reverted=${revertN}`);
  const ok1 = frDelta === FEE_VALUE; // settle は 1 回だけ
  console.log(`1. on-chain settle 1 回のみ (feeReceiver +${formatUnits(frDelta, 18)}==fee / buyer -${formatUnits(buyerDelta, 18)}==merchant+fee): ${ok1 && buyerDelta === total ? '✅' : '❌'}`);
  if (kvOn) {
    const ok2 = pendingN >= 1 && revertN === 0 && fastPending;
    console.log(`2. duplicate を submit 前に弾き pending (revert gas 浪費なし・<3s): ${ok2 ? '✅' : '⚠️'}`);
    const ok3 = kv.configured && kv.value != null;
    console.log(`3. KV に idem key が claim 済: ${ok3 ? '✅' : '❌'} (${JSON.stringify(kv.value)})`);
    const ok4 = kindOf(a3) === 'pending';
    console.log(`4. 確定後の再POSTは pending (authState 既使用): ${ok4 ? '✅' : '❌'}`);
    console.log(`\n判定: ${ok1 && buyerDelta === total && ok2 && ok3 && ok4 ? '✅ PASS (B2 idempotency 実環境で機能・二重支払いゼロ)' : '⚠️ 上記参照'}`);
  } else {
    console.log('KV OFF: B2 は fail-open。duplicate も submit され片方は on-chain で revert (二重支払いは防げるが gas 浪費)。');
    console.log(`参考: success=${successN} reverted=${revertN}・settle 1 回=${ok1 && buyerDelta === total ? '✅' : '❌'}`);
    console.log('→ KV を設定して再実行すると B2 (duplicate→pending・revert 回避) を確認できます。');
  }
}

main().catch((e) => { console.error('error:', e); process.exit(1); });
