// hooks/useCheckoutOrderNotify.ts の完了の通知 (effect A) の、画面を離れた後の扱い (r10-notify)。
// 画面に出るもの (案内・ボタン・送る時刻) は tests/components/CheckoutForm.orderNotify.characterization.test.tsx が部品ごと見る。
// ここは、部品の外からは見えない「unmount の後に state を書かない」を、hook が受け取る setter (setRedirectIn) で見る。
// 下の 2 つ目の describe は、部品 (CheckoutForm) からは作れない順 (完了の後に部分の通知が始まる) を、hook を直接描いて見る。
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
    // 記録: 最初の失敗 (今までと同じ event) + 届かずに止まった 1 件 (案内を出した)。
    await waitFor(() => expect(webhookWarnings()).toHaveLength(2));
    expect(webhookWarnings().map(([event]) => event)).toEqual(['checkout.webhook.non_ok', 'checkout.webhook.undelivered']);
    expect(webhookWarnings()[1][1]).toMatchObject({ status: 400, attempts: 1, serverError: 'invalid_body', noticeShown: true });
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
    await waitFor(() => expect(webhookWarnings()).toHaveLength(2));
    expect(webhookWarnings()[0]).toEqual(['checkout.webhook.non_ok', expect.objectContaining({ status: 400 })]);
    // 画面が無いので、案内は出していない (noticeShown: false)。
    expect(webhookWarnings()[1]).toEqual([
      'checkout.webhook.undelivered',
      expect.objectContaining({ status: 400, attempts: 1, serverError: 'invalid_body', noticeShown: false }),
    ]);
    expect(args.setRedirectIn).not.toHaveBeenCalled();
  });

  it('応答の前に画面を離れた (unmount) → 後から届いた 422 tx_too_old でも state を書かない', async () => {
    let respond!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
    const args = paidArgs();
    const { unmount } = renderHook(() => useCheckoutOrderNotify(args));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    unmount();
    respond(Response.json({ error: 'tx_too_old' }, { status: 422 }));
    await waitFor(() => expect(webhookWarnings()).toHaveLength(2));
    expect(webhookWarnings()[1]).toEqual([
      'checkout.webhook.undelivered',
      expect.objectContaining({ status: 422, serverError: 'tx_too_old', noticeShown: false }),
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
    // 最初の失敗と、自動の送信が止まったときの 2 件だけ (ボタンで届いた分は出さない)。
    expect(webhookWarnings().map(([event]) => event)).toEqual(['checkout.webhook.non_ok', 'checkout.webhook.undelivered']);
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
    await waitFor(() => expect(webhookWarnings()).toHaveLength(2));
    expect(webhookWarnings()[1][1]).toMatchObject({ noticeShown: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 偽の時計で見る順 (レビュー 3 回目): ボタンの 1 回も、部分の通知を待って枠を数えてから送る。部分の通知の待ちは、待っている
// 間に増えた分まで待つ。部品 (CheckoutForm) からは作れない順 (完了の後に部分の通知が始まる) も、hook を直接描いて見る。
// ---------------------------------------------------------------------------------------------------------------------
describe('完了の通知の追加の動きは、部分の通知が全部終わった後だけ (偽の時計)', () => {
  const T0 = Date.parse('2026-11-14T03:00:00.000Z');
  const MERCHANT_TX: Hex = `0x${'c'.repeat(64)}`;
  const FEE = (n: number): Hex => `0x${String(n).repeat(64)}`;
  // /api/order/notify への送信 (送った順): どの通知か (D + 利用料の hash の先頭の字 / A) と、最初からの経過 ms。
  let sent: { kind: string; at: number }[];
  const kindOf = (init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as { feeUncollected?: boolean; feeTxHash?: string };
    return body.feeUncollected ? `D${body.feeTxHash?.[2] ?? ''}` : 'A';
  };
  const sentAt = (kind: string) => sent.filter((each) => each.kind === kind).map((each) => each.at);
  const after = (ms: number, reply: () => Response) => new Promise<Response>((resolve) => { setTimeout(() => resolve(reply()), ms); });
  const UNAVAILABLE = () => Response.json({ ok: false, error: 'rpc_error' }, { status: 503 });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    sent = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 遅延 import と promise を流し、偽の時計を ms 進めて、React の更新を反映する。
  async function step(ms = 0) {
    await act(async () => {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(ms);
      await vi.dynamicImportSettled();
    });
  }
  function serve(handle: (kind: string, at: number) => Response | Promise<Response>) {
    fetchMock.mockImplementation(async (_url, init) => {
      const entry = { kind: kindOf(init), at: Date.now() - T0 };
      sent.push(entry);
      return handle(entry.kind, entry.at);
    });
  }

  // レビュー (3 回目) の順: 0 / 0.25 秒に 409・1.25 秒に 503 → 自動の送り直し 3.25 / 18.25 秒に 503 → 18.30 秒に server が
  // 直る → 18.35 秒にボタン。押した時点で送ると 6 回目 (429)。枠が空く 61 秒まで待ってから 1 回送る。
  it('ボタンで枠が空くのを待っている間に画面を離れても、送るのは枠が空いてから 1 回。届いても state を書かない', async () => {
    serve((_kind, at) => {
      if (at >= 18_300) return Response.json({ ok: true });
      if (at < 1_000) return Response.json({ ok: false, error: 'processing' }, { status: 409 });
      return UNAVAILABLE();
    });
    const args = paidArgs();
    args.params = { ...args.params, successUrl: 'https://shop.example/thanks' };
    const { result, unmount } = renderHook(() => useCheckoutOrderNotify(args));
    for (let i = 0; i < 18; i++) await step(1_000);
    await step(350);
    expect(sentAt('A')).toEqual([0, 250, 1_250, 3_250, 18_250]);
    expect(result.current.orderNotifyFailed).toBe(true);
    expect(result.current.directNotifyRetryable).toBe(true);

    act(() => result.current.retryDirectNotify());
    await step();
    // 押した時点では送らない。待っている間は、ボタンを出さない。
    expect(sent).toHaveLength(5);
    expect(result.current.directNotifyRetryable).toBe(false);
    expect(result.current.orderNotifyFailed).toBe(true);

    unmount();
    vi.mocked(args.setRedirectIn).mockClear();
    await step(42_649);
    expect(sent).toHaveLength(5);
    await step(1);
    // 0 秒の送信の 61 秒後に 1 回だけ送る (届く)。画面はもう無いので、移動を始め直さない。
    expect(sentAt('A')).toEqual([0, 250, 1_250, 3_250, 18_250, 61_000]);
    await step(1_000);
    expect(args.setRedirectIn).not.toHaveBeenCalled();
  });

  // 通常決済で払い終えた形。standard の値を描き直しで替える (利用料の hash・復元の印)。
  function standardArgs(standard: Partial<Args['standard']>, completed: boolean): Args {
    const data = { merchantTxHash: MERCHANT_TX, feeTxHash: FEE(1), blockNumber: 123n };
    return paidArgs({
      isStandard: true,
      standard: {
        lastSubmittedParams: null,
        data: completed ? data : undefined,
        restoredFromStorage: false,
        merchantTxHash: MERCHANT_TX,
        merchantBlockNumber: 123n,
        feeTxHash: FEE(1),
        ...standard,
      } as Args['standard'],
      completion: completed ? COMPLETED : null,
      submitSnapshotRef: SNAPSHOT,
      setRedirectIn: SET_REDIRECT_IN,
      setBindingStorageError: SET_BINDING_STORAGE_ERROR,
    });
  }
  // 描き直しをまたいで同じ identity にするもの (effect の依存)。
  const COMPLETED: Args['completion'] = {
    key: MERCHANT_TX,
    mode: 'standard',
    blockNumber: 123n,
    hashFields: { merchantTxHash: MERCHANT_TX, feeTxHash: FEE(1) },
    redirectQuery: { tx_hash: MERCHANT_TX, fee_tx_hash: FEE(1) },
  };
  const SNAPSHOT: Args['submitSnapshotRef'] = {
    current: { totalWei: 3000n * JPYC, merchantReceives: 2970n * JPYC, feeAmount: 30n * JPYC, customerPays: 3000n * JPYC },
  };
  const SET_REDIRECT_IN = vi.fn();
  const SET_BINDING_STORAGE_ERROR = vi.fn();
  const PARAMS = paidArgs().params;
  const render = (first: Args) => renderHook(({ args }: { args: Args }) => useCheckoutOrderNotify(args), { initialProps: { args: { ...first, params: PARAMS } } });

  // 今の画面では、完了の後に部分の通知は始まらない (effect D の最初の条件)。その前提が崩れた形 = 完了の後に、復元の印が
  // 立ち、利用料の hash が替わる (hooks/useStandardPayment.ts の requestElsewhere) を、描き直しで作る。
  it('完了の通知が待っている間に、部分の通知が後から始まる: 送り直し・案内・ボタンの送信は、後から始まった分が終わるまで起きない', async () => {
    serve((kind) => {
      // D1: 200 の header はすぐ・本文 ({ ok: false } = 届いていない) は 10 秒。D2: 5 秒に始まり 30 秒に 503。D3: 50 秒に始まり 70 秒に 503。
      if (kind === 'D1') {
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('{"ok":false}'));
                controller.close();
              }, 10_000);
            },
          }),
          { status: 200 },
        );
      }
      if (kind === 'D2') return after(25_000, UNAVAILABLE);
      if (kind === 'D3') return after(20_000, UNAVAILABLE);
      return UNAVAILABLE();
    });
    const { result, rerender } = render(standardArgs({}, false));
    await step();
    expect(sent.map((each) => each.kind)).toEqual(['D1']);
    rerender({ args: { ...standardArgs({}, true), params: PARAMS } });
    await step();
    // 完了の通知の最初の 1 回は、D1 の header の後 (本文を待たない)。
    expect(sent.map((each) => each.kind)).toEqual(['D1', 'A']);

    for (let i = 0; i < 5; i++) await step(1_000);
    // 5 秒: 完了の通知は D1 の本文を待っている。そこへ、別の利用料の hash の部分の通知 (D2) が始まる。
    rerender({ args: { ...standardArgs({ restoredFromStorage: true, feeTxHash: FEE(2) }, true), params: PARAMS } });
    await step();
    expect(sentAt('D2')).toEqual([5_000]);

    for (let i = 0; i < 24; i++) await step(1_000);
    // 29 秒: D1 は 10 秒に終わったが、D2 がまだ。完了の通知は送り直さず、案内も出さない。
    expect(sentAt('A')).toEqual([0]);
    expect(result.current.orderNotifyFailed).toBe(false);

    for (let i = 0; i < 17; i++) await step(1_000);
    // D2 が終わった 30 秒に 1 回目の送り直し、その 15 秒後に 2 回目。届かず、どの部分の通知も届いていないので、案内とボタン。
    expect(sentAt('A')).toEqual([0, 30_000, 45_000]);
    expect(result.current.orderNotifyFailed).toBe(true);
    expect(result.current.directNotifyRetryable).toBe(true);

    for (let i = 0; i < 4; i++) await step(1_000);
    // 50 秒: ボタンが出ている間に、また別の hash の部分の通知 (D3) が始まる。
    rerender({ args: { ...standardArgs({ restoredFromStorage: true, feeTxHash: FEE(3) }, true), params: PARAMS } });
    await step();
    expect(sentAt('D3')).toEqual([50_000]);
    for (let i = 0; i < 5; i++) await step(1_000);
    act(() => result.current.retryDirectNotify());
    for (let i = 0; i < 14; i++) await step(1_000);
    // 55 秒に押したが、D3 が終わる 70 秒までは送らない。
    expect(sentAt('A')).toEqual([0, 30_000, 45_000]);
    await step(1_000);
    expect(sentAt('A')).toEqual([0, 30_000, 45_000, 70_000]);
  });

  it('完了の通知が枠が空くのを待っている間に、部分の通知が始まる: 枠が空いても、その部分の通知が終わるまで送らない', async () => {
    serve((kind, at) => {
      if (kind === 'D1') return Response.json({ ok: false });
      // D2: 20 秒に始まり、80 秒に 503。
      if (kind === 'D2') return after(60_000, UNAVAILABLE);
      // 完了の通知: 0 / 0.25 / 1.25 秒に 409 processing、その後は 503。
      if (at < 5_000) return Response.json({ ok: false, error: 'processing' }, { status: 409 });
      return UNAVAILABLE();
    });
    const { rerender } = render(standardArgs({}, false));
    await step();
    rerender({ args: { ...standardArgs({}, true), params: PARAMS } });
    for (let i = 0; i < 20; i++) await step(1_000);
    // この支払いの送信は D1 (0 秒) + 完了の通知 4 回 = 5 回。送り直しは、枠が空く 61 秒まで待っている。
    expect(sentAt('A')).toEqual([0, 250, 1_250, 5_250]);
    rerender({ args: { ...standardArgs({ restoredFromStorage: true, feeTxHash: FEE(2) }, true), params: PARAMS } });
    await step();
    expect(sentAt('D2')).toEqual([20_000]);

    for (let i = 0; i < 59; i++) await step(1_000);
    // 79 秒: 枠は 61 秒に空いたが、D2 がまだ終わっていないので送っていない。
    expect(sentAt('A')).toEqual([0, 250, 1_250, 5_250]);
    await step(1_000);
    expect(sentAt('A')).toEqual([0, 250, 1_250, 5_250, 80_000]);
  });

  it('完了の後に復元の印が立っても、同じ利用料の hash の部分の通知は、送り済みなので送り直さない', async () => {
    serve(() => Response.json({ ok: true }));
    const { rerender } = render(standardArgs({}, false));
    await step();
    rerender({ args: { ...standardArgs({}, true), params: PARAMS } });
    await step();
    expect(sent.map((each) => each.kind)).toEqual(['D1', 'A']);

    await step(1_000);
    rerender({ args: { ...standardArgs({ restoredFromStorage: true }, true), params: PARAMS } });
    for (let i = 0; i < 5; i++) await step(1_000);
    expect(sent.map((each) => each.kind)).toEqual(['D1', 'A']);
  });
});
