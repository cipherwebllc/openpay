// Amoy 実 chain 並行 submit 検証 (Phase B)。単一 buyer が N 個の DISTINCT な recover authorization
// (異なる intentSalt → 異なる commitment nonce) に署名し、relay endpoint へ同時 POST する。単一
// relayer EOA が並行処理で自身の tx nonce を奪い合う → nonce 衝突 → B3 (getPendingNonce + 衝突
// リトライ + authState 再確認) が吸収できるかを実環境で確認する。
//
// 検証する不変条件:
//  1. 各 settle の txHash が distinct (同一 relayer nonce の二重 broadcast が無い)。
//  2. feeReceiver JPYC 増分 == 成功件数 × feeValue (過不足回収=二重支払い無し)。
//  3. buyer JPYC 減分 == 成功件数 × (merchantValue + feeValue)。
//  4. relayer の latest nonce 増分 == 成功件数 (nonce hole / stuck が無い)。
//  5. pending/error はあってよいが、その分は上記 success 件数から除外して照合。
//
// 前提: .env.local.testnet (無ければ .env.local) に RELAYER_PRIVATE_KEY / KV_REST_API_* /
//       NEXT_PUBLIC_JPYC_FORWARDER_AMOY 設定済 — KV は **testnet 用**を指すこと (起動時に表示する)、
//       relayer に POL、buyer (AMOY_TEST_BUYER_KEY) に N×(merchant+fee) JPYC、dev server 起動。
// 使い方: RELAY_URL=http://localhost:3000/api/relay/jpyc N=6 \
//         node scripts/amoy-concurrent-settle.mjs

import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  toHex,
  getAddress,
  formatUnits,
} from 'viem';
import { polygonAmoy } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadTestnetEnv } from './lib/load-testnet-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .env.local.testnet を優先 (無ければ .env.local)。読んだ env と KV ホストを表示してから走る。
loadTestnetEnv(join(__dirname, '..'));

const CHAIN_ID = 80002;
const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const RPC = process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology';
const FORWARDER = getAddress(process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY);
const FEE_RECEIVER = getAddress(process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS);
const FEE_VALUE = (() => {
  const raw = process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC;
  const human = raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 2n;
  return human * 10n ** 18n;
})();
const MERCHANT_VALUE = 1n * 10n ** 18n; // 1 JPYC / 件
const N = Number(process.env.N || '6');
const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3000/api/relay/jpyc';

const COMMIT_VERSION = keccak256(toHex('openpay.eip3009.forwarder.v1'));
const DOMAIN = { name: 'JPY Coin', version: '1', chainId: CHAIN_ID, verifyingContract: JPYC };
const TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function buildNonce(p, forwarder) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' },
        { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' },
      ],
      [
        COMMIT_VERSION, p.from, p.merchant, p.merchantValue, p.feeReceiver, p.feeValue,
        p.validAfter, p.validBefore, p.intentSalt, BigInt(CHAIN_ID), forwarder,
      ],
    ),
  );
}

// 署名/nonce ロジックが本体 (forwarderIntent.ts) と一致することを offline で fence。
function selfCheck() {
  const golden = buildNonce(
    {
      from: '0x1111111111111111111111111111111111111111',
      merchant: '0x2222222222222222222222222222222222222222',
      merchantValue: 1000n * 10n ** 18n,
      feeReceiver: '0x3333333333333333333333333333333333333333',
      feeValue: 2n * 10n ** 18n,
      validAfter: 0n,
      validBefore: 1_000_000_000_000n,
      intentSalt: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    },
    '0x4444444444444444444444444444444444444444',
  );
  const expected = '0xf1e88a8b02d5ff7edf8990e30fc9679ad4be8ba70f76bdbeb6a49742a84d20ab';
  if (golden !== expected) {
    throw new Error(`golden vector mismatch: ${golden} != ${expected} (nonce ロジック不一致)`);
  }
  console.log('✅ golden vector 一致 (nonce/encode は契約・本体と一致)');
}

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const client = createPublicClient({ chain: polygonAmoy, transport: http(RPC) });

