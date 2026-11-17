// hooks/useGaslessUnsupportedWallet.ts: 読み込み中・読めないときは false (fail-open)。結果は address と chain の組に結び付け、
// 別のアドレス・チェーンの古い結果を返さない。読むのは enabled のときだけ。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Address } from 'viem';

const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/gaslessUnsupportedWallet', () => ({ readGaslessUnsupportedWallet: read }));

import { useGaslessUnsupportedWallet } from '@/hooks/useGaslessUnsupportedWallet';

const A = '0x00000000000000000000000000000000000000aA' as Address;
const B = '0x00000000000000000000000000000000000000bB' as Address;

type Pending = { resolve: (v: boolean) => void; reject: (e: unknown) => void };
let pending: Pending[];

beforeEach(() => {
  pending = [];
  read.mockReset().mockImplementation(
    () =>
      new Promise<boolean>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
});

type Props = { address: Address | undefined; chainId: number; enabled: boolean };
function setup(initial: Props) {
  return renderHook((p: Props) => useGaslessUnsupportedWallet(p.address, p.chainId, p.enabled, 'pay'), {
    initialProps: initial,
  });
}

async function settle(index: number, value: boolean) {
  await act(async () => {
    pending[index].resolve(value);
  });
}

describe('useGaslessUnsupportedWallet', () => {
  it('読み込み中は false。払えない口座と分かったら true (支払うチェーン・アドレス・経路で 1 回読む)', async () => {
    const { result } = setup({ address: A, chainId: 137, enabled: true });
    expect(result.current).toBe(false);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith(137, A, 'pay');
    await settle(0, true);
    expect(result.current).toBe(true);
  });

  it('払える口座 (false) は false', async () => {
    const { result } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle(0, false);
    expect(result.current).toBe(false);
  });

  it('読めない (reject) ときは false (fail-open・throw しない)', async () => {
    const { result } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].reject(new Error('rpc down'));
    });
    expect(result.current).toBe(false);
  });

  it('enabled でない (relay の経路でない)・アドレスが無いときは読まずに false', async () => {
    const off = setup({ address: A, chainId: 137, enabled: false });
    const none = setup({ address: undefined, chainId: 137, enabled: true });
    await act(async () => {});
    expect(off.result.current).toBe(false);
    expect(none.result.current).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('払えないと分かった後に enabled でなくなったら false (通常決済に切り替えた後に案内を残さない)', async () => {
    const { result, rerender } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle(0, true);
    expect(result.current).toBe(true);
    rerender({ address: A, chainId: 137, enabled: false });
    expect(result.current).toBe(false);
  });

  it('別のアドレスに切り替えたら、前のアドレスの結果を使わず読み直す (読み込み中は false)', async () => {
    const { result, rerender } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle(0, true);
    expect(result.current).toBe(true);

    rerender({ address: B, chainId: 137, enabled: true });
    expect(result.current).toBe(false);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(read).toHaveBeenLastCalledWith(137, B, 'pay');
    await settle(1, false);
    expect(result.current).toBe(false);
  });

  it('別のチェーンに切り替えたら、前のチェーンの結果を使わず読み直す', async () => {
    const { result, rerender } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle(0, true);
    rerender({ address: A, chainId: 8217, enabled: true });
    expect(result.current).toBe(false);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(read).toHaveBeenLastCalledWith(8217, A, 'pay');
    await settle(1, false);
    expect(result.current).toBe(false);
  });

  it('切り替えた後に、前のアドレスの読み取りが遅れて返っても、今のアドレスの結果にしない', async () => {
    const { result, rerender } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender({ address: B, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    await settle(0, true); // A の遅れた結果
    expect(result.current).toBe(false);
    await settle(1, false);
    expect(result.current).toBe(false);
  });

  it('アドレスの大文字・小文字の違いは同じ組として扱う', async () => {
    const { result, rerender } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle(0, true);
    rerender({ address: A.toLowerCase() as Address, chainId: 137, enabled: true });
    expect(result.current).toBe(true);
  });
});
