// 「お店の端末で送る」の署名 (既存 forwarder 宛て・手数料欄 1 wei) が、OpenPay の中継 (/api/relay/jpyc) に
// 転送されても拒否され、OpenPay がガスを払わないことの固定 (plans/store-gas-wallet.md §7)。
// route は gasMode と feeKind から期待手数料を server で再計算し、forwarderRecover が feeValue と照合する。
// 受け渡しは 1 JPYC 以上なので、全 6 通り (gasMode 2 × feeKind 3) で期待手数料は 1 wei を超える。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress } from 'viem';

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
});

const JPYC_AMOY_ADDR = getAddress('0x0000000000000000000000000000000000000abc');
const FEE_RECEIVER_ADDR = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBytecode: () => Promise.resolve('0x60' as `0x${string}`),
      readContract: (args: { functionName: string }) => {
        if (args.functionName === 'token') return Promise.resolve(JPYC_AMOY_ADDR);
        if (args.functionName === 'feeReceiver') return Promise.resolve(FEE_RECEIVER_ADDR);
        return Promise.resolve(0n);
      },
      getBalance: () => Promise.resolve(0n),
      estimateGas: () => Promise.resolve(21000n),
      getTransactionCount: () => Promise.resolve(0),
    }),
  };
});

// recoverViaForwarder の境界: 実物と同じく feeValue と期待手数料を照合し、一致したときだけ「送信」する。
const broadcast = vi.hoisted(() => vi.fn());
const seenExpected: bigint[] = [];
vi.mock('@/lib/relay/forwarderRecover', () => ({
  recoverViaForwarder: async (
    input: { params: { feeValue: bigint } },
    deps: { expectedFeeValue: bigint },
  ) => {
    seenExpected.push(deps.expectedFeeValue);
    if (input.params.feeValue !== deps.expectedFeeValue) {
      return { kind: 'rejected', httpStatus: 400, reason: 'fee_value_mismatch' };
    }
    broadcast();
    return { kind: 'success', txHash: '0x' + 'ab'.repeat(32) };
  },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e',
      feeReceiverConfigured: true,
      enableJpycEip3009: true,
      enableMobileOrderFee: true,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/relay/jpyc/route';
import { STORE_DEVICE_FEE_WEI, STORE_DEVICE_MIN_AMOUNT_WEI } from '@/lib/storeDevicePayment';

function oneWeiIntent(gasMode: string, feeKind: string | undefined, merchantValue: bigint): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 80002,
      from: '0x0000000000000000000000000000000000000def',
      merchant: '0x0000000000000000000000000000000000000abc',
      merchantValue: merchantValue.toString(),
      feeValue: STORE_DEVICE_FEE_WEI.toString(),
      gasMode,
      ...(feeKind ? { feeKind } : {}),
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 150),
      intentSalt: '0x' + '22'.repeat(32),
      signature: '0x' + 'b'.repeat(130),
    }),
  });
}

describe('お店の端末で送る署名 (1 wei) は OpenPay の中継で拒否される', () => {
  beforeEach(() => {
    broadcast.mockClear();
    seenExpected.length = 0;
  });

  for (const merchantValue of [STORE_DEVICE_MIN_AMOUNT_WEI, 1000n * 10n ** 18n]) {
    for (const gasMode of ['merchant', 'customer']) {
      for (const feeKind of [undefined, 'storefront', 'preorder']) {
        it(`amount=${merchantValue} gasMode=${gasMode} feeKind=${feeKind ?? 'none'} → 400 fee_value_mismatch・送信しない`, async () => {
          const res = await POST(oneWeiIntent(gasMode, feeKind, merchantValue));
          expect(res.status).toBe(400);
          expect(await res.json()).toMatchObject({ error: 'fee_value_mismatch' });
          expect(broadcast).not.toHaveBeenCalled();
          expect(seenExpected).toHaveLength(1);
          expect(seenExpected[0]).toBeGreaterThan(STORE_DEVICE_FEE_WEI);
        });
      }
    }
  }
});
