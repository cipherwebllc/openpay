// C-2 (全レビュー第 8 回・PR-08): SDK の executor が出品者の応答を上限つきで読む。
// - 支払い前 (402 challenge) は 256 KiB・支払い後 (X-PAYMENT の応答) は既定 16 MiB で option で変えられる。
// - 上限は stream から数えた byte で判定する (Content-Length は無いか嘘でありうる)。超えたら cancel して以後読まない。
// - 支払い後に超えたら例外ではなく、settlement・txHash・authorization nonce を持った構造化の結果を返す
//   (払ったのに一般的な失敗に見えて、もう一度払う事故を防ぐ)。
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type PayResult = Record<string, unknown>;
type Client = {
  pay: (url: string, options: { maxTotalJpyc: string }) => Promise<PayResult>;
  quote: (url: string) => Promise<PayResult>;
  session: { spentAtomic: bigint; spentJpyc: string };
};
type SdkModule = {
  buildTypedDataFromPaymentRequirements: (
    accept: Record<string, unknown>,
    authorization: Record<string, unknown>,
  ) => { typedData: { message: { nonce: Hex } } };
  createOpenPayClient: (options?: Record<string, unknown>) => Client;
  createPaymentExecutor: (options: Record<string, unknown>) => unknown;
  parseClientOptions: (options?: Record<string, unknown>) => Record<string, unknown>;
  createPaymentSession: () => { spentAtomic: bigint };
  MAX_CHALLENGE_BODY_BYTES: number;
  DEFAULT_MAX_PAID_BODY_BYTES: number;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const NODE_BODY_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/nodeBody.mjs');
const JPYC = 10n ** 18n;
const KiB = 1024;
const MiB = 1024 * KiB;
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const SUPPORTED_URL = 'https://open-pay.jp/api/facilitator/supported';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const RECEIPT_PRIVATE_KEY = `0x${'2'.repeat(64)}` as Hex;
const RECEIPT_TX = `0x${'a'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const account = privateKeyToAccount(PRIVATE_KEY);
const receiptAccount = privateKeyToAccount(RECEIPT_PRIVATE_KEY);
// 本物の DNS に出ない (fetchPaymentTarget は lookup があれば公開アドレスであることだけ確かめる)。
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

type NodeResponseBody = (response: unknown) => ReadableStream<Uint8Array>;

// 既定 transport が IncomingMessage を WHATWG body にする関数 (index.mjs からは出さない内部 module)。
async function loadNodeResponseBody(): Promise<NodeResponseBody> {
  const mod = (await import(pathToFileURL(NODE_BODY_ENTRY).href)) as {
    nodeResponseBody: NodeResponseBody;
  };
  return mod.nodeResponseBody;
}

// IncomingMessage の代わり。event を test から好きな順で出せる。
function fakeResponse() {
  return Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  });
}

function accept() {
  const merchantValue = 5n * JPYC;
  const feeValue = 2n * JPYC;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: RESOURCE,
    description: 'demo',
    mimeType: 'application/json',
    payTo: FORWARDER,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Content-Length の無い有限の stream。pull ごとに出した byte を数え、cancel を記録する。
// 有限にしてあるので、上限を外した版 (mutation) でも test は止まらずに「全部読んだ」で落ちる。
// onCancel で、cancel が reject する / いつまでも終わらない transport を再現できる。
function countingStream(
  totalBytes: number,
  chunkBytes: number,
  onCancel?: () => void | Promise<void>,
) {
  const chunk = new Uint8Array(chunkBytes).fill(0x78); // 'x'
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulled >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - stats.pulled);
      stats.pulled += size;
      controller.enqueue(size === chunkBytes ? chunk : chunk.subarray(0, size));
    },
    cancel() {
      stats.cancelled = true;
      return onCancel?.();
    },
  });
  return { stream, stats };
}

// custom transport の body の再現: getReader() と cancel() を持つが WHATWG stream ではなく、
// cancel() が promise を返さない (undefined)。`.catch` を直接つなぐと TypeError になる形。
function duckBody(totalBytes: number, chunkBytes: number) {
  const chunk = new Uint8Array(chunkBytes).fill(0x78);
  const stats = { pulled: 0, cancelled: false };
  const cancel = () => {
    stats.cancelled = true;
    return undefined;
  };
  const body = {
    getReader: () => ({
      read: async () => {
        if (stats.pulled >= totalBytes) return { done: true, value: undefined };
        stats.pulled += chunkBytes;
        return { done: false, value: chunk };
      },
      cancel,
    }),
    cancel,
  };
  return { body, stats };
}

// pay() / quote() が戻らないとき (cancel を await して止まる) に test を落とす。
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    }),
  ]);
}

function hasPayment(init?: RequestInit) {
  return new Headers(init?.headers).has('X-PAYMENT');
}

// 送られた X-PAYMENT から EIP-3009 の nonce (forwarder の intent から導出) を復元する。
function paymentNonce(sdk: SdkModule, init?: RequestInit): Hex {
  const payment = new Headers(init?.headers).get('X-PAYMENT') as string;
  const payload = JSON.parse(Buffer.from(payment, 'base64').toString('utf8')) as {
    payload: { authorization: Record<string, unknown> };
  };
  return sdk.buildTypedDataFromPaymentRequirements(accept(), payload.payload.authorization)
    .typedData.message.nonce;
}

async function signedPaymentResponse(nonce: Hex) {
  const signature = await receiptAccount.signTypedData({
    domain: { name: 'OpenPay x402 Facilitator', version: '1' },
    types: {
      Receipt: [
        { name: 'txHash', type: 'bytes32' },
        { name: 'payer', type: 'address' },
        { name: 'payTo', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint256' },
        { name: 'asset', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'Receipt',
    message: {
      txHash: RECEIPT_TX,
      payer: account.address,
      payTo: MERCHANT,
      amount: 5n * JPYC,
      fee: 2n * JPYC,
      asset: TOKEN,
      chainId: 80002n,
      timestamp: 1_000_000_001n,
      nonce,
    },
  });
  return {
    success: true,
    transaction: RECEIPT_TX,
    network: 'eip155:80002',
    payer: account.address,
    receipt: {
      txHash: RECEIPT_TX,
      payer: account.address,
      payTo: MERCHANT,
      amount: (5n * JPYC).toString(),
      fee: (2n * JPYC).toString(),
      asset: TOKEN,
      chainId: 80002,
      timestamp: 1_000_000_001,
      nonce,
      signature,
    },
  };
}

// 402 → 署名 → X-PAYMENT の応答を `paidBody` で返す。支払いの nonce と領収書を記録する。
function paidFlow(
  sdk: SdkModule,
  paidBody: (nonce: Hex) => Promise<{ body: BodyInit | null; receipt: unknown }>,
) {
  const seen: { nonce: Hex | null; receipt: unknown; paidFetches: number } = {
    nonce: null,
    receipt: null,
    paidFetches: 0,
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === SUPPORTED_URL) {
      return jsonResponse({ receiptSigner: receiptAccount.address }, 200);
    }
    if (!hasPayment(init)) return jsonResponse({ accepts: [accept()] }, 402);
    const nonce = paymentNonce(sdk, init);
    seen.paidFetches += 1;
    seen.nonce = nonce;
    const { body, receipt } = await paidBody(nonce);
    seen.receipt = receipt;
    const headers: Record<string, string> = {};
    if (receipt !== null) {
      headers['x-payment-response'] = Buffer.from(JSON.stringify(receipt)).toString('base64');
    }
    return new Response(body, { status: 200, headers });
  });
  return { fetchImpl, seen };
}

describe('openpay-x402-sdk bounded response reads (C-2)', () => {
  it('exports the two caps: 256 KiB before signing, 16 MiB for the paid body', async () => {
    const sdk = await loadSdk();
    expect(sdk.MAX_CHALLENGE_BODY_BYTES).toBe(256 * KiB);
    expect(sdk.DEFAULT_MAX_PAID_BODY_BYTES).toBe(16 * MiB);
  });

  it('quote cancels an oversized 402 without Content-Length and throws before reading it all', async () => {
    const sdk = await loadSdk();
    const total = 4 * MiB;
    const chunk = 16 * KiB;
    const { stream, stats } = countingStream(total, chunk);
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 402 }));
    const client = sdk.createOpenPayClient({ catalogTrust: false, fetchImpl, lookup });

    await expect(client.quote(RESOURCE)).rejects.toThrow('payment_target_response_too_large');

    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(total);
    // 上限 + 先読みの数 chunk までしか出させない。
    expect(stats.pulled).toBeLessThanOrEqual(sdk.MAX_CHALLENGE_BODY_BYTES + 2 * chunk);
  });

  it('pay refuses an oversized challenge before signing or sending X-PAYMENT', async () => {
    const sdk = await loadSdk();
    const total = 4 * MiB;
    const { stream, stats } = countingStream(total, 16 * KiB);
    let paidFetches = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (hasPayment(init)) paidFetches += 1;
      return new Response(stream, { status: 402 });
    });
    const signTypedData = vi.fn((typedData: Parameters<typeof account.signTypedData>[0]) =>
      account.signTypedData(typedData),
    );
    const client = sdk.createOpenPayClient({
      signer: { address: account.address, signTypedData },
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
    });

    await expect(client.pay(RESOURCE, { maxTotalJpyc: '7' })).rejects.toThrow(
      'payment_target_response_too_large',
    );

    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(total);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(paidFetches).toBe(0);
    expect(client.session.spentAtomic).toBe(0n);
  });

  it('the cancel reaches the Node stream behind the default transport body', async () => {
    const sdk = await loadSdk();
    const nodeResponseBody = await loadNodeResponseBody();
    const total = 4 * MiB;
    let pushed = 0;
    // network.mjs の既定 transport と同じ形: new Response(nodeResponseBody(IncomingMessage))。
    // Node 22 ではこの形を Readable.toWeb にすると、cancel の後に残っていた chunk の enqueue が
    // 「Controller is already closed」の未処理例外になった (CI の Node 22 で再現)。
    const node = new Readable({
      read() {
        if (pushed >= total) {
          this.push(null);
          return;
        }
        pushed += 16 * KiB;
        this.push(Buffer.alloc(16 * KiB, 0x78));
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(nodeResponseBody(node), {
          status: 402,
        }),
    );
    const client = sdk.createOpenPayClient({ catalogTrust: false, fetchImpl, lookup });

    await expect(client.quote(RESOURCE)).rejects.toThrow('payment_target_response_too_large');

    expect(node.destroyed).toBe(true);
    expect(node.readableEnded).toBe(false);
    expect(pushed).toBeLessThan(total);
  });

  it('the default transport body drops a chunk, end, error or close that arrives after cancel', async () => {
    const nodeResponseBody = await loadNodeResponseBody();
    const response = fakeResponse();
    const reader = nodeResponseBody(response).getReader();

    response.emit('data', Buffer.from('ab'));
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([0x61, 0x62]) });
    await reader.cancel();
    expect(response.destroy).toHaveBeenCalledTimes(1);

    // 閉じた controller への enqueue は TypeError。listener の外へ抜けると buyer の process の
    // uncaughtException になる。error は listener が無いと EventEmitter が throw する。
    expect(() => response.emit('data', Buffer.from('late'))).not.toThrow();
    expect(() => response.emit('end')).not.toThrow();
    expect(() => response.emit('error', new Error('socket reset'))).not.toThrow();
    expect(() => response.emit('close')).not.toThrow();
  });

  it('the default transport body ends on end, fails on error or on close before end', async () => {
    const nodeResponseBody = await loadNodeResponseBody();

    const ended = fakeResponse();
    const endedReader = nodeResponseBody(ended).getReader();
    ended.emit('data', Buffer.from('x'));
    ended.emit('end');
    ended.emit('close');
    expect(await endedReader.read()).toEqual({ done: false, value: new Uint8Array([0x78]) });
    expect(await endedReader.read()).toEqual({ done: true, value: undefined });

    const errored = fakeResponse();
    const erroredReader = nodeResponseBody(errored).getReader();
    errored.emit('error', new Error('socket reset'));
    errored.emit('close');
    await expect(erroredReader.read()).rejects.toThrow('socket reset');

    const closed = fakeResponse();
    const closedReader = nodeResponseBody(closed).getReader();
    closed.emit('close');
    await expect(closedReader.read()).rejects.toThrow('closed before the body ended');
  });

  it('the default transport body pauses the response when its queue is full and resumes on pull', async () => {
    const nodeResponseBody = await loadNodeResponseBody();
    const response = fakeResponse();
    const reader = nodeResponseBody(response).getReader();

    response.emit('data', Buffer.from('a'));
    expect(response.pause).toHaveBeenCalledTimes(1);
    response.resume.mockClear();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([0x61]) });
    const next = reader.read();
    await Promise.resolve();
    expect(response.resume).toHaveBeenCalled();
    response.emit('data', Buffer.from('b'));
    expect(await next).toEqual({ done: false, value: new Uint8Array([0x62]) });
  });

  it('a paid body over the default cap returns a structured paid_body_too_large result with the txHash', async () => {
    const sdk = await loadSdk();
    const total = 24 * MiB;
    const chunk = 1 * MiB;
    const counter = { stats: { pulled: 0, cancelled: false } };
    const { fetchImpl, seen } = paidFlow(sdk, async (nonce) => {
      const { stream, stats } = countingStream(total, chunk);
      counter.stats = stats;
      return { body: stream, receipt: await signedPaymentResponse(nonce) };
    });
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(counter.stats.cancelled).toBe(true);
    expect(counter.stats.pulled).toBeLessThan(total);
    expect(counter.stats.pulled).toBeLessThanOrEqual(sdk.DEFAULT_MAX_PAID_BODY_BYTES + 2 * chunk);
    expect(result).toEqual({
      status: 200,
      body: null,
      receipt: seen.receipt,
      settlement: 'verified',
      error: 'paid_body_too_large',
      maxPaidBodyBytes: 16 * MiB,
      txHash: RECEIPT_TX,
      authorizationNonce: seen.nonce,
      note: expect.stringContaining('before paying again'),
    });
    // 2xx なので通常の応答と同じく支払い済みとして数える (もう一度払える余地を作らない)。
    expect(client.session.spentJpyc).toBe('7');
    expect(seen.paidFetches).toBe(1);
  });

  it('without a verified receipt the structured result keeps txHash null and the authorization nonce', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, seen } = paidFlow(sdk, async () => ({
      body: countingStream(64 * KiB, 4 * KiB).stream,
      receipt: null,
    }));
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: 32 * KiB,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toMatchObject({
      status: 200,
      body: null,
      receipt: null,
      settlement: 'receipt_unavailable',
      error: 'paid_body_too_large',
      maxPaidBodyBytes: 32 * KiB,
      txHash: null,
      authorizationNonce: seen.nonce,
    });
    expect(typeof seen.nonce).toBe('string');
  });

  it('maxPaidBodyBytes lowers the cap; a body exactly at the cap is returned unchanged', async () => {
    const sdk = await loadSdk();
    const cap = 1024;
    // 上限を 1 byte でも超えたら止める。stream は上限より長くしておき、閉じる前の cancel を確かめる。
    const over = countingStream(4 * cap, 256 + 1);
    const overFlow = paidFlow(sdk, async () => ({ body: over.stream, receipt: null }));
    const overClient = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl: overFlow.fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: cap,
    });
    const overResult = await overClient.pay(RESOURCE, { maxTotalJpyc: '7' });
    expect(overResult).toMatchObject({ error: 'paid_body_too_large', maxPaidBodyBytes: cap, body: null });
    expect(over.stats.cancelled).toBe(true);
    expect(over.stats.pulled).toBeLessThan(4 * cap);

    const exact = countingStream(cap, 256);
    const exactFlow = paidFlow(sdk, async () => ({ body: exact.stream, receipt: null }));
    const exactClient = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl: exactFlow.fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: cap,
    });
    const exactResult = await exactClient.pay(RESOURCE, { maxTotalJpyc: '7' });
    expect(exactResult).toEqual({
      status: 200,
      body: 'x'.repeat(cap),
      receipt: null,
      settlement: 'receipt_unavailable',
    });
    expect(exact.stats.cancelled).toBe(false);
  });

  it('maxPaidBodyBytes can raise the cap above the default', async () => {
    const sdk = await loadSdk();
    const size = 20 * MiB;
    const { stream, stats } = countingStream(size, 1 * MiB);
    const { fetchImpl } = paidFlow(sdk, async () => ({ body: stream, receipt: null }));
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: 32 * MiB,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result.error).toBeUndefined();
    expect((result.body as string).length).toBe(size);
    expect(stats.cancelled).toBe(false);
  });

  it('a normal streamed body is decoded like Response.text(), even with a character split across chunks', async () => {
    const sdk = await loadSdk();
    const json = JSON.stringify({ unlocked: true, note: '支払い済み — ok' });
    const bytes = new TextEncoder().encode(json);
    // マルチバイト文字の途中で chunk を切る。
    const split = bytes.indexOf(0xe6) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });
    const { fetchImpl } = paidFlow(sdk, async () => ({ body: stream, receipt: null }));
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toEqual({
      status: 200,
      body: { unlocked: true, note: '支払い済み — ok' },
      receipt: null,
      settlement: 'receipt_unavailable',
    });
  });

  it('a transport whose body is not a WHATWG stream is still held to the cap', async () => {
    const sdk = await loadSdk();
    // 例: text() だけを持つ custom fetchImpl の応答 (MCP の test double と同じ形)。
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 402,
      headers: new Headers(),
      text: async () => 'x'.repeat(256 * KiB + 1),
    }));
    const client = sdk.createOpenPayClient({ catalogTrust: false, fetchImpl, lookup });

    await expect(client.quote(RESOURCE)).rejects.toThrow('payment_target_response_too_large');
  });

  it('a paid-body cancel that rejects still returns the structured result with the receipt', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, seen } = paidFlow(sdk, async (nonce) => ({
      body: countingStream(64 * KiB, 4 * KiB, () => {
        throw new Error('cancel_failed');
      }).stream,
      receipt: await signedPaymentResponse(nonce),
    }));
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: 8 * KiB,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toMatchObject({
      status: 200,
      body: null,
      receipt: seen.receipt,
      settlement: 'verified',
      error: 'paid_body_too_large',
      txHash: RECEIPT_TX,
      authorizationNonce: seen.nonce,
    });
    expect(client.session.spentJpyc).toBe('7');
  });

  it('a paid-body cancel that never settles does not hang pay()', async () => {
    const sdk = await loadSdk();
    const { fetchImpl, seen } = paidFlow(sdk, async (nonce) => ({
      body: countingStream(64 * KiB, 4 * KiB, () => new Promise<void>(() => {})).stream,
      receipt: await signedPaymentResponse(nonce),
    }));
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: 8 * KiB,
    });

    const result = await withinMs(client.pay(RESOURCE, { maxTotalJpyc: '7' }), 2_000);

    expect(result).toMatchObject({
      error: 'paid_body_too_large',
      settlement: 'verified',
      txHash: RECEIPT_TX,
      authorizationNonce: seen.nonce,
    });
    expect(client.session.spentJpyc).toBe('7');
  });

  it('a non-402 body over 256 KiB keeps the previous expected_402_with_accepts result and is dropped unread', async () => {
    const sdk = await loadSdk();
    const total = 4 * MiB;
    // 例: 有料でない大きな HTML ページを x402_quote した場合。
    const quoted = countingStream(total, 16 * KiB);
    const quoteClient = sdk.createOpenPayClient({
      catalogTrust: false,
      fetchImpl: vi.fn(async () => new Response(quoted.stream, { status: 200 })),
      lookup,
    });
    await expect(quoteClient.quote(RESOURCE)).resolves.toEqual({
      url: RESOURCE,
      status: 200,
      ok: false,
      reasons: ['expected_402_with_accepts'],
    });
    expect(quoted.stats.cancelled).toBe(true);
    expect(quoted.stats.pulled).toBeLessThan(total);

    const paid = countingStream(total, 16 * KiB);
    const signTypedData = vi.fn((typedData: Parameters<typeof account.signTypedData>[0]) =>
      account.signTypedData(typedData),
    );
    const payClient = sdk.createOpenPayClient({
      signer: { address: account.address, signTypedData },
      catalogTrust: false,
      fetchImpl: vi.fn(async () => new Response(paid.stream, { status: 200 })),
      lookup,
    });
    await expect(payClient.pay(RESOURCE, { maxTotalJpyc: '7' })).resolves.toEqual({
      url: RESOURCE,
      status: 200,
      ok: false,
      reasons: ['expected_402_with_accepts'],
    });
    expect(paid.stats.cancelled).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('dropping a non-402 body does not wait on a cancel that rejects or never settles', async () => {
    const sdk = await loadSdk();
    for (const onCancel of [
      () => {
        throw new Error('cancel_failed');
      },
      () => new Promise<void>(() => {}),
    ]) {
      const { stream } = countingStream(4 * MiB, 16 * KiB, onCancel);
      const client = sdk.createOpenPayClient({
        catalogTrust: false,
        fetchImpl: vi.fn(async () => new Response(stream, { status: 200 })),
        lookup,
      });
      await expect(withinMs(client.quote(RESOURCE), 2_000)).resolves.toMatchObject({
        status: 200,
        reasons: ['expected_402_with_accepts'],
      });
    }
  });

  it('a paid-body cancel that returns a non-promise still returns the structured result with the receipt', async () => {
    const sdk = await loadSdk();
    const duck = duckBody(64 * KiB, 4 * KiB);
    const seen = { nonce: null as Hex | null, receipt: null as unknown };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === SUPPORTED_URL) {
        return jsonResponse({ receiptSigner: receiptAccount.address }, 200);
      }
      if (!hasPayment(init)) return jsonResponse({ accepts: [accept()] }, 402);
      const nonce = paymentNonce(sdk, init);
      seen.nonce = nonce;
      seen.receipt = await signedPaymentResponse(nonce);
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'x-payment-response': Buffer.from(JSON.stringify(seen.receipt)).toString('base64'),
        }),
        body: duck.body,
      };
    });
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      catalogTrust: false,
      fetchImpl,
      lookup,
      nowSec: () => 1_000_000_000,
      maxPaidBodyBytes: 8 * KiB,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toMatchObject({
      status: 200,
      body: null,
      receipt: seen.receipt,
      settlement: 'verified',
      error: 'paid_body_too_large',
      txHash: RECEIPT_TX,
      authorizationNonce: seen.nonce,
    });
    expect(duck.stats.cancelled).toBe(true);
    expect(duck.stats.pulled).toBeLessThan(64 * KiB);
    expect(client.session.spentJpyc).toBe('7');
  });

  it('quote on a non-402 whose body cancel returns a non-promise still returns expected_402_with_accepts', async () => {
    const sdk = await loadSdk();
    const duck = duckBody(4 * MiB, 16 * KiB);
    const client = sdk.createOpenPayClient({
      catalogTrust: false,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: duck.body,
      })),
      lookup,
    });

    await expect(client.quote(RESOURCE)).resolves.toEqual({
      url: RESOURCE,
      status: 200,
      ok: false,
      reasons: ['expected_402_with_accepts'],
    });
    expect(duck.stats.cancelled).toBe(true);
    expect(duck.stats.pulled).toBe(0);
  });

  it('rejects a maxPaidBodyBytes that is not a positive integer', async () => {
    const sdk = await loadSdk();
    for (const value of [0, -1, 1.5, Number.NaN, '1024']) {
      expect(() =>
        sdk.createOpenPayClient({ catalogTrust: false, maxPaidBodyBytes: value }),
      ).toThrow('maxPaidBodyBytes must be a positive integer');
    }
    expect(() =>
      sdk.createPaymentExecutor({
        config: sdk.parseClientOptions({ catalogTrust: false }),
        session: sdk.createPaymentSession(),
        maxPaidBodyBytes: 0,
      }),
    ).toThrow('maxPaidBodyBytes must be a positive integer');
  });
});
