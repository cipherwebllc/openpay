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
// signTx が返す pre-signed canonical txHash。submitSelfHost は send 結果ではなく常にこれを返す (P2)。
const SIGNED_HASH = `0x${'ab'.repeat(32)}` as Hex;
const RAW = '0x02abcd' as Hex;
const FEE = 30n * 10n ** 9n; // 30 gwei (署名された maxFeePerGas)
// gas = estimateGas(100k) + 20% = 120k。cost = 120k × 30gwei = 3.6e15 wei。
const EXPECTED_COST = 120_000n * FEE;

function makeIo(over: Partial<SelfHostIo> = {}): SelfHostIo {
  return {
    getBalance: vi.fn(async () => 10n ** 18n), // 1 native, 十分
    estimateGas: vi.fn(async () => 100_000n),
    getPendingNonce: vi.fn(async () => 7),
    signTx: vi.fn(async () => ({ raw: RAW, hash: SIGNED_HASH, maxFeePerGas: FEE })),
    sendRawTransaction: vi.fn(async () => SIGNED_HASH),
    waitForReceipt: vi.fn(async () => ({
      status: 'success' as const,
      transactionHash: SIGNED_HASH,
    })),
    ...over,
  };
}

describe('submitSelfHost', () => {
  it('正常: pending nonce で pre-sign → sendRaw → {taskId: canonical hash}', async () => {
    const io = makeIo();
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SIGNED_HASH); // 常に canonical pre-signed hash (送信結果は信用しない)
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
    expect(io.signTx).toHaveBeenCalledOnce();
    const [target, data, gas, nonce] = (
      io.signTx as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(target).toBe(TARGET);
    expect(data).toBe(DATA);
    expect(gas).toBe(100_000n + 100_000n / 5n); // +20% バッファ
    expect(nonce).toBe(7);
  });

  it('gas 見積が cap 超過 → RELAYER_GAS_CAP で頭打ち (signTx に渡る gas)', async () => {
    const io = makeIo({ estimateGas: vi.fn(async () => 10_000_000n) });
    await submitSelfHost(io, TARGET, DATA);
    const [, , gas] = (io.signTx as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(gas).toBe(RELAYER_GAS_CAP);
  });

  it('残高不足 → relayer_unfunded で throw (sign/send せず → relay_error で fallback 可)', async () => {
    const io = makeIo({
      getBalance: vi.fn(async () => MIN_RELAYER_BALANCE_WEI - 1n),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow(
      'relayer_unfunded',
    );
    expect(io.signTx).not.toHaveBeenCalled();
    expect(io.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('gas 見積が revert で throw → 伝播 (sign/send せず)', async () => {
    const io = makeIo({
      estimateGas: vi.fn(async () => {
        throw new Error('execution reverted');
      }),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow();
    expect(io.signTx).not.toHaveBeenCalled();
  });

  it('残高 < watermark (>= MIN) → onLowBalance を実残高で発火し submit は継続', async () => {
    const io = makeIo({ getBalance: vi.fn(async () => 5n * 10n ** 16n) }); // 0.05 native
    const onLowBalance = vi.fn();
    const res = await submitSelfHost(io, TARGET, DATA, {
      lowBalanceWei: 10n ** 17n, // 0.1 native
      onLowBalance,
    });
    expect(onLowBalance).toHaveBeenCalledWith(5n * 10n ** 16n); // 実残高を渡す
    expect(res.taskId).toMatch(/^0x[0-9a-fA-F]{64}$/); // 警告でも submit は止めない
  });

  it('残高 >= watermark → onLowBalance は発火しない', async () => {
    const io = makeIo({ getBalance: vi.fn(async () => 10n ** 18n) }); // 1 native
    const onLowBalance = vi.fn();
    await submitSelfHost(io, TARGET, DATA, {
      lowBalanceWei: 10n ** 17n,
      onLowBalance,
    });
    expect(onLowBalance).not.toHaveBeenCalled();
  });

  it('nonce 衝突 + authState 未使用 → fresh nonce で再試行 → 2 回目で成功', async () => {
    let calls = 0;
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('nonce too low');
        return SIGNED_HASH;
      }),
    });
    const isAuthorizationUsed = vi.fn(async () => false);
    const res = await submitSelfHost(io, TARGET, DATA, { isAuthorizationUsed });
    expect(res.taskId).toBe(SIGNED_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(io.getPendingNonce).toHaveBeenCalledTimes(2); // 衝突後 fresh nonce
    expect(io.signTx).toHaveBeenCalledTimes(2); // 再 sign
    expect(isAuthorizationUsed).toHaveBeenCalledTimes(1); // 衝突 1 回ぶん再確認
  });

  it('nonce 衝突 + authState 既使用 → 再試行せず pending (P0・二重送金防止)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('replacement transaction underpriced');
      }),
    });
    const isAuthorizationUsed = vi.fn(async () => true);
    const res = await submitSelfHost(io, TARGET, DATA, { isAuthorizationUsed });
    expect(res.taskId).toBe(SIGNED_HASH); // poll → pending (executed 済の可能性)
    expect(io.sendRawTransaction).toHaveBeenCalledOnce(); // 再試行しない
  });

  it('nonce 衝突が全リトライで尽きる → throw せず pending (P0・fallback で二重送金しない)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA, {
      isAuthorizationUsed: vi.fn(async () => false),
    });
    expect(res.taskId).toBe(SIGNED_HASH); // 保守的に pending
    expect(io.sendRawTransaction).toHaveBeenCalledTimes(RELAYER_NONCE_RETRIES + 1);
  });

  it('already known → canonical hash を poll (再試行せず)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('already known');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SIGNED_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('fatal + authState 未使用 → throw (mempool 未到達確実 → relay_error で fallback 可)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('insufficient funds for gas * price + value');
      }),
    });
    await expect(
      submitSelfHost(io, TARGET, DATA, {
        isAuthorizationUsed: vi.fn(async () => false),
      }),
    ).rejects.toThrow();
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('fatal + authState 既使用 → throw せず pending (P1・誤分類保険)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('insufficient funds for gas * price + value');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA, {
      isAuthorizationUsed: vi.fn(async () => true),
    });
    expect(res.taskId).toBe(SIGNED_HASH);
  });

  it('collision + isAuthorizationUsed が throw (RPC エラー) → pending (P0・relay_error にしない)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA, {
      isAuthorizationUsed: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    expect(res.taskId).toBe(SIGNED_HASH); // 判定不能 → 保守的に pending
    expect(io.sendRawTransaction).toHaveBeenCalledOnce(); // 再試行しない
  });

  it('fatal + isAuthorizationUsed が throw → pending (P0・fallback しない)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('insufficient funds');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA, {
      isAuthorizationUsed: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    expect(res.taskId).toBe(SIGNED_HASH); // 判定不能 → pending (relay_error にしない)
  });

  it('fatal + checker 無し → throw (relay_error)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('intrinsic gas too low');
      }),
    });
    await expect(submitSelfHost(io, TARGET, DATA)).rejects.toThrow();
  });

  it('uncertain (timeout) → canonical hash を poll (再試行/fallback せず → pending 化)', async () => {
    const io = makeIo({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('request timed out');
      }),
    });
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SIGNED_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledOnce(); // 二重送信回避
  });

  // B5: gas-cost ceiling は署名された maxFeePerGas で評価。
  it('B5: gas コストが ceiling 超過 → throw (sign 後 send 前 → relay_error で standard へ)', async () => {
    const io = makeIo();
    await expect(
      submitSelfHost(io, TARGET, DATA, { maxGasCostWei: EXPECTED_COST - 1n }),
    ).rejects.toThrow('gas_price_too_high');
    expect(io.signTx).toHaveBeenCalledOnce(); // 署名はする (signed fee で判定)
    expect(io.sendRawTransaction).not.toHaveBeenCalled(); // 送信しない
  });

  it('B5: gas コストが ceiling 以内 → 通常どおり broadcast', async () => {
    const io = makeIo();
    const res = await submitSelfHost(io, TARGET, DATA, {
      maxGasCostWei: EXPECTED_COST,
    });
    expect(res.taskId).toBe(SIGNED_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('B5: ceiling 未設定 (opts なし) → スキップして broadcast', async () => {
    const io = makeIo();
    const res = await submitSelfHost(io, TARGET, DATA);
    expect(res.taskId).toBe(SIGNED_HASH);
    expect(io.sendRawTransaction).toHaveBeenCalledOnce();
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
  it('receipt success (hash 一致) → {state:success, txHash}', async () => {
    const r = await pollSelfHost(makeIo(), SIGNED_HASH);
    expect(r).toEqual({ state: 'success', txHash: SIGNED_HASH });
  });

  it('receipt reverted (hash 一致) → {state:reverted, txHash}', async () => {
    const io = makeIo({
      waitForReceipt: vi.fn(async () => ({
        status: 'reverted' as const,
        transactionHash: SIGNED_HASH,
      })),
    });
    const r = await pollSelfHost(io, SIGNED_HASH);
    expect(r).toEqual({ state: 'reverted', txHash: SIGNED_HASH });
  });

  it('receipt の hash が不一致 (replacement) → pending + 置換 tx の hash (P0・別 tx の結果を信用しないが追跡は実 tx)', async () => {
    const replacementHash = `0x${'99'.repeat(32)}` as Hex;
    const io = makeIo({
      waitForReceipt: vi.fn(async () => ({
        status: 'success' as const,
        transactionHash: replacementHash, // 別 tx
      })),
    });
    const r = await pollSelfHost(io, SIGNED_HASH);
    // canonical hash は nonce 消費済で永遠に mine されない (explorer で Not Found) ため、
    // 追跡ポインタは実際に nonce を消費した置換 tx を指す。state は pending のまま
    // (置換 tx の status を自 authorization の結果として信用しない)。
    expect(r).toEqual({ state: 'pending', txHash: replacementHash });
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
