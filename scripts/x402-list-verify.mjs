#!/usr/bin/env node
// x402-list の「verified」取得用 — 有料の delivery probe を依頼する (ブラウザのウォレットで署名・秘密鍵を扱わない)。
//
// verified は x402-list 自身が実際に支払って商品が返ったときだけ付く (自己申告不可・methodology)。
// 依頼は POST https://x402-list.com/api/v1/assess に probe target を付けて x402 (Base の USDC) で支払う:
//   $0.25 (AI 評価) + 対象エンドポイントの価格。probe 手数料は結果に関わらず返金なし。
//
//   node scripts/x402-list-verify.mjs                 # http://localhost:4600
//   HOST=0.0.0.0 node scripts/x402-list-verify.mjs     # ウォレットが別端末のとき (LAN)
//   DRY_RUN=1 node scripts/x402-list-verify.mjs        # 署名まで行い、支払いは送らない
//
// 既定の probe 対象は `/api/paid/usdc/japan-web3-directory` ($0.02・**引数なしで必ず 200 を返す**)。
// 引数必須のエンドポイントを選ぶと probe が content 400 で「届かなかった」扱いになり、手数料だけ失う。
// ⚠️ `/api/paid/hello` は x402-list の掲載対象外で probe が無視される (見積もりが $0.25 ちょうどになる)。
//
// 安全柵 (署名させる前にサーバ側で検査・1 つでも外れたら拒否):
//   - network = eip155:8453・asset = Base の native USDC・EIP-712 domain = USD Coin / 2
//   - amount = 250000 + 対象エンドポイントの価格 (probe が armed でない = 250000 ちょうどなら支払わない)
//   - amount <= MAX_USDC (既定 0.30)・署名後に 402 を取り直して payTo/amount を再照合

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4600);
const HOST = process.env.HOST ?? '127.0.0.1';
const DRY_RUN = process.env.DRY_RUN === '1';
const ASSESS_URL = 'https://x402-list.com/api/v1/assess';
const SLUG = process.env.SLUG ?? 'openpay';
const ENDPOINT_PATH = process.env.ENDPOINT_PATH ?? '/api/paid/usdc/japan-web3-directory';
const BASE = { chainId: 8453, label: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' };
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ADVISOR_ONLY_ATOMIC = 250_000n; // probe が付かないときの価格 ($0.25)
const MAX_ATOMIC = BigInt(Math.round(Number(process.env.MAX_USDC ?? '0.30') * 1e6));
const REQUEST_BODY = {
  question:
    'Is OpenPay a reliable x402 source of Japan stablecoin (JPYC/USDC) service and payment data for an autonomous agent?',
  services: [SLUG],
  probe: { slug: SLUG, endpoint_path: ENDPOINT_PATH },
};

const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

async function fetchChallenge() {
  const res = await fetch(ASSESS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(REQUEST_BODY),
  });
  if (res.status !== 402) throw new Error(`expected 402 from x402-list (got ${res.status}: ${(await res.text()).slice(0, 200)})`);
  const required = await res.json();
  const accept = required.accepts?.[0];
  if (!accept || required.accepts.length !== 1) throw new Error('expected exactly one accept');
  if (accept.scheme !== 'exact' || accept.network !== `eip155:${BASE.chainId}`) throw new Error(`unexpected scheme/network ${accept.scheme} ${accept.network}`);
  if (!eq(accept.asset, BASE_USDC)) throw new Error(`unexpected asset ${accept.asset}`);
  if (accept.extra?.name !== 'USD Coin' || accept.extra?.version !== '2') throw new Error(`unexpected EIP-712 domain ${JSON.stringify(accept.extra)}`);
  if (!/^[0-9]+$/.test(accept.amount)) throw new Error('amount is not an integer string');
  const amount = BigInt(accept.amount);
  if (amount <= ADVISOR_ONLY_ATOMIC) {
    throw new Error(`quote is ${accept.amount} (= advisor only). The live probe is not armed for ${ENDPOINT_PATH}, so paying would not earn "verified". Not paying.`);
  }
  if (amount > MAX_ATOMIC) throw new Error(`amount ${accept.amount} exceeds MAX_USDC (${MAX_ATOMIC} atomic)`);
  return { required, accept };
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
      return json(res, 200, { ...BASE, usdc: BASE_USDC, slug: SLUG, endpointPath: ENDPOINT_PATH, dryRun: DRY_RUN });
    }
    if (req.method === 'GET' && url.pathname === '/api/challenge') {
      const from = url.searchParams.get('from');
      if (!/^0x[0-9a-fA-F]{40}$/.test(from ?? '')) throw new Error('from address required');
      const { accept } = await fetchChallenge();
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from,
        to: accept.payTo,
        value: accept.amount,
        // 標準 x402 クライアントと同じ窓: 時計ずれを見込んで 10 分前から・期限は maxTimeoutSeconds。
        validAfter: String(now - 600),
        validBefore: String(now + accept.maxTimeoutSeconds),
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
        domain: { name: 'USD Coin', version: '2', chainId: BASE.chainId, verifyingContract: BASE_USDC },
        message: authorization,
      };
      return json(res, 200, { accept, authorization, typedData, probeFeeAtomic: (BigInt(accept.amount) - ADVISOR_ONLY_ATOMIC).toString() });
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const { authorization, signature } = await readBody(req);
      const { required, accept } = await fetchChallenge();
      if (!eq(authorization?.to, accept.payTo) || authorization?.value !== accept.amount) {
        throw new Error('authorization does not match the live quote (payTo/amount changed) — start over');
      }
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) throw new Error('signature must be 65 bytes hex');
      const payload = { x402Version: 2, resource: required.resource, accepted: accept, payload: { signature, authorization } };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');
      if (DRY_RUN) return json(res, 200, { dryRun: true, headerBytes: header.length, accept });
      const paid = await fetch(ASSESS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header },
        body: JSON.stringify(REQUEST_BODY),
      });
      const pr = paid.headers.get('payment-response');
      const text = await paid.text();
      let report = null;
      try { report = JSON.parse(text); } catch { /* 非 JSON はそのまま body に出す */ }
      const result = {
        status: paid.status,
        paymentResponse: pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) : null,
        probeReport: report?.data?.probe_report ?? report?.probe_report ?? null,
        modulesRun: report?.meta?.modules_run ?? null,
        body: text.slice(0, 1500),
      };
      console.log('[x402-list assess]', JSON.stringify(result).slice(0, 2000));
      return json(res, 200, result);
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402-list verified probe</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}
  h1{font-size:20px} h2{font-size:16px;margin:22px 0 6px}
  button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #8886;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  pre{background:#8881;padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:12.5px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .warn{color:#b45309}
