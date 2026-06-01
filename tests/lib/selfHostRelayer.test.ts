import { describe, it, expect, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  submitSelfHost,
  pollSelfHost,
  MIN_RELAYER_BALANCE_WEI,
  RELAYER_GAS_CAP,
  type SelfHostIo,
} from '@/lib/relay/selfHostRelayer';

const TARGET = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const DATA = '0xdeadbeef' as Hex;
const HASH = `0x${'ab'.repeat(32)}` as Hex;

function makeIo(over: Partial<SelfHostIo> = {}): SelfHostIo {
  return {
    getBalance: vi.fn(async () => 10n ** 18n), // 1 native, 十分
    estimateGas: vi.fn(async () => 100_000n),
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const })),
    ...over,
  };
}

describe('submitSelfHost', () => {
  it('正常: 残高十分 → gas 見積 +20% で send → {taskId: txHash}', async () => {
    const io = makeIo();
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(HASH);
    expect(io.sendTransaction).toHaveBeenCalledOnce();
    const [target, data, gas] = (
      io.sendTransaction as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(target).toBe(TARGET);
    expect(data).toBe(DATA);
    expect(gas).toBe(100_000n + 100_000n / 5n); // +20% バッファ
  });

  it('gas 見積が cap 超過 → RELAYER_GAS_CAP で頭打ち', async () => {
    const io = makeIo({ estimateGas: vi.fn(async () => 10_000_000n) });
    await submitSelfHost(io, TARGET, DATA);
    const [, , gas] = (
      io.sendTransaction as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(gas).toBe(RELAYER_GAS_CAP);
  });

  it('残高不足 → relayer_unfunded で throw (broadcast せず → コアが relay_error で fallback 可)', async () => {
    const io = makeIo({
      getBalance: vi.fn(async () => MIN_RELAYER_BALANCE_WEI - 1n),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow(
      'relayer_unfunded',
    );
    expect(io.sendTransaction).not.toHaveBeenCalled();
  });

  it('gas 見積が revert で throw → 伝播 (broadcast せず)', async () => {
    const io = makeIo({
      estimateGas: vi.fn(async () => {
        throw new Error('execution reverted');
      }),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow();
    expect(io.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('pollSelfHost', () => {
  it('receipt success → {state:success, txHash}', async () => {
    const r = await pollSelfHost(makeIo(), HASH);
    expect(r).toEqual({ state: 'success', txHash: HASH });
  });

  it('receipt reverted → {state:reverted, txHash}', async () => {
    const io = makeIo({
      waitForReceipt: vi.fn(async () => ({ status: 'reverted' as const })),
    });
    const r = await pollSelfHost(io, HASH);
    expect(r).toEqual({ state: 'reverted', txHash: HASH });
  });

  it('timeout/throw → {state:pending, txHash} (二重支払い回避: error にしない)', async () => {
    const io = makeIo({
      waitForReceipt: vi.fn(async () => {
        throw new Error('WaitForTransactionReceiptTimeoutError');
      }),
    });
    const r = await pollSelfHost(io, HASH);
    expect(r).toEqual({ state: 'pending', txHash: HASH });
  });
});
