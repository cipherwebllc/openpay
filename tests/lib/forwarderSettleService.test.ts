import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { ForwarderRecoverDeps } from '@/lib/relay/forwarderRecover';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';

const hold = vi.hoisted(() => ({
  jpyc: '0x1111111111111111111111111111111111111111' as Address,
  feeReceiver: '0x3333333333333333333333333333333333333333' as Address,
  recoverViaForwarder: vi.fn<
    (
      input: unknown,
      deps: ForwarderRecoverDeps,
    ) => Promise<{ kind: 'success'; txHash: Hex }>
  >(async () => ({
    kind: 'success',
    txHash: `0x${'ab'.repeat(32)}` as Hex,
  })),
  checkSubfloorPayerRateLimit: vi.fn(async () => true),
  checkSubfloorBudget: vi.fn(),
  refundSubfloorBudget: vi.fn(),
  // hoisted に置いて「どちらのファクトリがどの prefix で呼ばれたか」を検証可能にする。
  makeIdempotency: vi.fn(() => ({
    claimIdempotency: vi.fn(),
    recordRelayHash: vi.fn(),
    releaseIdempotency: vi.fn(),
  })),
  makeRecoverIdempotency: vi.fn(() => ({
    claimIdempotency: vi.fn(),
    recordRelayHash: vi.fn(),
    releaseIdempotency: vi.fn(),
  })),
}));

const FORWARDER = '0x2222222222222222222222222222222222222222' as Address;
const FEE_RECEIVER = hold.feeReceiver;
const MERCHANT = '0x4444444444444444444444444444444444444444' as Address;
const PAYER = '0x5555555555555555555555555555555555555555' as Address;
const CHAIN = 80002;
const JPY = 10n ** 18n;
const RECOVER_FLOOR = 2n * JPY;

vi.mock('@/lib/env', () => ({
  env: { feeReceiver: hold.feeReceiver },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/relay/relayProvider', () => ({
  MAX_VALUE: 10n ** 30n,
  RELAY_LOW_BALANCE_ALERT_WEI: 0n,
  relayMaxGasCostWei: () => 1n,
  jpycAddressFor: () => hold.jpyc,
  getBalance: vi.fn(async () => 10n ** 30n),
  readAuthorizationUsed: vi.fn(async () => false),
  selfHostIoFor: () => null,
}));
vi.mock('@/lib/relay/selfHostRelayer', () => ({
  submitSelfHost: vi.fn(),
  pollSelfHost: vi.fn(),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkRateLimit: vi.fn(async () => true),
  checkSubfloorPayerRateLimit: hold.checkSubfloorPayerRateLimit,
  checkSubfloorBudget: hold.checkSubfloorBudget,
  refundSubfloorBudget: hold.refundSubfloorBudget,
  checkGasBudget: vi.fn(),
  refundGasBudget: vi.fn(),
  // A7: settleViaForwarder は route 別 claim に入口跨ぎの共有 claim を重ねた
  // makeRecoverIdempotency を使う (実合成は tests/lib/relayGuards.test.ts が検証)。
  makeIdempotency: hold.makeIdempotency,
  makeRecoverIdempotency: hold.makeRecoverIdempotency,
}));
vi.mock('@/lib/relay/forwarderRecover', () => ({
  recoverViaForwarder: hold.recoverViaForwarder,
}));
vi.mock('@/lib/relay/forwarderHealth', () => ({
  verifyForwarderHealth: vi.fn(async () => null),
}));

import { settleViaForwarder } from '@/lib/relay/forwarderSettleService';

function params(feeValue: bigint): ForwarderSettleParams {
  return {
    from: PAYER,
    merchant: MERCHANT,
    merchantValue: JPY,
    feeReceiver: FEE_RECEIVER,
    feeValue,
    validAfter: 0n,
    validBefore: 9_999_999_999n,
    intentSalt: `0x${'12'.repeat(32)}`,
  };
}

async function settle(
  expectedFeeValue: bigint,
  callerFeeFloorValue: bigint,
): Promise<ForwarderRecoverDeps> {
  await settleViaForwarder({
    chainId: CHAIN,
    params: params(expectedFeeValue),
    signature: `0x${'34'.repeat(65)}`,
    rateLimitKeys: [PAYER],
    expectedFeeValue,
    callerFeeFloorValue,
    forwarderFor: () => FORWARDER,
    idemPrefix: 'test:idem:',
  });
  return hold.recoverViaForwarder.mock.lastCall?.[1] as ForwarderRecoverDeps;
}

beforeEach(() => {
  hold.recoverViaForwarder.mockClear();
  hold.makeIdempotency.mockClear();
  hold.makeRecoverIdempotency.mockClear();
});

// A7: recover の冪等は route 別 claim 単独 (makeIdempotency) では入口跨ぎの二重 broadcast を
// 止められない。makeIdempotency へ戻したら落ちるように、どちらが呼ばれたかを固定する。
describe('settleViaForwarder の冪等ファクトリ', () => {
  it('route 別 prefix で makeRecoverIdempotency を使う (makeIdempotency 単独ではない)', async () => {
    await settle(JPY, JPY);

    expect(hold.makeRecoverIdempotency).toHaveBeenCalledWith('test:idem:');
    expect(hold.makeIdempotency).not.toHaveBeenCalled();
  });
});

describe('settleViaForwarder caller 別 sub-floor', () => {
  it.each([1n, 2n, 3n, 4n, 5n])(
    '価格 %s JPYC の x402 は x402 floor を満たすため recover floor 由来の専用 budget を消費しない',
    async (resourcePriceJpyc) => {
      // 既定 x402 1% / floor 1 JPYC では価格 1〜5 JPYC の fee はすべて 1 JPYC。
      expect(resourcePriceJpyc).toBeLessThanOrEqual(5n);
      expect(JPY).toBeLessThan(RECOVER_FLOOR);
      const deps = await settle(JPY, JPY);

      expect(deps.checkSubfloorPayerRateLimit).toBeUndefined();
      expect(deps.checkSubfloorBudget).toBeUndefined();
      expect(deps.refundSubfloorBudget).toBeUndefined();
    },
  );

  it('mobile/recover は relay gas floor 未満だけ専用ガードへ送る', async () => {
    const deps = await settle(JPY, RECOVER_FLOOR);

    expect(deps.checkSubfloorPayerRateLimit).toBe(
      hold.checkSubfloorPayerRateLimit,
    );
    expect(deps.checkSubfloorBudget).toBe(hold.checkSubfloorBudget);
    expect(deps.refundSubfloorBudget).toBe(hold.refundSubfloorBudget);
  });
});
