// @vitest-environment node
// scripts/x402-dual-buyer-example.mjs の鍵の出どころ (BUYER_PRIVATE_KEY か OpenPay Agent のウォレット) と、
// 署名の前の検査 (https だけ・転送を追わない・resource の origin・payTo の照合) を固定する。
// 支払いは起きない: 署名つきの再送もローカルのテストサーバーが受け取るだけ (資金のない一時の鍵)。
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
// @ts-expect-error -- 型定義のない .mjs (MCP の keystore をそのまま使う)
import { createWallet } from '../../packages/x402-mcp/src/keystore.mjs';

const script = resolve('scripts/x402-dual-buyer-example.mjs');
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NOT_USDC = '0x1111111111111111111111111111111111111111';
// スクリプトは https だけを受けるので、子プロセスの fetch をこの https の origin からローカルの http サーバーへ
// 差し替える (テストの子プロセスだけ・スクリプト本体に http の抜け道は作らない)。
const SELLER_ORIGIN = 'https://seller.test';
const FETCH_ALIAS = `
const upstream = process.env.DUAL_BUYER_TEST_UPSTREAM;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== ${JSON.stringify(SELLER_ORIGIN)}) throw new Error('unexpected fetch: ' + url.href);
  if (init?.redirect !== 'manual') throw new Error('fetch without redirect: manual');
  const res = await realFetch(upstream + url.pathname + url.search, init);
  const aliased = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(aliased, 'url', { value: url.href });
  return aliased;
};
`;

let home: string;
let server: Server;
let upstream: string;
let hits: number;
let elsewhereHits: number;
let firstRedirect: boolean;
let paidRedirect: boolean;
let accept: Record<string, unknown>;
let paymentHeader: string | undefined;

