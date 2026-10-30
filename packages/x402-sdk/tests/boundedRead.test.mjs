import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOpenPayClient,
  DEFAULT_MAX_PAID_BODY_BYTES,
  MAX_CHALLENGE_BODY_BYTES,
  SUPPORTED_JPYC_ASSETS,
  SUPPORTED_JPYC_FORWARDERS,
} from '../src/index.mjs';

// The full suite lives in the OpenPay repository (tests/packages/x402-sdk-bounded-read.test.ts).
// This package-level test pins both caps so a publish cannot ship the unbounded read again.
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const NETWORK = 'eip155:80002';
const JPYC = 10n ** 18n;
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function accept() {
  const asset = SUPPORTED_JPYC_ASSETS[NETWORK];
  const forwarder = SUPPORTED_JPYC_FORWARDERS[NETWORK];
  return {
    scheme: 'exact',
    network: NETWORK,
    maxAmountRequired: (7n * JPYC).toString(),
    resource: RESOURCE,
    payTo: forwarder,
    maxTimeoutSeconds: 600,
    asset: asset.address,
    extra: {
      name: asset.name,
      version: asset.version,
      decimals: asset.decimals,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder,
        merchant: '0x2222222222222222222222222222222222222222',
        merchantValue: (5n * JPYC).toString(),
        feeReceiver: '0x3333333333333333333333333333333333333333',
        feeValue: (2n * JPYC).toString(),
        commitVersion: `0x${'c'.repeat(64)}`,
      },
    },
  };
}

// No Content-Length; counts the bytes handed out and records cancel.
function countingStream(totalBytes, chunkBytes) {
  const chunk = new Uint8Array(chunkBytes).fill(0x78);
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      if (stats.pulled >= totalBytes) {
        controller.close();
        return;
      }
      stats.pulled += chunkBytes;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

test('caps are 256 KiB before signing and 16 MiB for the paid body by default', () => {
  assert.equal(MAX_CHALLENGE_BODY_BYTES, 256 * 1024);
  assert.equal(DEFAULT_MAX_PAID_BODY_BYTES, 16 * 1024 * 1024);
});

test('quote cancels a 402 body past the cap and throws before reading it all', async () => {
  const total = 4 * 1024 * 1024;
  const { stream, stats } = countingStream(total, 16 * 1024);
  const client = createOpenPayClient({
    catalogTrust: false,
    lookup,
    fetchImpl: async () => new Response(stream, { status: 402 }),
  });
  await assert.rejects(client.quote(RESOURCE), /payment_target_response_too_large/);
  assert.equal(stats.cancelled, true);
  assert.ok(stats.pulled < total, `pulled ${stats.pulled}`);
});

test('a non-402 response of any size still returns expected_402_with_accepts unread', async () => {
  const total = 4 * 1024 * 1024;
  const { stream, stats } = countingStream(total, 16 * 1024);
  const client = createOpenPayClient({
    catalogTrust: false,
    lookup,
    fetchImpl: async () => new Response(stream, { status: 200 }),
  });
  const result = await client.quote(RESOURCE);
  assert.deepEqual(result.reasons, ['expected_402_with_accepts']);
  assert.equal(result.status, 200);
  assert.equal(stats.cancelled, true);
  assert.ok(stats.pulled < total, `pulled ${stats.pulled}`);
});

test('pay returns paid_body_too_large with the authorization nonce instead of throwing', async () => {
  const total = 64 * 1024;
  const { stream, stats } = countingStream(total, 1024);
  const client = createOpenPayClient({
    privateKey: `0x${'1'.repeat(64)}`,
    catalogTrust: false,
    lookup,
    nowSec: () => 1_000_000_000,
    maxPaidBodyBytes: 8 * 1024,
    fetchImpl: async (_url, init) =>
      new Headers(init?.headers).has('X-PAYMENT')
        ? new Response(stream, { status: 200 })
        : new Response(JSON.stringify({ accepts: [accept()] }), { status: 402 }),
  });
  const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });
  assert.equal(result.error, 'paid_body_too_large');
  assert.equal(result.body, null);
  assert.equal(result.maxPaidBodyBytes, 8 * 1024);
  assert.equal(result.settlement, 'receipt_unavailable');
  assert.equal(result.txHash, null);
  assert.match(result.authorizationNonce, /^0x[0-9a-f]{64}$/);
  assert.equal(stats.cancelled, true);
  assert.ok(stats.pulled < total, `pulled ${stats.pulled}`);
  assert.equal(client.session.spentJpyc, '7');
});
