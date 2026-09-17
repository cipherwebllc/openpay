#!/usr/bin/env node
// Arc x402 rail (Circle Gateway) の買い手 smoke — ブラウザのウォレットで署名する (秘密鍵を扱わない)。
// DEPLOY_CHECKLIST §14.8 の「本番 smoke: mainnet で hello を Arc accept で 1 件実購入」用。
//
//   node scripts/arc-gateway-buyer-smoke.mjs            # mainnet (https://open-pay.jp・Arc 5042)
//   node scripts/arc-gateway-buyer-smoke.mjs --testnet  # testnet (http://localhost:3141・Arc 5042002)
//   → http://localhost:4599 をウォレットのあるブラウザで開く
//   ウォレットが別の端末にある場合: HOST=0.0.0.0 で起動し、その端末から http://<この Mac の IP>:4599
//
// 役割分担: このサーバが 402 の取得・検査・支払いリクエストの送信を行い (CORS を避ける)、ページは
// window.ethereum でチェーン切替・USDC の Gateway deposit・EIP-712 署名だけを行う。
//
// 安全柵 (署名させる前にサーバ側で必ず検査し、1 つでも外れたら拒否):
//   - 支払い先 path は /api/paid/ 配下のみ
//   - accept.network / asset / extra.verifyingContract が既知の Arc・USDC・Gateway Wallet と完全一致
//   - accept.amount <= MAX_ATOMIC (既定 50000 = $0.05。env MAX_USDC で変更)
//   - 署名は TransferWithAuthorization のみ・value は accept.amount と同値・to は accept.payTo

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, pad, parseAbi } from 'viem';

const TESTNET = process.argv.includes('--testnet');
const PORT = Number(process.env.PORT ?? 4599);
// 既定は localhost のみ。ウォレットが別の端末にあるときだけ HOST=0.0.0.0 で LAN に開く
// (このサーバは鍵を持たず、署名は常に接続したウォレット内。用が済んだら止める)。
const HOST = process.env.HOST ?? '127.0.0.1';
const NET = TESTNET
  ? {
      label: 'Arc Testnet',
      chainId: 5042002,
      rpc: 'https://rpc.testnet.arc.io',
      explorer: 'https://explorer.testnet.arc.io',
      gatewayApi: 'https://gateway-api-testnet.circle.com',
      gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
      target: process.env.TARGET ?? 'http://localhost:3141',
    }
  : {
      label: 'Arc',
      chainId: 5042,
      rpc: 'https://rpc.mainnet.arc.io',
      explorer: 'https://explorer.arc.io',
      gatewayApi: 'https://gateway-api.circle.com',
      gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
      gatewayMinter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
      target: process.env.TARGET ?? 'https://open-pay.jp',
    };
const USDC = '0x3600000000000000000000000000000000000000';
const GATEWAY_DOMAIN = 26; // Circle domain for Arc
const MAX_ATOMIC = BigInt(Math.round(Number(process.env.MAX_USDC ?? '0.05') * 1e6));

// withdraw (売り手の Gateway 残高 → 同じウォレットの Arc USDC)。同一チェーンは transfer fee なし・
// burn の gas fee は Arc で $0.0035 (Gateway fees)。maxFee はその上限として 0.02 USDC に固定する。
const WITHDRAW_MAX_FEE = 20_000n;
const MAX_UINT256 = (2n ** 256n - 1n).toString();
const GATEWAY_MINT_ABI = parseAbi(['function gatewayMint(bytes attestationPayload, bytes signature)']);
const b32 = (address) => pad(address.toLowerCase(), { size: 32 });

