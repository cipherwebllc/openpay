import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// useReadContract (wagmi) を境界モックして、balanceOf の戻り (受取先残高) を
// テストから制御する。hook の責務 = baseline 記録 + delta 判定 + 新 QR での
// baseline リセット なので、RPC 自体は呼ばず data だけ差し替える。
vi.mock('wagmi', () => ({ useReadContract: vi.fn() }));

import { useIncomingPaymentWatch } from '@/hooks/useIncomingPaymentWatch';
import { useReadContract } from 'wagmi';

const RECEIVER = '0x1111111111111111111111111111111111111111' as const;
const RECEIVER_2 = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x3333333333333333333333333333333333333333' as const;
const CHAIN_ID = 137;
// JPYC は 18 decimals。1000 JPYC = 1000e18。
const ONE_K = 1000n * 10n ** 18n;

// useReadContract の戻り (balanceOf data) を 1 変数で制御する。各テストで
// current を書き換えてから rerender すると、ポーリング更新を模せる。
let current: { data: bigint | undefined } = { data: undefined };

function setBalance(data: bigint | undefined): void {
  current = { data };
}

beforeEach(() => {
  vi.clearAllMocks();
  current = { data: undefined };
  // mock は呼ばれるたび最新の current を返す (rerender で値が反映される)。
  vi.mocked(useReadContract).mockImplementation(
    () => current as ReturnType<typeof useReadContract>,
  );
});

type Params = Parameters<typeof useIncomingPaymentWatch>[0];

const BASE: Params = {
  receiver: RECEIVER,
  tokenAddress: TOKEN,
  chainId: CHAIN_ID,
  expectedAmountWei: ONE_K,
  enabled: true,
};

describe('useIncomingPaymentWatch', () => {
  it('enabled=false なら idle (受取先/金額があっても監視しない)', () => {
    setBalance(5000n * 10n ** 18n);
    const { result } = renderHook(() =>
      useIncomingPaymentWatch({ ...BASE, enabled: false }),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.receivedWei).toBe(0n);
  });

  it('receiver=null / expectedAmountWei=0 でも idle (watch 不成立)', () => {
    setBalance(5000n * 10n ** 18n);
    const { result: r1 } = renderHook(() =>
      useIncomingPaymentWatch({ ...BASE, receiver: null }),
    );
    expect(r1.current.status).toBe('idle');

    const { result: r2 } = renderHook(() =>
      useIncomingPaymentWatch({ ...BASE, expectedAmountWei: 0n }),
    );
    expect(r2.current.status).toBe('idle');
  });

  it('enabled だが残高未取得 (data undefined) なら watching', () => {
    setBalance(undefined);
    const { result } = renderHook(() => useIncomingPaymentWatch(BASE));
    expect(result.current.status).toBe('watching');
    expect(result.current.receivedWei).toBe(0n);
  });

  it('baseline 確定後・delta 無し (残高据え置き) なら watching', () => {
    setBalance(5000n * 10n ** 18n); // baseline
    const { result, rerender } = renderHook(() =>
      useIncomingPaymentWatch(BASE),
    );
    expect(result.current.status).toBe('watching');
    // 同じ残高で再ポーリング → まだ着金なし
    rerender();
    expect(result.current.status).toBe('watching');
    expect(result.current.receivedWei).toBe(0n);
  });

  it('残高が期待額の 98% 以上増えたら received + receivedWei = 増分', () => {
    const baseBal = 5000n * 10n ** 18n;
    setBalance(baseBal); // baseline = 5000
    const { result, rerender } = renderHook(() =>
      useIncomingPaymentWatch(BASE),
    );
    expect(result.current.status).toBe('watching');

    // 手数料控除後の着金を模す: 1000 JPYC のうち 99% = 990 着金 (threshold=980 を超える)。
    const received = (ONE_K * 99n) / 100n;
    setBalance(baseBal + received);
    rerender();
    expect(result.current.status).toBe('received');
    expect(result.current.receivedWei).toBe(received);
  });

  it('増分が 98% 閾値ちょうど未満なら watching のまま (誤検知防止)', () => {
    const baseBal = 5000n * 10n ** 18n;
    setBalance(baseBal);
    const { result, rerender } = renderHook(() =>
      useIncomingPaymentWatch(BASE),
    );
    // threshold = 980。979 ぶんだけ着金 → まだ received にしない。
    const justUnder = (ONE_K * 979n) / 1000n;
    setBalance(baseBal + justUnder);
    rerender();
    expect(result.current.status).toBe('watching');
    // 増分は表示用に出す (clamp ≥ 0)。
    expect(result.current.receivedWei).toBe(justUnder);
  });

  it('受取先が変わると baseline をリセット (新 QR = 新規 watch)', () => {
    const baseBal = 5000n * 10n ** 18n;
    setBalance(baseBal);
    const { result, rerender } = renderHook(
      (props: Params) => useIncomingPaymentWatch(props),
      { initialProps: BASE },
    );
    // 受取先 A で着金検知。
    setBalance(baseBal + ONE_K);
    rerender(BASE);
    expect(result.current.status).toBe('received');

    // 受取先 B に切替。新受取先の残高は (たまたま) 既に高いが、これは「新 QR の
    // baseline」として再取得されるので、切替直後に received へ飛ばない。
    const otherBal = 9000n * 10n ** 18n;
    setBalance(otherBal);
    rerender({ ...BASE, receiver: RECEIVER_2 });
    expect(result.current.status).toBe('watching');
    expect(result.current.receivedWei).toBe(0n);

    // 受取先 B にさらに期待額が着金してはじめて received。
    setBalance(otherBal + ONE_K);
    rerender({ ...BASE, receiver: RECEIVER_2 });
    expect(result.current.status).toBe('received');
    expect(result.current.receivedWei).toBe(ONE_K);
  });

  it('期待額 (金額) が変わると baseline をリセット (QR の金額差し替え)', () => {
    const baseBal = 5000n * 10n ** 18n;
    setBalance(baseBal);
    const { result, rerender } = renderHook(
      (props: Params) => useIncomingPaymentWatch(props),
      { initialProps: BASE },
    );
    // 1000 JPYC ぶん着金 → received。
    setBalance(baseBal + ONE_K);
    rerender(BASE);
    expect(result.current.status).toBe('received');

    // 金額を 2000 JPYC に差し替え。残高は据え置きでも baseline を取り直すので
    // delta=0 → watching に戻る (古い着金を新 QR に流用しない)。
    const twoK = 2000n * 10n ** 18n;
    rerender({ ...BASE, expectedAmountWei: twoK });
    expect(result.current.status).toBe('watching');
    expect(result.current.receivedWei).toBe(0n);
  });

  it('enabled が false→true で再立ち上がりすると baseline を取り直す', () => {
    const baseBal = 5000n * 10n ** 18n;
    setBalance(baseBal + ONE_K); // 既に高残高
    const { result, rerender } = renderHook(
      (props: Params) => useIncomingPaymentWatch(props),
      { initialProps: { ...BASE, enabled: false } },
    );
    expect(result.current.status).toBe('idle');

    // モーダルを開く (enabled=true)。開いた瞬間の残高が baseline。直前の高残高で
    // いきなり received にはならない。
    rerender({ ...BASE, enabled: true });
    expect(result.current.status).toBe('watching');

    // ここから期待額ぶん増えてはじめて received。
    setBalance(baseBal + ONE_K + ONE_K);
    rerender({ ...BASE, enabled: true });
    expect(result.current.status).toBe('received');
    expect(result.current.receivedWei).toBe(ONE_K);
  });
});
