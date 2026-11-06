// hooks/useSwitchChainWithFeedback.ts: チェーンの切り替えの失敗を画面に知らせ (failed)、記録 (logger.warn) に残す。
// ウォレットでの取り消しは失敗にしない。同じ失敗は 1 回だけ記録する。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let switchState: { error: Error | null; variables?: { chainId: number } } = { error: null };
const switchChain = vi.fn();
vi.mock('wagmi', () => ({
  useAccount: () => ({ connector: { id: 'metaMaskSDK' } }),
  useSwitchChain: () => ({ switchChain, isPending: false, ...switchState }),
}));

import { useSwitchChainWithFeedback } from '@/hooks/useSwitchChainWithFeedback';

beforeEach(() => {
  warn.mockReset();
  switchState = { error: null };
});

describe('useSwitchChainWithFeedback', () => {
  it('失敗していなければ failed=false で記録しない', () => {
    const { result } = renderHook(() => useSwitchChainWithFeedback('checkout'));
    expect(result.current.failed).toBe(false);
    expect(result.current.failedChainId).toBeUndefined();
    expect(result.current.switchChain).toBe(switchChain);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ウォレットでの取り消し (user rejected) は失敗にしない', () => {
    switchState = { error: new Error('User rejected the request.'), variables: { chainId: 8217 } };
    const { result } = renderHook(() => useSwitchChainWithFeedback('checkout'));
    expect(result.current.failed).toBe(false);
    expect(result.current.failedChainId).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('それ以外の失敗は failed=true で、どの画面・目的のチェーン・接続の種類を 1 回だけ記録する', () => {
    const error = new Error('Unrecognized chain ID "0x2019".');
    switchState = { error, variables: { chainId: 8217 } };
    const { result, rerender } = renderHook(() => useSwitchChainWithFeedback('checkout'));
    expect(result.current.failed).toBe(true);
    // どのチェーンへの切り替えが失敗したか (補充先を選び直せる画面で、今の選択への失敗だけを知らせる)。
    expect(result.current.failedChainId).toBe(8217);
    rerender();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('wallet.switch_chain_failed', {
      surface: 'checkout',
      chainId: 8217,
      connector: 'metaMaskSDK',
      error,
    });
  });
});
