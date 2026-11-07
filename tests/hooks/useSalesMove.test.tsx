// hooks/useSalesMove (plans/store-sales-move.md §2.2・P2a): 署名の中身・POST 先・応答の分類・復旧の枠 (openpay:move-intent:v1)・
// 再署名しないこと・支払う側の控え。応答の全行の分類は tests/hooks/relayResponseClassification.test.tsx が 4 つの hook で固定する。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Address, Hex } from 'viem';

const FROM: Address = '0x9999999999999999999999999999999999999999';
const DEST: Address = '0x1111111111111111111111111111111111111111';
const FORWARDER: Address = '0x5555555555555555555555555555555555555555';
const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`;
const TX: Hex = `0x${'a'.repeat(64)}`;

const h = vi.hoisted(() => {
  const signTypedData = vi.fn();
  const readContract = vi.fn();
  const waitForTransactionReceipt = vi.fn();
  return {
    signTypedData,
    readContract,
    // wagmi の戻り値は render ごとに同じ物を返す (hook の useCallback の依存が毎回変わらないように)。
    walletClient: { data: { signTypedData } as { signTypedData: typeof signTypedData } | undefined },
    publicClient: { readContract, waitForTransactionReceipt } as
      | { readContract: typeof readContract; waitForTransactionReceipt: typeof waitForTransactionReceipt }
      | undefined,
    account: { address: '0x9999999999999999999999999999999999999999' as string | undefined, chainId: 80002 as number | undefined },
    resolveRelayIntent: vi.fn(),
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useWalletClient: () => h.walletClient,
  usePublicClient: () => h.publicClient,
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => '0x5555555555555555555555555555555555555555' };
});
vi.mock('@/lib/relay/relayIntentRecovery', () => ({
  resolveRelayIntent: h.resolveRelayIntent,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useSalesMove, SALES_MOVE_RELAY_URL } from '@/hooks/useSalesMove';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { SALES_MOVE_INTENT_STORAGE_KEY, RELAY_INTENT_STORAGE_KEY } from '@/lib/paymentIntentStorage';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';

const DEPLOYMENT = defaultDeploymentForSymbol('jpyc');
const CHAIN = DEPLOYMENT.chainId;
const FEE = relayGasFeeValue(CHAIN);
const AMOUNT = 5n * 10n ** 18n;
const LABELS = { delivered: '届く額', fee: '利用料', locale: 'ja' };

type Reply = { network: true } | { status: number; body: unknown; headers?: Record<string, string> };
let replies: Reply[] = [];
// POST の時点で保存されていた枠 (POST の前に保存しているか)。
let savedAtPost: (string | null)[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url !== SALES_MOVE_RELAY_URL) throw new Error(`想定外の fetch: ${url}`);
  savedAtPost.push(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY));
  const reply = replies.shift() ?? { status: 200, body: { ok: true, txHash: TX } };
  if ('network' in reply) throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
});

function posted(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

async function mount() {
  const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
  await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
  return view;
}

type View = Awaited<ReturnType<typeof mount>>;

async function press(view: View, params = { destination: DEST, amount: AMOUNT }) {
  let outcome: { result?: Awaited<ReturnType<View['result']['current']['mutateAsync']>>; error?: unknown } = {};
  await act(async () => {
    try {
      outcome = { result: await view.result.current.mutateAsync(params) };
    } catch (error) {
      outcome = { error };
    }
  });
  return outcome;
}

function savedIntent() {
  const raw = window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  replies = [];
  savedAtPost = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  h.account.address = FROM;
  h.account.chainId = CHAIN;
  h.walletClient.data = { signTypedData: h.signTypedData };
  h.publicClient = { readContract: h.readContract, waitForTransactionReceipt: vi.fn() };
  h.signTypedData.mockResolvedValue(SIGNATURE);
  h.readContract.mockResolvedValue(1_000n * 10n ** 18n);
  h.resolveRelayIntent.mockResolvedValue({ kind: 'unknown' });
  vi.stubGlobal('fetch', fetchMock);
});

describe('useSalesMove: 署名の中身と POST', () => {
  it('receiveWithAuthorization を to = forwarder・nonce = 分割のコミットメント・利用料 = relayGasFeeValue で 1 回署名する', async () => {
    const view = await mount();
    await press(view);

    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    const typed = h.signTypedData.mock.calls[0][0];
    expect(typed.primaryType).toBe('ReceiveWithAuthorization');
    expect(typed.account).toBe(FROM);
    expect(typed.domain.chainId).toBe(CHAIN);
    expect(typed.domain.verifyingContract.toLowerCase()).toBe(DEPLOYMENT.address.toLowerCase());
    expect(typed.message.from).toBe(FROM);
    expect(typed.message.to).toBe(FORWARDER);
    expect(typed.message.value).toBe(AMOUNT + FEE);
    expect(typed.message.validAfter).toBe(0n);
    const body = posted()[0];
    expect(typed.message.nonce).toBe(
      buildForwarderNonce(
        {
          from: FROM,
          merchant: DEST,
          merchantValue: AMOUNT,
          feeReceiver: env.feeReceiver as Address,
          feeValue: FEE,
          validAfter: 0n,
          validBefore: typed.message.validBefore,
          intentSalt: body.intentSalt as Hex,
        },
        CHAIN,
        FORWARDER,
      ),
    );
    // 署名の期限は今から 5 分 (AUTHORIZATION_VALIDITY_WINDOW_SEC)。
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(typed.message.validBefore > now + 290n && typed.message.validBefore <= now + 300n).toBe(true);
  });

  it('POST 先は /api/relay/jpyc/move。gasMode・feeKind・tipMessage・feeReceiver は送らない', async () => {
    const view = await mount();
    await press(view);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/relay/jpyc/move');
    const body = posted()[0];
    expect(Object.keys(body).sort()).toEqual(
      ['chainId', 'feeValue', 'from', 'intentSalt', 'merchant', 'merchantValue', 'signature', 'validAfter', 'validBefore'].sort(),
    );
    expect(body).toMatchObject({
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      merchantValue: AMOUNT.toString(),
      feeValue: FEE.toString(),
      validAfter: '0',
      signature: SIGNATURE,
    });
    expect(body.intentSalt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('署名の前にウォレットの JPYC を読み直し、移す額 + 利用料に足りなければ署名させない', async () => {
    h.readContract.mockResolvedValue(AMOUNT + FEE - 1n);
    const view = await mount();
    const { error } = await press(view);
    expect((error as Error).message).toBe('insufficient_balance');
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: DEPLOYMENT.address, functionName: 'balanceOf', args: [FROM] }),
    );
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ちょうど足りる (移す額 + 利用料 = ウォレットの JPYC) なら署名する', async () => {
    h.readContract.mockResolvedValue(AMOUNT + FEE);
    const view = await mount();
    await press(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('ウォレットの JPYC を読めないときも署名させない', async () => {
    h.readContract.mockRejectedValue(new Error('rpc down'));
    const view = await mount();
    const { error } = await press(view);
    expect((error as Error).message).toBe('balance_unavailable');
    expect(h.signTypedData).not.toHaveBeenCalled();
  });

  it('移せないチェーン・未接続では署名させない', async () => {
    h.account.chainId = 137_000;
    let view = await mount();
    expect(((await press(view)).error as Error).message).toBe('unsupported_chain');
    view.unmount();
    h.account.chainId = CHAIN;
    h.account.address = undefined;
    view = await mount();
    expect(((await press(view)).error as Error).message).toBe('wallet_not_connected');
    expect(h.signTypedData).not.toHaveBeenCalled();
  });

  it('ログには chainId と段階だけ (署名・アドレス・額を出さない)', async () => {
    const view = await mount();
    await press(view);
    h.signTypedData.mockRejectedValueOnce(new Error(`boom ${SIGNATURE}`));
    await press(view);
    const calls = [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls];
    const names = calls.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(['sales_move.sign_requested', 'sales_move.sign_completed', 'sales_move.sign_failed']));
    for (const [, fields] of calls) {
      expect(fields).toEqual({ chainId: CHAIN });
    }
  });
});

describe('useSalesMove: 応答の分類と復旧の枠', () => {
  it('成功: POST の前に公開 metadata だけを保存し、成功で消す。決済の枠には書かない', async () => {
    const view = await mount();
    const { result } = await press(view);
    expect(result).toEqual({ txHash: TX, success: true });

    expect(savedAtPost).toHaveLength(1);
    const saved = JSON.parse(savedAtPost[0]!);
    expect(saved).toMatchObject({
      version: 1,
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      merchantValue: AMOUNT.toString(),
      feeValue: FEE.toString(),
      nonce: h.signTypedData.mock.calls[0][0].message.nonce,
    });
    expect(savedAtPost[0]).not.toContain(SIGNATURE.slice(2));
    expect(savedIntent()).toBeNull();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    expect(view.result.current.held).toBeNull();
  });

  it('成功: 支払う側の控えに「届く額」と「利用料」を別の明細で残し、お店の履歴には入れない', async () => {
    const view = await mount();
    await press(view);
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      txHash: TX,
      status: 'confirmed',
      sourceRoute: '/create#move',
      merchantAddress: DEST,
      payerAddress: FROM,
      amount: '7',
      totalAmount: '7',
      feeAmount: '2',
      locale: 'ja',
    });
    expect(receipts[0].lineItems?.map((li) => [li.name, li.amount])).toEqual([
      ['届く額', '5'],
      ['利用料', '2'],
    ]);
    expect(window.localStorage.getItem('openpay:history:v1')).toBeNull();
  });

  it('revert: 成立しなかった結果として返し、枠を消す。次は新しい署名で構わない', async () => {
    replies = [{ status: 200, body: { ok: false, reverted: true, txHash: TX } }];
    const view = await mount();
    const { result } = await press(view);
    expect(result).toEqual({ txHash: TX, success: false });
    expect(savedIntent()).toBeNull();
    expect(view.result.current.held).toBeNull();
    // revert の控えは新しく作らない。
    expect(loadPayerReceipts()).toEqual([]);
    await press(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('202 pending: throw せずに返し、枠と保持を残す。次は status の照会だけ (再署名・再 POST しない)', async () => {
    replies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    const view = await mount();
    const { result } = await press(view);
    expect(result).toEqual({ txHash: TX, success: false, pending: true });
    expect(savedIntent()).not.toBeNull();
    expect(view.result.current.held).toBe('ambiguous');
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'pending' });

    const again = await press(view);
    expect(isRelayResponseUnknownError(again.error)).toBe(true);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
    // status の照会は既存の recover の形のまま。
    expect(h.resolveRelayIntent.mock.calls[0][0].intent).toMatchObject({
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      routeKind: 'recover',
      nonce: h.signTypedData.mock.calls[0][0].message.nonce,
    });
  });

  it('応答不明 (fetch の失敗): ambiguous の latch を張り、その場で status を照会する。次の押下でも再署名しない', async () => {
    replies = [{ network: true }];
    const view = await mount();
    const first = await press(view);
    expect(isRelayResponseUnknownError(first.error)).toBe(true);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
    expect(savedIntent()).not.toBeNull();
    expect(view.result.current.held).toBe('ambiguous');

    await press(view, { destination: DEST, amount: AMOUNT * 2n });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(2);
  });

  it('応答不明の後の照会で成立が分かれば、成功を返して枠を消し、控えを残す', async () => {
    replies = [{ network: true }];
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    const view = await mount();
    const { result } = await press(view);
    expect(result).toEqual({ txHash: TX, success: true });
    expect(savedIntent()).toBeNull();
    expect(view.result.current.held).toBeNull();
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'confirmed', feeAmount: '2' });
  });

  it('429 ip_rate_limited: 署名済み payload を memory に保持し、枠は消す。次は同じ payload の再 POST だけ', async () => {
    replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '30' } }];
    const view = await mount();
    const first = await press(view);
    expect(isRelayIpRateLimitedError(first.error)).toBe(true);
    expect((first.error as { retryAfterSeconds: number }).retryAfterSeconds).toBe(30);
    expect(savedIntent()).toBeNull();
    expect(view.result.current.held).toBe('retry');

    const second = await press(view, { destination: DEST, amount: AMOUNT * 2n });
    expect(second.result).toEqual({ txHash: TX, success: true });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(posted()).toHaveLength(2);
    expect(posted()[1]).toEqual(posted()[0]);
    // 再送の前に枠を保存し直している。
    expect(savedAtPost[1]).not.toBeNull();
  });

  it('構造化の 4xx: 拒否を Error で返し、保持と枠を外す (次は新しい署名)', async () => {
    replies = [{ status: 400, body: { ok: false, error: 'merchant_is_token' } }];
    const view = await mount();
    const { error } = await press(view);
    expect((error as Error).message).toBe('merchant_is_token');
    expect(isRelayResponseUnknownError(error)).toBe(false);
    expect(savedIntent()).toBeNull();
    expect(view.result.current.held).toBeNull();
    await press(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('成立・送信済みの後の move は送らない (二重の移動を止める)', async () => {
    replies = [{ status: 202, body: { ok: false, pending: true, txHash: null } }];
    const view = await mount();
    await act(async () => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
    });
    await waitFor(() => expect(view.result.current.result?.pending).toBe(true));
    await act(async () => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
    });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).not.toHaveBeenCalled();
  });
});

describe('useSalesMove: 開き直したときの照会', () => {
  function storeIntent() {
    window.sessionStorage.setItem(
      SALES_MOVE_INTENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        chainId: CHAIN,
        from: FROM,
        merchant: DEST,
        merchantValue: AMOUNT.toString(),
        feeValue: FEE.toString(),
        nonce: `0x${'c'.repeat(64)}`,
        validBefore: '9999999999',
        issuedAt: 1_700_000_000_000,
      }),
    );
  }

  it('枠があれば mount で nonce を照会し、成立なら成功を出して枠を消し、控えを残す', async () => {
    storeIntent();
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent.mock.calls[0][0].intent).toEqual({
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      merchantValue: AMOUNT.toString(),
      feeValue: FEE.toString(),
      nonce: `0x${'c'.repeat(64)}`,
      validBefore: '9999999999',
      routeKind: 'recover',
      issuedAt: 1_700_000_000_000,
    });
    expect(savedIntent()).toBeNull();
    expect(view.result.current.held).toBeNull();
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'confirmed', sourceRoute: '/create#move' });
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // revert した tx の照会は status route の実際の応答 (冪等の記録がある間は indeterminate) で
  // tests/hooks/useSalesMove.statusContract.test.tsx が固定する (ここで settled + success:false を作らない・route は返さない)。

  it('期限切れで使われなかった枠は消し、何も出さない (次は新しい署名を許す)', async () => {
    storeIntent();
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'expired' });
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.isRecovering).toBe(false));
    await waitFor(() => expect(savedIntent()).toBeNull());
    expect(view.result.current.result).toBeUndefined();
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.held).toBeNull();
    await press(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('照会で分からなければ枠と保持を残し、押しても再署名しない', async () => {
    storeIntent();
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.error).not.toBeNull());
    expect(isRelayResponseUnknownError(view.result.current.error)).toBe(true);
    expect(view.result.current.held).toBe('ambiguous');
    expect(savedIntent()).not.toBeNull();
    await press(view);
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useSalesMove: 署名の試みの直列化と unmount (Codex MUST・PR #1040)', () => {
  function deferredSignature() {
    let resolve: (sig: Hex) => void = () => undefined;
    h.signTypedData.mockImplementationOnce(() => new Promise<Hex>((r) => (resolve = r)));
    return (sig: Hex) => resolve(sig);
  }

  it('署名を待つ間に unmount → 開き直して新しい試みが送信済み → 古い署名が返っても、古い試みは POST も枠の上書きもしない', async () => {
    const resolveOld = deferredSignature();
    const viewA = await mount();
    let oldOutcome: Promise<{ result?: unknown; error?: unknown }> = Promise.resolve({});
    act(() => {
      oldOutcome = viewA.result.current.mutateAsync({ destination: DEST, amount: AMOUNT }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    });
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    viewA.unmount();

    // 開き直した画面で新しい試み (送信済み・未確定)。
    replies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    const viewB = await mount();
    const fresh = await press(viewB, { destination: DEST, amount: AMOUNT * 2n });
    expect(fresh.result).toEqual({ txHash: TX, success: false, pending: true });
    const freshNonce = h.signTypedData.mock.calls[1][0].message.nonce;
    expect(savedIntent()?.nonce).toBe(freshNonce);

    // 古い署名が後から返る。
    await act(async () => {
      resolveOld(`0x${'cd'.repeat(65)}`);
      await oldOutcome;
    });
    const old = await oldOutcome;
    expect((old.error as Error).message).toBe('move_cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted()[0].merchantValue).toBe((AMOUNT * 2n).toString());
    expect(savedIntent()?.nonce).toBe(freshNonce);
    expect(savedAtPost).toHaveLength(1);
    expect(vi.mocked(logger.info).mock.calls.map(([name]) => name)).toContain('sales_move.sign_abandoned');
    viewB.unmount();
  });

  it('ウォレットの JPYC の読み直しを待つ間に unmount したら、署名を求めず枠も書かない', async () => {
    let resolveBalance: (v: bigint) => void = () => undefined;
    h.readContract.mockImplementationOnce(() => new Promise<bigint>((r) => (resolveBalance = r)));
    const view = await mount();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = view.result.current.mutateAsync({ destination: DEST, amount: AMOUNT }).catch((error: unknown) => error);
    });
    await waitFor(() => expect(h.readContract).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      resolveBalance(1_000n * 10n ** 18n);
      await outcome;
    });
    expect(((await outcome) as Error).message).toBe('move_cancelled');
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedIntent()).toBeNull();
  });

  it('試みの途中に入った 2 つ目 (並行の mutateAsync) は署名を求めずに断り、1 つ目はそのまま成立する', async () => {
    const resolveFirst = deferredSignature();
    const view = await mount();
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = view.result.current.mutateAsync({ destination: DEST, amount: AMOUNT });
    });
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    const second = await press(view);
    expect((second.error as Error).message).toBe('move_in_progress');
    await act(async () => {
      resolveFirst(SIGNATURE);
      await first;
    });
    expect(await first).toEqual({ txHash: TX, success: true });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('二度押し (同じ tick に move を 2 回) でも署名は 1 回・POST も 1 回で、結果は 1 つ目のもの', async () => {
    const view = await mount();
    await act(async () => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
      view.result.current.move({ destination: DEST, amount: AMOUNT * 3n });
    });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted()[0].merchantValue).toBe(AMOUNT.toString());
    expect(view.result.current.error).toBeNull();
  });

  it('署名を待つ間の move は新しい mutation を作らない (結果を画面から消さない)', async () => {
    const resolveFirst = deferredSignature();
    const view = await mount();
    await act(async () => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
    });
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    await act(async () => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
    });
    await act(async () => {
      resolveFirst(SIGNATURE);
    });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toBeNull();
  });
});