function listen(): Promise<string> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      upstream = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      done(`${SELLER_ORIGIN}/paid`);
    });
  });
}

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(home, 'fetch-alias.mjs')).href, script], {
      cwd: resolve('.'),
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, DUAL_BUYER_TEST_UPSTREAM: upstream, ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => done({ code, out }));
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-dual-buyer-'));
  await writeFile(join(home, 'fetch-alias.mjs'), FETCH_ALIAS);
  upstream = '';
  hits = 0;
  elsewhereHits = 0;
  firstRedirect = false;
  paidRedirect = false;
  accept = { scheme: 'exact', network: 'base', maxAmountRequired: '20000', asset: NOT_USDC, payTo: NOT_USDC, extra: { name: 'USD Coin', version: '2' } };
  paymentHeader = undefined;
  const challenge = () => JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'eip155:137' }, accept] });
  server = createServer((req, res) => {
    // 転送先。スクリプトが転送を追ったときだけ数が増える。
    if (req.url === '/elsewhere') {
      elsewhereHits += 1;
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(challenge());
      return;
    }
    hits += 1;
    // 署名つきの再送はここで受け取るだけ (どこにも転送しない = 支払いは起きない)。
    const payment = req.headers['x-payment'];
    if (typeof payment === 'string') {
      paymentHeader = payment;
      if (paidRedirect) {
        res.writeHead(302, { location: `${upstream}/elsewhere` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (firstRedirect) {
      res.writeHead(302, { location: `${upstream}/elsewhere` });
      res.end();
      return;
    }
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(challenge());
  });
});
afterEach(async () => {
  await new Promise((done) => server.close(done));
  await rm(home, { recursive: true, force: true });
});

describe('x402-dual-buyer-example の鍵の出どころ', () => {
  it('USE_AGENT_WALLET=1 は OpenPay Agent のウォレット (OPENPAY_X402_HOME) で署名し、鍵を出力しない', async () => {
    const agentHome = join(home, 'agent');
    const wallet = await createWallet({ env: { OPENPAY_X402_HOME: agentHome } });
    const url = await listen();
    const { code, out } = await run({ USE_AGENT_WALLET: '1', OPENPAY_X402_HOME: agentHome, RESOURCE_URL: url, MAX_USDC: '0.02' });
    expect(out).toContain(`buyer : ${wallet.public.address}`);
    // Base の USDC でない資産には署名せずに止まる (支払いは起きない)
    expect(out).toContain('asset が Base native USDC ではないため中止');
    expect(code).toBe(1);
    expect(hits).toBe(1);
    expect(out).not.toContain(wallet.secret.privateKey);
    expect(out).not.toContain(wallet.secret.privateKey.slice(2));
  });

  // Codex P3: 署名まで進む経路も固定する。上限ちょうどの請求に、Agent のウォレットが署名者として署名したことを
  // オフラインで復元して確かめる (受け取るのは 127.0.0.1 のテストサーバーだけ・資金のない一時ウォレット)。
  it('上限ちょうどの請求には Agent のウォレットで署名し、署名者・額・宛先が一致する', async () => {
    const agentHome = join(home, 'agent');
    const wallet = await createWallet({ env: { OPENPAY_X402_HOME: agentHome } });
    accept = { ...accept, asset: BASE_USDC, maxAmountRequired: '20000' };
    const url = await listen();
    const { code, out } = await run({ USE_AGENT_WALLET: '1', OPENPAY_X402_HOME: agentHome, RESOURCE_URL: url, MAX_USDC: '0.02' });
    expect(code).toBe(0);
    expect(hits).toBe(2);
    expect(out).toContain('HTTP 200');
    // EXPECTED_PAY_TO を渡していないので、payTo を照合していないことを出してから署名する
    expect(out).toContain('payTo は確かめていません');
    expect(out).not.toContain(wallet.secret.privateKey.slice(2));
    const sent = JSON.parse(Buffer.from(paymentHeader!, 'base64').toString('utf8'));
    const { authorization, signature } = sent.payload;
    expect(sent).toMatchObject({ scheme: 'exact', network: 'base' });
    expect(authorization).toMatchObject({ from: wallet.public.address, to: NOT_USDC, value: '20000', validAfter: '0' });
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: 0n,
        validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
      },
      signature,
    });
    expect(signer).toBe(wallet.public.address);
  });

  it('上限 (MAX_USDC) を超える請求には Agent のウォレットでも署名しない', async () => {
    const agentHome = join(home, 'agent');
    await createWallet({ env: { OPENPAY_X402_HOME: agentHome } });
    accept = { ...accept, asset: BASE_USDC, maxAmountRequired: '20000' };
    const url = await listen();
    const { code, out } = await run({ USE_AGENT_WALLET: '1', OPENPAY_X402_HOME: agentHome, RESOURCE_URL: url, MAX_USDC: '0.01' });
    expect(out).toContain('上限 MAX_USDC=0.01 を超過');
    expect(code).toBe(1);
    expect(hits).toBe(1);
  });

  it('Agent のウォレットが無ければ、402 を取りに行く前に止まる', async () => {
    const url = await listen();
    const { code, out } = await run({ USE_AGENT_WALLET: '1', OPENPAY_X402_HOME: join(home, 'empty'), RESOURCE_URL: url });
    expect(out).toContain('OpenPay Agent のウォレットがありません');
    expect(code).toBe(1);
    expect(hits).toBe(0);
  });

  it('BUYER_PRIVATE_KEY と USE_AGENT_WALLET=1 の両方は拒否する (どちらの鍵で払うかを曖昧にしない)', async () => {
    const url = await listen();
    const { code, out } = await run({ USE_AGENT_WALLET: '1', BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url });
    expect(out).toContain('どちらか 1 つにしてください');
    expect(code).toBe(1);
    expect(hits).toBe(0);
  });

  it('従来どおり BUYER_PRIVATE_KEY でも動く (このファイル単体の使い方は変えない)', async () => {
    const key = generatePrivateKey();
    const url = await listen();
    const { code, out } = await run({ BUYER_PRIVATE_KEY: key, RESOURCE_URL: url, MAX_USDC: '0.02' });
    expect(out).toContain(`buyer : ${privateKeyToAccount(key).address}`);
    expect(out).toContain('asset が Base native USDC ではないため中止');
    expect(code).toBe(1);
    expect(out).not.toContain(key.slice(2));
  });

  it('どちらも無ければ、両方の選択肢を案内して止まる', async () => {
    const url = await listen();
    const { code, out } = await run({ RESOURCE_URL: url });
    expect(out).toContain('BUYER_PRIVATE_KEY env (0x...) か USE_AGENT_WALLET=1 が必要です');
    expect(code).toBe(1);
    expect(hits).toBe(0);
  });
});