function buildWithdrawTypedData(from, atomic) {
  const spec = {
    version: 1,
    sourceDomain: GATEWAY_DOMAIN,
    destinationDomain: GATEWAY_DOMAIN,
    sourceContract: b32(NET.gatewayWallet),
    destinationContract: b32(NET.gatewayMinter),
    sourceToken: b32(USDC),
    destinationToken: b32(USDC),
    sourceDepositor: b32(from),
    // 受取人は署名者自身に固定 (このツールから第三者宛てに引き出せない)。
    destinationRecipient: b32(from),
    sourceSigner: b32(from),
    destinationCaller: b32('0x0000000000000000000000000000000000000000'),
    value: atomic.toString(),
    salt: `0x${randomBytes(32).toString('hex')}`,
    hookData: '0x',
  };
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
      ],
      TransferSpec: [
        { name: 'version', type: 'uint32' },
        { name: 'sourceDomain', type: 'uint32' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'sourceContract', type: 'bytes32' },
        { name: 'destinationContract', type: 'bytes32' },
        { name: 'sourceToken', type: 'bytes32' },
        { name: 'destinationToken', type: 'bytes32' },
        { name: 'sourceDepositor', type: 'bytes32' },
        { name: 'destinationRecipient', type: 'bytes32' },
        { name: 'sourceSigner', type: 'bytes32' },
        { name: 'destinationCaller', type: 'bytes32' },
        { name: 'value', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
        { name: 'hookData', type: 'bytes' },
      ],
      BurnIntent: [
        { name: 'maxBlockHeight', type: 'uint256' },
        { name: 'maxFee', type: 'uint256' },
        { name: 'spec', type: 'TransferSpec' },
      ],
    },
    domain: { name: 'GatewayWallet', version: '1' },
    primaryType: 'BurnIntent',
    message: { maxBlockHeight: MAX_UINT256, maxFee: WITHDRAW_MAX_FEE.toString(), spec },
  };
}

const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

async function fetchChallenge(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/paid/')) throw new Error('path must start with /api/paid/');
  const res = await fetch(`${NET.target}${path}`);
  const header = res.headers.get('payment-required');
  if (res.status !== 402 || !header) throw new Error(`expected 402 + PAYMENT-REQUIRED (got ${res.status})`);
  const required = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  const accept = (required.accepts ?? []).find((a) => a?.extra?.name === 'GatewayWalletBatched');
  if (!accept) throw new Error('no Arc (GatewayWalletBatched) accept in the 402 — is ENABLE_X402_ARC_GATEWAY on?');
  // 安全柵: 既知の Arc / USDC / Gateway Wallet と完全一致しない accept には署名させない。
  if (accept.scheme !== 'exact') throw new Error(`unexpected scheme ${accept.scheme}`);
  if (accept.network !== `eip155:${NET.chainId}`) throw new Error(`unexpected network ${accept.network}`);
  if (!eq(accept.asset, USDC)) throw new Error(`unexpected asset ${accept.asset}`);
  if (accept.extra.version !== '1' || !eq(accept.extra.verifyingContract, NET.gatewayWallet)) {
    throw new Error(`unexpected Gateway domain ${JSON.stringify(accept.extra)}`);
  }
  if (!/^[0-9]+$/.test(accept.amount) || BigInt(accept.amount) > MAX_ATOMIC) {
    throw new Error(`amount ${accept.amount} exceeds MAX_USDC (${MAX_ATOMIC} atomic)`);
  }
  return { required, accept };
}

