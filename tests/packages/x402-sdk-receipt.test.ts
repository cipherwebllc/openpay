import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type ExpectedReceipt = {
  expectedSigner: Address;
  payer: Address;
  network: string;
  asset: Address;
  chainId: number;
  merchant: Address;
  merchantValue: bigint;
  feeValue: bigint;
  nonce: Hex;
};

type SdkModule = {
  createReceiptSignerResolver: (options: {
    discoveryUrl: string;
    fetchImpl?: typeof globalThis.fetch;
  }) => () => Promise<Address | null>;
  verifyBoundPaymentResponse: (
    paymentResponse: unknown,
    expected: ExpectedReceipt,
  ) => Promise<boolean>;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const SIGNER_KEY = `0x${'2'.repeat(64)}` as Hex;
const signer = privateKeyToAccount(SIGNER_KEY);
const TX_HASH = `0x${'a'.repeat(64)}` as Hex;
const NONCE = `0x${'b'.repeat(64)}` as Hex;
const OTHER_NONCE = `0x${'c'.repeat(64)}` as Hex;
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const OTHER_PAYER = getAddress('0x9999999999999999999999999999999999999999');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const ASSET = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const RECEIPT_TYPES = {
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
} as const;

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

async function signedPaymentResponse() {
  const message = {
    txHash: TX_HASH,
    payer: PAYER,
    payTo: MERCHANT,
    amount: 5n,
    fee: 2n,
    asset: ASSET,
    chainId: 80002n,
    timestamp: 1_000_000_001n,
    nonce: NONCE,
  };
  return {
    success: true,
    transaction: TX_HASH,
    network: 'eip155:80002',
    payer: PAYER,
    receipt: {
      txHash: TX_HASH,
      payer: PAYER,
      payTo: MERCHANT,
      amount: '5',
      fee: '2',
      asset: ASSET,
      chainId: 80002,
      timestamp: 1_000_000_001,
      nonce: NONCE,
      signature: await signer.signTypedData({
        domain: {
          name: 'OpenPay x402 Facilitator',
          version: '1',
        },
        types: RECEIPT_TYPES,
        primaryType: 'Receipt',
        message,
      }),
    },
  };
}

function expectedReceipt(): ExpectedReceipt {
  return {
    expectedSigner: signer.address,
    payer: PAYER,
    network: 'eip155:80002',
    asset: ASSET,
    chainId: 80002,
    merchant: MERCHANT,
    merchantValue: 5n,
    feeValue: 2n,
    nonce: NONCE,
  };
}

describe('openpay-x402-sdk bound facilitator receipts', () => {
  it('accepts a facilitator-signed receipt bound to the payment authorization', async () => {
    const sdk = await loadSdk();

    await expect(
      sdk.verifyBoundPaymentResponse(
        await signedPaymentResponse(),
        expectedReceipt(),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    ['nonce', { nonce: OTHER_NONCE }],
    ['payer', { payer: OTHER_PAYER }],
    ['amount', { merchantValue: 6n }],
  ] as const)(
    'rejects a valid signature when the expected %s does not match',
    async (_field, override) => {
      const sdk = await loadSdk();

      await expect(
        sdk.verifyBoundPaymentResponse(await signedPaymentResponse(), {
          ...expectedReceipt(),
          ...override,
        }),
      ).resolves.toBe(false);
    },
  );

  it('loads and caches the advertised receipt signer from the facilitator origin', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ receiptSigner: signer.address }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const resolveReceiptSigner = sdk.createReceiptSignerResolver({
      discoveryUrl: 'https://open-pay.jp/api/discovery',
      fetchImpl,
    });

    await expect(resolveReceiptSigner()).resolves.toBe(signer.address);
    await expect(resolveReceiptSigner()).resolves.toBe(signer.address);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open-pay.jp/api/facilitator/supported',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});