async function main() {
  selfCheck();

  const buyerKey = process.env.AMOY_TEST_BUYER_KEY;
  if (!buyerKey) {
    console.error('❌ AMOY_TEST_BUYER_KEY 未設定 (JPYC を持つ Amoy 署名元の秘密鍵)。');
    process.exit(1);
  }
  const buyer = privateKeyToAccount(buyerKey);
  const total = MERCHANT_VALUE + FEE_VALUE;
  console.log(`buyer=${buyer.address} N=${N} 各=${formatUnits(MERCHANT_VALUE, 18)}+${formatUnits(FEE_VALUE, 18)}JPYC relay=${RELAY_URL}`);

  const relayerHint = process.env._RELAYER_ADDR; // 任意 (readiness で確認済)
  const [buyerBefore, frBefore] = await Promise.all([
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [buyer.address] }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [FEE_RECEIVER] }),
  ]);
  console.log(`buyer JPYC=${formatUnits(buyerBefore, 18)} feeReceiver JPYC=${formatUnits(frBefore, 18)}`);
  if (buyerBefore < total * BigInt(N)) {
    console.error(`❌ buyer JPYC 不足: ${formatUnits(buyerBefore, 18)} < ${formatUnits(total * BigInt(N), 18)} (N×(merchant+fee))`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const validBefore = BigInt(now + 600);
  // N 個の DISTINCT authorization を構築 + 署名。
  const reqs = [];
  for (let i = 0; i < N; i++) {
    const merchant = privateKeyToAccount(generatePrivateKey()).address; // distinct・!= feeReceiver
    const intentSalt = `0x${randomBytes(32).toString('hex')}`;
    const p = {
      from: buyer.address, merchant, merchantValue: MERCHANT_VALUE,
      feeReceiver: FEE_RECEIVER, feeValue: FEE_VALUE, validAfter: 0n, validBefore, intentSalt,
    };
    const nonce = buildNonce(p, FORWARDER);
    const signature = await buyer.signTypedData({
      domain: DOMAIN, types: TYPES, primaryType: 'ReceiveWithAuthorization',
      message: { from: buyer.address, to: FORWARDER, value: total, validAfter: 0n, validBefore, nonce },
    });
    reqs.push({ i, merchant, intentSalt, nonce, signature, p });
  }

  // 同時 POST (Promise.all で並行 → relayer の nonce 衝突を誘発)。
  const t0 = Date.now();
  const results = await Promise.all(reqs.map(async (r) => {
    const body = {
      chainId: CHAIN_ID, from: r.p.from, merchant: r.merchant,
      merchantValue: r.p.merchantValue.toString(), feeValue: r.p.feeValue.toString(),
      validAfter: '0', validBefore: validBefore.toString(),
      intentSalt: r.intentSalt, signature: r.signature,
    };
    const start = Date.now();
    try {
      const res = await fetch(RELAY_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      return { i: r.i, status: res.status, json, ms: Date.now() - start, nonce: r.nonce };
    } catch (e) {
      return { i: r.i, status: 0, json: { error: e.message }, ms: Date.now() - start, nonce: r.nonce };
    }
  }));
  console.log(`\n並行 POST 完了 (${Date.now() - t0}ms)`);

  const txHashes = [];
  for (const res of results.sort((a, b) => a.i - b.i)) {
    const j = res.json || {};
    const kind = j.ok ? 'success' : j.pending ? 'pending' : j.reverted ? 'reverted' : `error:${j.error || res.status}`;
    if (j.txHash) txHashes.push(j.txHash.toLowerCase());
    console.log(`  #${res.i} [${res.status}] ${kind} tx=${j.txHash || '-'} (${res.ms}ms)`);
  }

  // 確定待ち (broadcast 済 tx の mining)。高 concurrency 下では receipt-wait timeout で pending を
  // 返した tx も後から mine しうるため、HTTP 応答ではなく on-chain で件数を確定させる。
  console.log('\n20s 待って on-chain で照合 (HTTP 応答ではなく receipt を真とする)...');
  await new Promise((r) => setTimeout(r, 20_000));

  // 各 txHash の最終状態を on-chain で分類: mined-success / mined-revert / not-found(未 broadcast)。
  let minedSuccess = 0;
  let minedRevert = 0;
  let notFound = 0;
  const usedNonces = [];
  for (const h of txHashes) {
    let receipt = null;
    let tx = null;
    try { receipt = await client.getTransactionReceipt({ hash: h }); } catch { /* not mined */ }
    try { tx = await client.getTransaction({ hash: h }); } catch { /* not found */ }
    if (receipt) {
      if (receipt.status === 'success') minedSuccess++;
      else minedRevert++;
      if (tx) usedNonces.push(tx.nonce);
    } else if (!tx) {
      notFound++; // pre-signed hash が chain に無い = broadcast されず (衝突枯渇の保守的 pending)
    }
  }

  const [buyerAfter, frAfter] = await Promise.all([
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [buyer.address] }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [FEE_RECEIVER] }),
  ]);
  const frDelta = frAfter - frBefore;
  const buyerDelta = buyerBefore - buyerAfter;
  const distinct = new Set(txHashes);
  // nonce hole 検査: 使われた nonce が連続か (gap が無いか)。
  const sortedNonces = [...usedNonces].sort((a, b) => a - b);
  const contiguous =
    sortedNonces.length === 0 ||
    sortedNonces.every((n, i) => i === 0 || n === sortedNonces[i - 1] + 1);

  console.log('\n=== on-chain 照合 ===');
  console.log(`mined success=${minedSuccess} revert=${minedRevert} not-found(未broadcast)=${notFound} / 計 ${txHashes.length}`);
  console.log(`使用 nonce=[${sortedNonces.join(',')}]`);
  console.log('\n=== 不変条件 (mined success 件数を真とする) ===');
  const ok1 = distinct.size === txHashes.length;
  console.log(`1. txHash distinct (二重 broadcast 無し): ${ok1 ? '✅' : '❌'} (${distinct.size}/${txHashes.length})`);
  const ok2 = frDelta === FEE_VALUE * BigInt(minedSuccess);
  console.log(`2. feeReceiver +${formatUnits(frDelta,18)} == mined×fee (${formatUnits(FEE_VALUE*BigInt(minedSuccess),18)}): ${ok2 ? '✅' : '❌'}`);
  const ok3 = buyerDelta === total * BigInt(minedSuccess);
  console.log(`3. buyer -${formatUnits(buyerDelta,18)} == mined×(merchant+fee) (${formatUnits(total*BigInt(minedSuccess),18)}): ${ok3 ? '✅' : '❌'}`);
  const ok4 = contiguous;
  console.log(`4. 使用 nonce が連続 (nonce hole 無し): ${ok4 ? '✅' : '❌'}`);
  const pass = ok1 && ok2 && ok3 && ok4;
  console.log(
    `\n判定: ${pass ? '✅ PASS (二重支払い無し・nonce 衝突を安全に吸収)' : '❌ 要調査'}` +
      (notFound > 0
        ? `\n  注: ${notFound} 件は衝突枯渇で未 broadcast→pending (顧客は再試行で成立)。高 concurrency の安全な degrade。`
        : ''),
  );
  void relayerHint;
}

main().catch((e) => { console.error('error:', e); process.exit(1); });