async function gatewayBalance(address) {
  const res = await fetch(`${NET.gatewayApi}/v1/balances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ domain: GATEWAY_DOMAIN, depositor: address }] }),
  });
  if (!res.ok) throw new Error(`gateway balances HTTP ${res.status}`);
  const row = (await res.json()).balances?.[0] ?? {};
  return { balance: row.balance ?? '0', pendingBatch: row.pendingBatch ?? '0' };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { ...NET, usdc: USDC, maxAtomic: MAX_ATOMIC.toString(), testnet: TESTNET });
    }
    if (req.method === 'GET' && url.pathname === '/api/balance') {
      return json(res, 200, await gatewayBalance(url.searchParams.get('address')));
    }
    if (req.method === 'GET' && url.pathname === '/api/challenge') {
      const from = url.searchParams.get('from');
      if (!/^0x[0-9a-fA-F]{40}$/.test(from ?? '')) throw new Error('from address required');
      const { required, accept } = await fetchChallenge(url.searchParams.get('path'));
      if (eq(from, accept.payTo)) throw new Error('buyer equals payTo (Gateway rejects self_transfer) — use another wallet');
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from,
        to: accept.payTo,
        value: accept.amount,
        validAfter: '0',
        validBefore: String(now + accept.maxTimeoutSeconds - 60),
        nonce: `0x${randomBytes(32).toString('hex')}`,
      };
      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
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
        domain: {
          name: accept.extra.name,
          version: accept.extra.version,
          chainId: NET.chainId,
          verifyingContract: accept.extra.verifyingContract,
        },
        message: authorization,
      };
      return json(res, 200, { resource: required.resource, accept, authorization, typedData });
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const { path, authorization, signature } = await readBody(req);
      // 署名後にも 402 を取り直して同じ検査を通す (ページ側の値を信用しない)。
      const { required, accept } = await fetchChallenge(path);
      if (!eq(authorization?.to, accept.payTo) || authorization?.value !== accept.amount) {
        throw new Error('authorization does not match the live 402 (payTo/amount changed)');
      }
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) throw new Error('signature must be 65 bytes hex');
      const payload = { x402Version: 2, resource: required.resource, accepted: accept, payload: { signature, authorization } };
      const started = Date.now();
      const paid = await fetch(`${NET.target}${path}`, {
        headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') },
      });
      const pr = paid.headers.get('payment-response');
      const result = {
        status: paid.status,
        ms: Date.now() - started,
        paymentResponse: pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) : null,
        body: (await paid.text()).slice(0, 600),
      };
      console.log('[pay]', path, JSON.stringify(result));
      return json(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/withdraw-intent') {
      const from = url.searchParams.get('from');
      if (!/^0x[0-9a-fA-F]{40}$/.test(from ?? '')) throw new Error('from address required');
      const atomic = BigInt(Math.round(Number(url.searchParams.get('amount')) * 1e6));
      if (atomic <= 0n) throw new Error('amount must be > 0');
      const { balance } = await gatewayBalance(from);
      const available = BigInt(Math.round(Number(balance) * 1e6));
      if (atomic + WITHDRAW_MAX_FEE > available) {
        throw new Error(`Gateway balance ${balance} USDC is below amount + max fee (${Number(atomic + WITHDRAW_MAX_FEE) / 1e6})`);
      }
      return json(res, 200, { typedData: buildWithdrawTypedData(from, atomic), maxFee: WITHDRAW_MAX_FEE.toString() });
    }
    if (req.method === 'POST' && url.pathname === '/api/withdraw') {
      const { message, signature } = await readBody(req);
      // 署名済み intent を検査: 同一チェーン・受取人 = 署名者・上限内の maxFee だけを Gateway へ渡す。
      const spec = message?.spec ?? {};
      if (
        spec.sourceDomain !== GATEWAY_DOMAIN || spec.destinationDomain !== GATEWAY_DOMAIN ||
        spec.destinationRecipient !== spec.sourceDepositor || spec.sourceSigner !== spec.sourceDepositor ||
        !eq(spec.destinationContract, b32(NET.gatewayMinter)) || !eq(spec.sourceContract, b32(NET.gatewayWallet)) ||
        BigInt(message.maxFee ?? '0') > WITHDRAW_MAX_FEE
      ) {
        throw new Error('burn intent does not match the expected same-chain self-withdraw shape');
      }
      const gw = await fetch(`${NET.gatewayApi}/v1/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ burnIntent: message, signature }]),
      });
      const out = await gw.json().catch(() => null);
      if (!gw.ok || !out?.attestation || !out?.signature) {
        throw new Error(`gateway /v1/transfer HTTP ${gw.status}: ${JSON.stringify(out).slice(0, 300)}`);
      }
      const data = encodeFunctionData({ abi: GATEWAY_MINT_ABI, functionName: 'gatewayMint', args: [out.attestation, out.signature] });
      console.log('[withdraw]', JSON.stringify({ transferId: out.transferId, fees: out.fees }));
      return json(res, 200, { to: NET.gatewayMinter, data, transferId: out.transferId ?? null, fees: out.fees ?? null });
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc x402 buyer smoke</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}
  h1{font-size:20px} h2{font-size:16px;margin:22px 0 6px}
  button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #8886;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  input{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid #8886;width:110px}
  pre{background:#8881;padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:12.5px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .warn{color:#b45309}
</style></head><body>
<h1>Arc x402 buyer smoke <small id="net"></small></h1>
<p>Circle Gateway の残高から、OpenPay の有料 API を Arc の USDC で 1 件購入します。秘密鍵は扱いません (署名はウォレット内)。</p>

<h2>1. ウォレット接続</h2>
<div class="row"><button id="connect">接続して Arc に切替</button><span id="acct"></span></div>
<pre id="bal">未接続</pre>

<h2>2. Gateway に deposit (初回のみ・残高が足りていれば不要)</h2>
<div class="row"><input id="amt" value="1" inputmode="decimal"> USDC <button id="deposit" disabled>approve → deposit</button></div>
<pre id="depLog">-</pre>

<h2>3. 購入</h2>
<div class="row"><input id="path" value="/api/paid/hello" style="width:260px"> <button id="buy" disabled>402 を取得して署名 → 支払い</button></div>
<pre id="buyLog">-</pre>
<p class="warn">↑ 常設の注意書きです (エラーではありません)。署名ダイアログの to・value・verifyingContract が結果欄の表示と一致することを確認してから承認してください。</p>

<h2>4. 引き出し (売り手用: Gateway 残高 → このウォレットの Arc USDC)</h2>
<p>受取先は接続中のウォレット自身に固定です。Gateway の burn 手数料 (Arc は約 0.0035 USDC・上限 0.02) が残高から引かれ、mint のガスはウォレットの USDC で支払います。</p>
<div class="row"><input id="wamt" value="0.01" inputmode="decimal"> USDC <button id="withdraw" disabled>BurnIntent に署名 → mint</button></div>
<pre id="wLog">-</pre>

<script>
const $ = (id) => document.getElementById(id);
const log = (id, msg) => { const el = $(id); el.textContent = (el.textContent === '-' ? '' : el.textContent + '\\n') + msg; };
let cfg, account;
const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const call = (method, params) => window.ethereum.request({ method, params });
async function waitReceipt(hash) {
  for (let i = 0; i < 120; i++) {
    const r = await call('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 1500));
  }
  throw new Error('receipt timeout ' + hash);
}
async function refresh() {
  const raw = await call('eth_call', [{ to: cfg.usdc, data: '0x70a08231' + pad(account) }, 'latest']);
  const wallet = Number(BigInt(raw)) / 1e6;
  const gw = await (await fetch('/api/balance?address=' + account)).json();
  $('bal').textContent = 'wallet USDC (' + cfg.label + '): ' + wallet.toFixed(6) + '\\nGateway 残高: ' + gw.balance + ' (pendingBatch ' + gw.pendingBatch + ')';
}
$('connect').onclick = async () => {
  try {
    if (!window.ethereum) throw new Error('ウォレット拡張 (window.ethereum) が見つかりません');
    cfg = await (await fetch('/api/config')).json();
    $('net').textContent = '— ' + cfg.label + ' (' + cfg.chainId + ') → ' + cfg.target;
    [account] = await call('eth_requestAccounts', []);
    try {
      await call('wallet_switchEthereumChain', [{ chainId: hex(cfg.chainId) }]);
    } catch (e) {
      if (e.code !== 4902) throw e;
      await call('wallet_addEthereumChain', [{ chainId: hex(cfg.chainId), chainName: cfg.label, rpcUrls: [cfg.rpc], blockExplorerUrls: [cfg.explorer], nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 } }]);
    }
    $('acct').textContent = account;
    await refresh();
    $('deposit').disabled = false; $('buy').disabled = false; $('withdraw').disabled = false;
  } catch (e) { $('bal').textContent = 'ERROR: ' + (e.message || e); }
};
$('deposit').onclick = async () => {
  $('deposit').disabled = true; $('depLog').textContent = '-';
  try {
    const atomic = BigInt(Math.round(Number($('amt').value) * 1e6));
    if (atomic <= 0n) throw new Error('amount > 0');
    const before = Number((await (await fetch('/api/balance?address=' + account)).json()).balance);
    const approve = await call('eth_sendTransaction', [{ from: account, to: cfg.usdc, data: '0x095ea7b3' + pad(cfg.gatewayWallet) + pad(hex(atomic)) }]);
    log('depLog', 'approve tx ' + approve); const r1 = await waitReceipt(approve); log('depLog', 'approve status ' + r1.status);
    if (r1.status !== '0x1') throw new Error('approve reverted');
    const dep = await call('eth_sendTransaction', [{ from: account, to: cfg.gatewayWallet, data: '0x47e7ef24' + pad(cfg.usdc) + pad(hex(atomic)) }]);
    log('depLog', 'deposit tx ' + dep); const r2 = await waitReceipt(dep); log('depLog', 'deposit status ' + r2.status);
    if (r2.status !== '0x1') throw new Error('deposit reverted');
    for (let i = 0; i < 40; i++) { await refresh(); if (Number((await (await fetch('/api/balance?address=' + account)).json()).balance) > before) break; await new Promise((s) => setTimeout(s, 3000)); }
    log('depLog', 'Gateway 残高に反映');
  } catch (e) { log('depLog', 'ERROR: ' + (e.message || e)); }
  $('deposit').disabled = false;
};
$('withdraw').onclick = async () => {
  $('withdraw').disabled = true; $('wLog').textContent = '-';
  try {
    const intent = await (await fetch('/api/withdraw-intent?from=' + account + '&amount=' + encodeURIComponent($('wamt').value))).json();
    if (intent.error) throw new Error(intent.error);
    log('wLog', 'value: ' + intent.typedData.message.spec.value + ' atomic / maxFee: ' + intent.maxFee + ' atomic / recipient: 自分 (' + account + ')');
    const signature = await call('eth_signTypedData_v4', [account, JSON.stringify(intent.typedData)]);
    log('wLog', 'signed. requesting attestation…');
    const att = await (await fetch('/api/withdraw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: intent.typedData.message, signature }) })).json();
    if (att.error) throw new Error(att.error);
    log('wLog', 'attestation ok (transferId ' + att.transferId + ' / fees ' + JSON.stringify(att.fees) + ')');
    const tx = await call('eth_sendTransaction', [{ from: account, to: att.to, data: att.data }]);
    log('wLog', 'mint tx ' + tx); const r = await waitReceipt(tx); log('wLog', 'mint status ' + r.status);
    await refresh();
  } catch (e) { log('wLog', 'ERROR: ' + (e.message || e)); }
  $('withdraw').disabled = false;
};
$('buy').onclick = async () => {
  $('buy').disabled = true; $('buyLog').textContent = '-';
  try {
    const path = $('path').value.trim();
    const ch = await (await fetch('/api/challenge?path=' + encodeURIComponent(path) + '&from=' + account)).json();
    if (ch.error) throw new Error(ch.error);
    log('buyLog', 'to (payTo): ' + ch.accept.payTo + '\\nvalue: ' + ch.accept.amount + ' atomic (= ' + (Number(ch.accept.amount) / 1e6) + ' USDC)\\nverifyingContract: ' + ch.accept.extra.verifyingContract + '\\nnetwork: ' + ch.accept.network);
    const signature = await call('eth_signTypedData_v4', [account, JSON.stringify(ch.typedData)]);
    log('buyLog', 'signed. paying…');
    const out = await (await fetch('/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, authorization: ch.authorization, signature }) })).json();
    log('buyLog', JSON.stringify(out, null, 2));
    await refresh();
  } catch (e) { log('buyLog', 'ERROR: ' + (e.message || e)); }
  $('buy').disabled = false;
};
</script></body></html>`;

server.listen(PORT, HOST, () => {
  console.log(`Arc x402 buyer smoke (${NET.label} ${NET.chainId}) → ${NET.target}`);
  console.log(`open http://localhost:${PORT}  (max ${Number(MAX_ATOMIC) / 1e6} USDC per purchase)`);
  if (HOST !== '127.0.0.1') console.log(`LAN: http://<this-machine-ip>:${PORT}  (HOST=${HOST})`);
});
