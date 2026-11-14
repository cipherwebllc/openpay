// hooks/useCheckoutOrderNotify.ts の完了の通知 (effect A) の、画面を離れた後の扱い (r10-notify)。
// 画面に出るもの (案内・ボタン・送る時刻) は tests/components/CheckoutForm.orderNotify.characterization.test.tsx が部品ごと見る。
// ここは、部品の外からは見えない「unmount の後に state を書かない」を、hook が受け取る setter (setRedirectIn) で見る。
// mock は境界だけ: fetch と logger。hook の中の state・effect・lib は実物。
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: vi.fn() },
}));

import { useCheckoutOrderNotify } from '@/hooks/useCheckoutOrderNotify';
import { deploymentForSlug } from '@/lib/tokens';

type Args = Parameters<typeof useCheckoutOrderNotify>[0];

const ORIGIN = 'https://test.local'; // vitest.config.ts の jsdom の url
const OWN_NOTIFY = `${ORIGIN}/api/order/notify?h=alice`;
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const TX: Hex = `0x${'b'.repeat(64)}`;
const USEROP: Hex = `0x${'a'.repeat(64)}`;
const JPYC = 10n ** 18n;

// この画面で Pimlico の gasless で払い終えた形 (経路 A だけが走る)。
function paidArgs(overrides: Partial<Args> = {}): Args {
  return {
    params: {
      to: MERCHANT,
      token: 'jpyc',
      chain: 'polygon',
      gas: 'customer',
      items: [{ name: 'チケット', qty: 1, price: '3000' }],
      orderId: 'ord-7',
      webhook: OWN_NOTIFY,
    },
    completion: {
      key: USEROP,
      mode: 'gasless',
      blockNumber: 99n,
      hashFields: { txHash: TX, userOpHash: USEROP },
      redirectQuery: { tx_hash: TX, user_op_hash: USEROP },
    },
    relay: { orderDelivery: null, backgroundOrderDeliveries: [], restoredIntent: null, data: undefined },
    standard: {
      lastSubmittedParams: null,
      data: undefined,
      restoredFromStorage: false,
      merchantTxHash: undefined,
      merchantBlockNumber: undefined,
      feeTxHash: undefined,
    },
    address: CUSTOMER,
    chainSlug: 'polygon',
    deployment: deploymentForSlug('jpyc', 'polygon'),
    isStandard: false,
    useRelay: false,
    matchingDelivery: null,
    restoredCheckoutCompletion: false,
    restoredStandardOrderAttempt: null,
    submitSnapshotRef: {
      current: { totalWei: 3000n * JPYC, merchantReceives: 3000n * JPYC, feeAmount: 0n, customerPays: 3000n * JPYC },
    },
    boundOrderRef: { current: null },
    setRedirectIn: vi.fn(),
    setBindingStorageError: vi.fn(),
    ...overrides,
  };
}

const INVALID = () => Response.json({ error: 'invalid_body' }, { status: 400 }); // 何度送っても通らない失敗 (送り直さない)
const webhookWarnings = () => loggerWarn.mock.calls.filter(([event]) => String(event).startsWith('checkout.webhook'));

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('完了の通知 (経路 A) が届かなかったとき: 画面の状態を書くのは、画面がある間だけ', () => {
  it('画面がある間に届かないと決まる → 案内を立て、success_url への移動を止める (setRedirectIn(null))', async () => {
    fetchMock.mockImplementation(async () => INVALID());
    const args = paidArgs();
    const { result } = renderHook(() => useCheckoutOrderNotify(args));

    await waitFor(() => expect(result.current.orderNotifyFailed).toBe(true));
    expect(result.current.directNotifyRetryable).toBe(false);
    expect(args.setRedirectIn).toHaveBeenCalledExactlyOnceWith(null);
    await waitFor(() => expect(webhookWarnings()).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('応答の前に画面を離れた (unmount) → 後から届いた失敗では state を書かない。記録 (warn) は出す', async () => {
    let respond!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
    const args = paidArgs();
    const { unmount } = renderHook(() => useCheckoutOrderNotify(args));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    unmount();
    respond(INVALID());
    await waitFor(() => expect(webhookWarnings()).toHaveLength(1));
    expect(webhookWarnings()[0]).toEqual([
      'checkout.webhook.non_ok',
      expect.objectContaining({ status: 400, attempts: 1, serverError: 'invalid_body' }),
    ]);
    expect(args.setRedirectIn).not.toHaveBeenCalled();
  });

  it('「注文登録を再試行」の応答の前に画面を離れた → 後から届いても、success_url への移動を始め直さない', async () => {
    let respond!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(async () => INVALID())
      .mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
    const args = paidArgs();
    args.params = { ...args.params, successUrl: 'https://shop.example/thanks' };
    const { result, unmount } = renderHook(() => useCheckoutOrderNotify(args));
    await waitFor(() => expect(result.current.orderNotifyFailed).toBe(true));
    // 確定で 3 秒の秒読みを始め、届かないと決まって止めた。
    expect(vi.mocked(args.setRedirectIn).mock.calls).toEqual([[3], [null]]);

    act(() => result.current.retryDirectNotify());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    unmount();
    vi.mocked(args.setRedirectIn).mockClear();
    respond(Response.json({ ok: true }));
    // 応答の本文を読み終えて、結果の処理まで流す。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(args.setRedirectIn).not.toHaveBeenCalled();
    expect(webhookWarnings()).toHaveLength(1); // 最初の失敗の 1 件だけ
  });

  it('画面がある間に「注文登録を再試行」が届く → 案内を消し、success_url への 3 秒の移動を始め直す', async () => {
    fetchMock
      .mockImplementationOnce(async () => INVALID())
      .mockImplementation(async () => Response.json({ ok: true }));
    const args = paidArgs();
    args.params = { ...args.params, successUrl: 'https://shop.example/thanks' };
    const { result } = renderHook(() => useCheckoutOrderNotify(args));
    await waitFor(() => expect(result.current.orderNotifyFailed).toBe(true));

    act(() => result.current.retryDirectNotify());
    await waitFor(() => expect(result.current.orderNotifyFailed).toBe(false));
    expect(vi.mocked(args.setRedirectIn).mock.calls).toEqual([[3], [null], [3]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // StrictMode は mount → unmount → mount の順に effect を流す。送るのは 1 回だけで、結果は残った画面に反映する
  // (「画面がある」の印が、最初の unmount で倒れたままにならない)。
  it('StrictMode (mount → unmount → mount): 送るのは 1 回。届かなければ、残った画面に案内を立てる', async () => {
    fetchMock.mockImplementation(async () => INVALID());
    const args = paidArgs();
    const { result } = renderHook(() => useCheckoutOrderNotify(args), { reactStrictMode: true });

    await waitFor(() => expect(result.current.orderNotifyFailed).toBe(true));
    expect(args.setRedirectIn).toHaveBeenCalledExactlyOnceWith(null);
    await waitFor(() => expect(webhookWarnings()).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
