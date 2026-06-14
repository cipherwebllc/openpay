import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Hex } from 'viem';
import { polygon } from 'viem/chains';
import { useRelayGaslessSnapshot } from '@/hooks/useRelayGaslessSnapshot';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import type { GasMode } from '@/lib/fee';

// 実依存をそのまま使う (mock しない)。per-chain 未設定の代表 chain で既定 2 JPYC = 2e18。
const CHAIN = polygon.id;
const FEE = relayGasFeeValue(CHAIN);

type Relay = {
  data?: { txHash: Hex | null; success: boolean; pending?: boolean };
  error: Error | null;
  variables?: { value: bigint; gasMode?: GasMode };
};

function relayObj(over: Partial<Relay> = {}): Relay {
  return { data: undefined, error: null, variables: undefined, ...over };
}

describe('useRelayGaslessSnapshot', () => {
  it('FEE は固定の正値 (実 relayGasFeeValue)', () => {
    expect(FEE).toBeGreaterThan(0n);
  });

  it('mutate 前 (variables 未確定) → data/variables ともに undefined・error 素通し', () => {
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(relayObj(), false, CHAIN),
    );
    expect(result.current.data).toBeUndefined();
    expect(result.current.variables).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('非 recover: 着金=value・networkFeeEquivalent=0・saleAmount=value(gross)・feeAmount=0', () => {
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(
        relayObj({ variables: { value: 1000n, gasMode: 'customer' } }),
        false,
        CHAIN,
      ),
    );
    expect(result.current.variables).toEqual({
      merchantAmount: 1000n,
      feeAmount: 0n,
      saleAmount: 1000n,
      networkFeeEquivalent: 0n,
    });
  });

  it('recover + gas=customer: 着金は満額 (控除しない)・fee は networkFeeEquivalent に開示', () => {
    const value = 1000n * 10n ** 18n;
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(
        relayObj({ variables: { value, gasMode: 'customer' } }),
        true,
        CHAIN,
      ),
    );
    // 顧客負担は請求額満額が着金 (控除されない)。
    expect(result.current.variables?.merchantAmount).toBe(value);
    expect(result.current.variables?.networkFeeEquivalent).toBe(FEE);
    expect(result.current.variables?.saleAmount).toBe(value);
  });

  it('recover + gas=merchant: 着金 = value - FEE (店主がガス吸収)・saleAmount は gross 据置', () => {
    const value = 1000n * 10n ** 18n;
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(
        relayObj({ variables: { value, gasMode: 'merchant' } }),
        true,
        CHAIN,
      ),
    );
    expect(result.current.variables).toEqual({
      merchantAmount: value - FEE, // 控除後 (店主負担)
      feeAmount: 0n,
      saleAmount: value, // gross は不変 (GMV 基礎)
      networkFeeEquivalent: FEE,
    });
    // FEE=0 でも自明に通らないよう「実際に控除が起きた」ことを厳密に要求。
    expect(result.current.variables!.merchantAmount).toBeLessThan(value);
    expect(result.current.variables!.saleAmount).toBe(value); // gross > net
  });

  it('gasMode 未指定 (= customer 既定の relay) は recover でも控除しない', () => {
    const value = 500n * 10n ** 18n;
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(relayObj({ variables: { value } }), true, CHAIN),
    );
    expect(result.current.variables?.merchantAmount).toBe(value);
  });

  it('data success=true → userOpHash/blockNumber=null・success 透過・pending=undefined', () => {
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(
        relayObj({
          data: { txHash: '0xabc' as Hex, success: true },
          variables: { value: 1n, gasMode: 'customer' },
        }),
        false,
        CHAIN,
      ),
    );
    expect(result.current.data).toEqual({
      txHash: '0xabc',
      userOpHash: null,
      blockNumber: null,
      success: true,
      pending: undefined,
    });
  });

  it('data pending=true + txHash=null (authorization 既使用) → pending 透過・txHash null 許容', () => {
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(
        relayObj({ data: { txHash: null, success: false, pending: true } }),
        false,
        CHAIN,
      ),
    );
    expect(result.current.data).toEqual({
      txHash: null,
      userOpHash: null,
      blockNumber: null,
      success: false,
      pending: true,
    });
  });

  it('error 透過 (relay 失敗)', () => {
    const err = new Error('rate_limited');
    const { result } = renderHook(() =>
      useRelayGaslessSnapshot(relayObj({ error: err }), false, CHAIN),
    );
    expect(result.current.error).toBe(err);
  });

  it('memoize: 同一 relay 参照 + 同一 useRecover で再 render → 同一参照 (deps 安定)', () => {
    const relay = relayObj({ variables: { value: 5n, gasMode: 'customer' } });
    const { result, rerender } = renderHook(
      ({ r, u }: { r: Relay; u: boolean }) =>
        useRelayGaslessSnapshot(r, u, CHAIN),
      { initialProps: { r: relay, u: false } },
    );
    const first = result.current;
    rerender({ r: relay, u: false });
    expect(result.current).toBe(first);
  });

  it('useRecover が false→true へ変化 → 再計算され networkFeeEquivalent が 0→FEE', () => {
    const relay = relayObj({ variables: { value: 100n * 10n ** 18n, gasMode: 'merchant' } });
    const { result, rerender } = renderHook(
      ({ u }: { u: boolean }) => useRelayGaslessSnapshot(relay, u, CHAIN),
      { initialProps: { u: false } },
    );
    expect(result.current.variables?.networkFeeEquivalent).toBe(0n);
    rerender({ u: true });
    expect(result.current.variables?.networkFeeEquivalent).toBe(FEE);
    expect(result.current.variables?.merchantAmount).toBe(100n * 10n ** 18n - FEE);
  });
});