</style></head><body>
<h1>x402-list verified probe <small id="net"></small></h1>
<p>x402-list に有料の delivery probe を依頼します (Base の USDC・ガス不要)。x402-list が OpenPay のエンドポイントを実際に購入し、商品が返れば <b>verified</b> が付きます。手数料は結果に関わらず返金されません。</p>
<h2>1. ウォレット接続 (Base)</h2>
<div class="row"><button id="connect">接続して Base に切替</button><span id="acct"></span></div>
<pre id="bal">未接続</pre>
<h2>2. 見積もり → 署名 → 支払い</h2>
<div class="row"><button id="buy" disabled>見積もりを取得して署名 → 支払い</button></div>
<pre id="log">-</pre>
<p class="warn">↑ 常設の注意書きです。署名ダイアログの to・value・verifyingContract (Base の USDC) が結果欄の表示と一致することを確認してから承認してください。署名の有効期間は 5 分です。</p>
<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
}
const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $('log'); el.textContent = (el.textContent === '-' ? '' : el.textContent + '\\n') + msg; };
const call = (method, params) => window.ethereum.request({ method, params });
let cfg, account;
$('connect').onclick = async () => {
  try {
    if (!window.ethereum) throw new Error('ウォレット拡張 (window.ethereum) が見つかりません');
    cfg = await (await fetch('/api/config')).json();
    $('net').textContent = '— ' + cfg.slug + ' ' + cfg.endpointPath + (cfg.dryRun ? ' [DRY RUN]' : '');
    [account] = await call('eth_requestAccounts', []);
    await call('wallet_switchEthereumChain', [{ chainId: '0x' + cfg.chainId.toString(16) }]);
    $('acct').textContent = account;
    const raw = await call('eth_call', [{ to: cfg.usdc, data: '0x70a08231' + account.replace(/^0x/, '').padStart(64, '0') }, 'latest']);
    $('bal').textContent = 'wallet USDC (Base): ' + (Number(BigInt(raw)) / 1e6).toFixed(6);
    $('buy').disabled = false;
  } catch (e) { $('bal').textContent = 'ERROR: ' + (e.message || e); }
};
$('buy').onclick = async () => {
  $('buy').disabled = true; $('log').textContent = '-';
  try {
    const ch = await (await fetch('/api/challenge?from=' + account)).json();
    if (ch.error) throw new Error(ch.error);
    log('to (x402-list payTo): ' + ch.accept.payTo + '\\nvalue: ' + ch.accept.amount + ' atomic (= ' + (Number(ch.accept.amount) / 1e6) + ' USDC・うち probe 対象の価格 ' + (Number(ch.probeFeeAtomic) / 1e6) + ')\\nverifyingContract: ' + ch.typedData.domain.verifyingContract + ' (Base USDC)');
    const signature = await call('eth_signTypedData_v4', [account, JSON.stringify(ch.typedData)]);
    log('signed. paying… (AI 評価と probe に 30〜90 秒かかります)');
    const out = await (await fetch('/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorization: ch.authorization, signature }) })).json();
    log(JSON.stringify(out, null, 2));
  } catch (e) { log('ERROR: ' + (e.message || e)); }
  $('buy').disabled = false;
};
</script></body></html>`;

server.listen(PORT, HOST, () => {
  console.log(`x402-list verified probe → ${SLUG} ${ENDPOINT_PATH}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`open http://localhost:${PORT}  (max ${Number(MAX_ATOMIC) / 1e6} USDC)`);
  if (HOST !== '127.0.0.1') console.log(`LAN: http://<this-machine-ip>:${PORT}  (HOST=${HOST})`);
});
