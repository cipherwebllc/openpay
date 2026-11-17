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
function setup(initial: Props, opts: { reactStrictMode?: boolean } = {}) {
  return renderHook((p: Props) => useGaslessUnsupportedWallet(p.address, p.chainId, p.enabled, 'pay'), {
    initialProps: initial,
    ...opts,
  });
}

async function settle(index: number, value: boolean) {
  await act(async () => {
    pending[index].resolve(value);
  });
}

async function fail(index: number) {
  await act(async () => {
    pending[index].reject(new Error('rpc down'));
  });
}

describe('useGaslessUnsupportedWallet', () => {
  it('読み込み中は false。払えない口座と分かったら true (支払うチェーン・アドレス・経路で 1 回読む)', async () => {
    const { result } = setup({ address: A, chainId: 137, enabled: true });
    expect(result.current).toBe(false);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith(137, A.toLowerCase(), 'pay');
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
    expect(read).toHaveBeenLastCalledWith(137, B.toLowerCase(), 'pay');
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
    expect(read).toHaveBeenLastCalledWith(8217, A.toLowerCase(), 'pay');
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
    // 大文字・小文字だけの違いで読み直さない (読み直すと、読み込み中に前の結果を返す順ができる)。
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  // 通常決済に切り替えても、フォームは同じ組 (アドレス・チェーン・enabled = relayCapable) を渡し続ける (components/PaymentForm.tsx)。
  // 同じ組の描き直しでは読み直さず、結果を保つ (切り替えた後の通常決済の文を、同じ口座の結果で選ぶ)。
  it('同じ組で何度描き直しても読み取りは 1 回で、結果を保つ', async () => {
    const { result, rerender } = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle(0, true);
    for (let i = 0; i < 3; i += 1) rerender({ address: A, chainId: 137, enabled: true });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  // 前の true が失効しないと、同じ組に戻ったときに読み込み中から true になり、新しい読み取りが false / 失敗でも true のまま
  // になる (約束「読み込み中・失敗は false・古い結果を使わない」に反する)。入力が変わるたびに前の結果を捨てる。
  describe('同じ組に戻っても、前の結果を使わない', () => {
    async function trueThenBack(props: Props, away: Props) {
      const view = setup(props);
      await waitFor(() => expect(pending).toHaveLength(1));
      await settle(0, true);
      expect(view.result.current).toBe(true);
      view.rerender(away);
      if (away.enabled && away.address) {
        await waitFor(() => expect(pending).toHaveLength(2));
        await settle(1, false);
      }
      expect(view.result.current).toBe(false);
      view.rerender(props);
      // 戻った直後 (読み込み中) は false。
      expect(view.result.current).toBe(false);
      const index = away.enabled && away.address ? 2 : 1;
      await waitFor(() => expect(pending).toHaveLength(index + 1));
      expect(view.result.current).toBe(false);
      return { view, index };
    }

    const HOME: Props = { address: A, chainId: 137, enabled: true };
    const cases: [string, Props][] = [
      ['アドレス (A → B → A)', { address: B, chainId: 137, enabled: true }],
      ['チェーン (137 → 8217 → 137)', { address: A, chainId: 8217, enabled: true }],
      ['enabled (ON → OFF → ON)', { address: A, chainId: 137, enabled: false }],
      ['接続 (A → 切断 → A)', { address: undefined, chainId: 137, enabled: true }],
    ];

    it.each(cases)('%s: 戻った後の読み取りが false なら false', async (_, away) => {
      const { view, index } = await trueThenBack(HOME, away);
      await settle(index, false);
      expect(view.result.current).toBe(false);
    });

    it.each(cases)('%s: 戻った後の読み取りが失敗なら false', async (_, away) => {
      const { view, index } = await trueThenBack(HOME, away);
      await fail(index);
      expect(view.result.current).toBe(false);
    });

    it.each(cases)('%s: 戻った後の読み取りが読み込み中のままなら false・true と分かれば true', async (_, away) => {
      const { view, index } = await trueThenBack(HOME, away);
      expect(view.result.current).toBe(false);
      await settle(index, true);
      expect(view.result.current).toBe(true);
    });

    it('前の true の後に、同じ組の読み直しが失敗しても true のまま残さない (OFF → ON)', async () => {
      const view = setup(HOME);
      await waitFor(() => expect(pending).toHaveLength(1));
      await settle(0, true);
      view.rerender({ ...HOME, enabled: false });
      view.rerender(HOME);
      await waitFor(() => expect(pending).toHaveLength(2));
      await fail(1);
      expect(view.result.current).toBe(false);
    });

    it('A の読み取りが返る前に B → A と戻ったとき、前の A の遅れた結果を使わない', async () => {
      const view = setup(HOME);
      await waitFor(() => expect(pending).toHaveLength(1));
      view.rerender({ ...HOME, address: B });
      await waitFor(() => expect(pending).toHaveLength(2));
      view.rerender(HOME);
      await waitFor(() => expect(pending).toHaveLength(3));
      await settle(0, true); // 1 回目の A (もう今の読み取りではない)
      expect(view.result.current).toBe(false);
      await settle(2, false); // 今の A
      expect(view.result.current).toBe(false);
    });

    it('今の A が true になった後に、前の A の読み取りが遅れて失敗しても、今の結果を消さない', async () => {
      const view = setup(HOME);
      await waitFor(() => expect(pending).toHaveLength(1));
      view.rerender({ ...HOME, address: B });
      await waitFor(() => expect(pending).toHaveLength(2));
      view.rerender(HOME);
      await waitFor(() => expect(pending).toHaveLength(3));
      await settle(2, true); // 今の A
      expect(view.result.current).toBe(true);
      await fail(0); // 1 回目の A (もう今の読み取りではない)
      expect(view.result.current).toBe(true);
    });
  });

  it('StrictMode の二重の effect: 1 回目の (片付けた) 読み取りの結果は使わず、今の読み取りの結果だけを使う', async () => {
    const view = setup({ address: A, chainId: 137, enabled: true }, { reactStrictMode: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    await settle(0, true); // 片付けた effect の読み取り
    expect(view.result.current).toBe(false);
    await settle(1, true);
    expect(view.result.current).toBe(true);
  });

  it.each([
    ['resolve (true)', (i: number) => pending[i].resolve(true)],
    ['reject', (i: number) => pending[i].reject(new Error('rpc down'))],
  ])('unmount の後に %s しても throw しない・React の警告を出さない', async (_, finish) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = setup({ address: A, chainId: 137, enabled: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    view.unmount();
    await act(async () => {
      finish(0);
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
