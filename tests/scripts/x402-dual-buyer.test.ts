// @vitest-environment node
// scripts/x402-dual-buyer-example.mjs の鍵の出どころ (BUYER_PRIVATE_KEY か OpenPay Agent のウォレット) を固定する。
// 支払いは起きない: ローカルの 402 が Base の USDC 以外 / 上限超過を返すので、署名の前で止まる。
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
// @ts-expect-error -- 型定義のない .mjs (MCP の keystore をそのまま使う)
import { createWallet } from '../../packages/x402-mcp/src/keystore.mjs';

const script = resolve('scripts/x402-dual-buyer-example.mjs');
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NOT_USDC = '0x1111111111111111111111111111111111111111';

let home: string;
let server: Server;
let hits: number;
let accept: Record<string, unknown>;
let paymentHeader: string | undefined;

function listen(): Promise<string> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/paid`);
    });
  });
}

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], {
      cwd: resolve('.'),
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => done({ code, out }));
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-dual-buyer-'));
  hits = 0;
  accept = { scheme: 'exact', network: 'base', maxAmountRequired: '20000', asset: NOT_USDC, payTo: NOT_USDC, extra: { name: 'USD Coin', version: '2' } };
  paymentHeader = undefined;
  server = createServer((req, res) => {
    hits += 1;
    // 署名つきの再送はここで受け取るだけ (どこにも転送しない = 支払いは起きない)。
    const payment = req.headers['x-payment'];
    if (typeof payment === 'string') {
      paymentHeader = payment;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'eip155:137' }, accept] }));
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