describe('x402-dual-buyer-example の署名の前の検査 (https・転送・resource・payTo)', () => {
  const OTHER_PAY_TO = '0x2222222222222222222222222222222222222222';

  it('http の RESOURCE_URL は 402 を取りに行く前に止まる (平文の支払条件に署名しない)', async () => {
    await listen();
    const { code, out } = await run({ BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: `${upstream}/paid` });
    expect(out).toContain('RESOURCE_URL は https の URL にしてください');
    expect(code).toBe(1);
    expect(hits).toBe(0);
  });

  it('402 の取得が転送なら転送先を追わず、署名せずに止まる', async () => {
    firstRedirect = true;
    accept = { ...accept, asset: BASE_USDC };
    const url = await listen();
    const { code, out } = await run({ BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url, MAX_USDC: '0.02' });
    expect(out).toContain('402 の取得の応答が転送 (HTTP 302) でした');
    expect(code).toBe(1);
    expect(hits).toBe(1);
    expect(elsewhereHits).toBe(0);
    expect(paymentHeader).toBeUndefined();
  });

  it('支払条件の resource が別の origin なら署名しない', async () => {
    accept = { ...accept, asset: BASE_USDC, resource: 'https://other.test/paid' };
    const url = await listen();
    const { code, out } = await run({ BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url, MAX_USDC: '0.02' });
    expect(out).toContain(`支払条件の resource が購入先 ${SELLER_ORIGIN} と別の origin のため中止`);
    expect(code).toBe(1);
    expect(hits).toBe(1);
    expect(paymentHeader).toBeUndefined();
  });

  it('EXPECTED_PAY_TO と違う payTo には署名しない', async () => {
    accept = { ...accept, asset: BASE_USDC };
    const url = await listen();
    const { code, out } = await run({
      BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url, MAX_USDC: '0.02', EXPECTED_PAY_TO: OTHER_PAY_TO,
    });
    expect(out).toContain(`payTo が EXPECTED_PAY_TO=${OTHER_PAY_TO} と違うため中止`);
    expect(code).toBe(1);
    expect(hits).toBe(1);
    expect(paymentHeader).toBeUndefined();
  });

  it('EXPECTED_PAY_TO と一致し resource も同じ origin なら、署名して最初の URL へだけ送る', async () => {
    accept = { ...accept, asset: BASE_USDC, resource: `${SELLER_ORIGIN}/paid` };
    const url = await listen();
    const { code, out } = await run({
      BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url, MAX_USDC: '0.02', EXPECTED_PAY_TO: NOT_USDC,
    });
    expect(out).toContain('payTo は EXPECTED_PAY_TO と一致');
    expect(out).not.toContain('payTo は確かめていません');
    expect(code).toBe(0);
    expect(hits).toBe(2);
    expect(paymentHeader).toBeDefined();
  });

  it('署名した支払いの再送が転送で返っても転送先へは送らず、失敗で終わる', async () => {
    paidRedirect = true;
    accept = { ...accept, asset: BASE_USDC };
    const url = await listen();
    const { code, out } = await run({ BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url, MAX_USDC: '0.02' });
    expect(out).toContain('HTTP 302');
    expect(out).toContain('支払いの再送の応答が転送 (HTTP 302) でした');
    expect(code).toBe(1);
    expect(hits).toBe(2);
    expect(elsewhereHits).toBe(0);
  });

  it('EXPECTED_PAY_TO がアドレスの形でなければ 402 を取りに行く前に止まる', async () => {
    const url = await listen();
    const { code, out } = await run({ BUYER_PRIVATE_KEY: generatePrivateKey(), RESOURCE_URL: url, EXPECTED_PAY_TO: 'seller' });
    expect(out).toContain('EXPECTED_PAY_TO はアドレス');
    expect(code).toBe(1);
    expect(hits).toBe(0);
  });
});
