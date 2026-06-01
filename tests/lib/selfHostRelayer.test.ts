import { describe, it, expect, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  submitSelfHost,
  pollSelfHost,
  classifySendError,
  MIN_RELAYER_BALANCE_WEI,
  RELAYER_GAS_CAP,
  RELAYER_NONCE_RETRIES,
  type SelfHostIo,
} from '@/lib/relay/selfHostRelayer';

const TARGET = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const DATA = '0xdeadbeef' as Hex;
// signTx が返す pre-signed txHash (broadcast 前に確定する hash)。
const SIGNED_HASH = `0x${'ab'.repeat(32)}` as Hex;
// sendRawTransaction が成功時に返す hash (通常は SIGNED_HASH と同一だが、テストでは
// 「pre-signed hash を返したか / 送信結果を返したか」を区別するため別値にする)。
const SENT_HASH = `0x${'cd'.repeat(32)}` as Hex;
const RAW = '0x02abcd' as Hex;

function makeIo(over: Partial<SelfHostIo> = {}): SelfHostIo {
  return {
    getBalance: vi.fn(async () => 10n ** 18n), // 1 native, 十分
    estimateGas: vi.fn(async () => 100_000n),
    getPendingNonce: vi.fn(async () => 7),
    signTx: vi.fn(async () => ({ raw: RAW, hash: SIGNED_HASH })),
    sendRawTransaction: vi.fn(async () => SENT_HASH),
    waitForReceipt: vi.fn(async () => ({ status: 'success' as const })),
    ...over,
  };
}

describe('submitSelfHost', () => {
  it('正常: 残高十分 → pending nonce で pre-sign → sendRaw → {taskId: 送信結果}', async () => {
    const io = makeIo();
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SENT_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
    expect(io.signTx).toHaveBeenCalledOnce();
    const [target, data, gas, nonce] = (
      io.signTx as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(target).toBe(TARGET);
    expect(data).toBe(DATA);
    expect(gas).toBe(100_000n + 100_000n / 5n); // +20% バッファ
    expect(nonce).toBe(7); // getPendingNonce の値
  });

  it('gas 見積が cap 超過 → RELAYER_GAS_CAP で頭打ち (signTx に渡る gas)', async () => {
    const io = makeIo({ estimateGas: vi.fn(async () => 10_000_000n) });
    await submitSelfHost(io, TARGET, DATA);
    const [, , gas] = (io.signTx as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(gas).toBe(RELAYER_GAS_CAP);
  });

  it('残高不足 → relayer_unfunded で throw (broadcast せず → コアが relay_error で fallback 可)', async () => {
    const io = makeIo({
      getBalance: vi.fn(async () => MIN_RELAYER_BALANCE_WEI - 1n),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow(
      'relayer_unfunded',
    );
    expect(io.signTx).not.toHaveBeenCalled();
    expect(io.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('gas 見積が revert で throw → 伝播 (broadcast せず)', async () => {
    const io = makeIo({
      estimateGas: vi.fn(async () => {
        throw new Error('execution reverted');
      }),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow();
    expect(io.signTx).not.toHaveBeenCalled();
    expect(io.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('nonce 衝突 → fresh nonce で再試行 → 2 回目で成功', async () => {
    let calls = 0;
    const io = makeIo({
      getPendingNonce: vi.fn(async () => 7),
      sendRawTransaction: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('nonce too low');
        return SENT_HASH;
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SENT_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(io.getPendingNonce).toHaveBeenCalledTimes(2); // 衝突後に fresh nonce 再取得
    expect(io.signTx).toHaveBeenCalledTimes(2); // 再 sign
  });

  it('nonce 衝突が全リトライで尽きる → throw (自 tx は未 broadcast = fallback 安全)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('replacement transaction underpriced');
      }),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow();
    // 初回 + RETRIES 回。
    expect(io.sendRawTransaction).toHaveBeenCalledTimes(RELAYER_NONCE_RETRIES + 1);
  });

  it('already known → pre-signed hash を返し poll (再試行せず・二重送金回避)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('already known');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SIGNED_HASH); // 送信結果ではなく pre-signed hash
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('fatal (insufficient funds) → throw (mempool 未到達確実 → relay_error で fallback 可)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('insufficient funds for gas * price + value');
      }),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow();
    expect(io.sendRawTransaction).toHaveBeenCalledOnce(); // 再試行しない
  });

  it('uncertain (timeout) → pre-signed hash を返し poll (再試行/fallback せず → pending 化)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('request timed out');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SIGNED_HASH); // poll → pending に倒れる hash
    expect(io.sendRawTransaction).toHaveBeenCalledOnce(); // 二重送信を避け再試行しない
  });
});

describe('classifySendError', () => {
  it('nonce 衝突系 → collision', () => {
    expect(classifySendError('Nonce too low')).toBe('collision');
    expect(classifySendError('nonce is too low: next 8')).toBe('collision');
    expect(classifySendError('replacement transaction underpriced')).toBe(
      'collision',
    );
    expect(classifySendError('replacement underpriced')).toBe('collision');
  });

  it('mempool 既存系 → known', () => {
    expect(classifySendError('already known')).toBe('known');
    expect(classifySendError('Transaction already imported')).toBe('known');
    expect(classifySendError('known transaction: 0xabc')).toBe('known');
  });

  it('node 明確拒否系 → fatal', () => {
    expect(classifySendError('insufficient funds for gas * price + value')).toBe(
      'fatal',
    );
    expect(classifySendError('intrinsic gas too low')).toBe('fatal');
    expect(classifySendError('exceeds block gas limit')).toBe('fatal');
  });

  it('timeout / 接続断 / 不明 → uncertain (安全側 default)', () => {
    expect(classifySendError('request timed out')).toBe('uncertain');
    expect(classifySendError('fetch failed')).toBe('uncertain');
    expect(classifySendError('socket hang up')).toBe('uncertain');
    expect(classifySendError('something nobody predicted')).toBe('uncertain');
  });
});

describe('pollSelfHost', () => {
  it('receipt success → {state:success, txHash}', async () => {
    const r = await pollSelfHost(makeIo(), SIGNED_HASH);
    expect(r).toEqual({ state: 'success', txHash: SIGNED_HASH });
  });

  it('receipt reverted → {state:reverted, txHash}', async () => {
    const io = makeIo({
      waitForReceipt: vi.fn(async () => ({ status: 'reverted' as const })),
    });
    const r = await pollSelfHost(io, SIGNED_HASH);
    expect(r).toEqual({ state: 'reverted', txHash: SIGNED_HASH });
  });

  it('timeout/throw → {state:pending, txHash} (二重支払い回避: error にしない)', async () => {
    const io = makeIo({
      waitForReceipt: vi.fn(async () => {
        throw new Error('WaitForTransactionReceiptTimeoutError');
      }),
    });
    const r = await pollSelfHost(io, SIGNED_HASH);
    expect(r).toEqual({ state: 'pending', txHash: SIGNED_HASH });
  });
});
