// hooks/useSalesMove (plans/store-sales-move.md §2.2・P2a): 署名の中身・POST 先・応答の分類・復旧の枠 (openpay:move-intent:v1)・
// 再署名しないこと・支払う側の控え。応答の全行の分類は tests/hooks/relayResponseClassification.test.tsx が 4 つの hook で固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
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
import {
  SALES_MOVE_INTENT_PROBE_KEY,
  SALES_MOVE_INTENT_STORAGE_KEY,
  RELAY_INTENT_STORAGE_KEY,
} from '@/lib/paymentIntentStorage';
import { salesMoveErrorKey } from '@/lib/salesMoveForm';
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
  let outcome: { result?: Awaited<ReturnType<View['result']['current']['moveAsync']>>; error?: unknown } = {};
  await act(async () => {
    try {
      outcome = { result: await view.result.current.moveAsync(params) };
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
  // 前の test が使い残した mockResolvedValueOnce を持ち越さない (1 つの失敗が後ろの test を巻き込まないように)。
  h.resolveRelayIntent.mockReset();
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
    // 202 を返した後、同じ画面でも status を 1 回照会している (第 10 回レビュー G-2・それまでは次に押すまで照会しなかった)。
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);

    const again = await press(view);
    expect(isRelayResponseUnknownError(again.error)).toBe(true);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 押した分の照会が 1 回増えるだけ (G-2 より前は、ここが最初の照会で 1 回だった)。
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(2);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 照会は 202 の後に hook が始めた 1 回だけ (第 10 回レビュー G-2)。断った 2 回目の move は照会も始めない
    // (G-2 より前は 202 の後に照会しなかったので、ここは 0 回だった)。
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
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
  // tests/hooks/useSalesMove.statusContract.test.tsx が固定する。status が settled を返した tx の receipt が手元の RPC で revert の
  // とき (照会の部品が settled + success:false を返す) もロックのままであることも、そこで照会の部品を実物で通して確かめる。

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
      oldOutcome = viewA.result.current.moveAsync({ destination: DEST, amount: AMOUNT }).then(
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
      outcome = view.result.current.moveAsync({ destination: DEST, amount: AMOUNT }).catch((error: unknown) => error);
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

  it('試みの途中に入った 2 つ目 (並行の moveAsync) は mutation を作らずに断り、1 つ目の結果が hook の状態に残る', async () => {
    const resolveFirst = deferredSignature();
    const view = await mount();
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = view.result.current.moveAsync({ destination: DEST, amount: AMOUNT });
    });
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    const second = await press(view);
    expect((second.error as Error).message).toBe('move_in_progress');
    // 断った 2 つ目は hook の状態 (1 つ目の試み中) を変えない。
    expect(view.result.current.isPending).toBe(true);
    expect(view.result.current.error).toBeNull();
    await act(async () => {
      resolveFirst(SIGNATURE);
      await first;
    });
    expect(await first).toEqual({ txHash: TX, success: true });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.isPending).toBe(false);
    expect(view.result.current.held).toBeNull();
  });

  it('並行の moveAsync で 1 つ目が送信済み (202) になっても、送信済みの印と保持が hook の状態に残る', async () => {
    replies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    const resolveFirst = deferredSignature();
    const view = await mount();
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = view.result.current.moveAsync({ destination: DEST, amount: AMOUNT });
    });
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    expect(((await press(view)).error as Error).message).toBe('move_in_progress');
    await act(async () => {
      resolveFirst(SIGNATURE);
      await first;
    });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true }));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.held).toBe('ambiguous');
  });

  it('429 の後の再送が react-query の待ち行列にある間に unmount → 開き直して新しい署名: 古い再送は POST も枠の書き込みもしない', async () => {
    replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '30' } }];
    const viewA = await mount();
    await press(viewA);
    expect(viewA.result.current.held).toBe('retry');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const saltA = posted()[0].intentSalt;

    // 再送を始めた (mutation は作ったが mutationFn はまだ) 直後に、同じ tick で画面を離れる。
    let retry: Promise<{ result?: unknown; error?: unknown }> = Promise.resolve({});
    act(() => {
      retry = viewA.result.current.moveAsync({ destination: DEST, amount: AMOUNT }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      viewA.unmount();
    });
    expect(((await retry).error as Error).message).toBe('move_cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedIntent()).toBeNull();

    // 開き直した画面: 枠は空 (429 は冪等の claim より前の拒否で、その POST は何も動かしていない) → 新しい署名で移せる。
    replies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    const viewB = await mount();
    expect(viewB.result.current.held).toBeNull();
    const fresh = await press(viewB, { destination: DEST, amount: AMOUNT * 2n });
    expect(fresh.result).toEqual({ txHash: TX, success: false, pending: true });
    expect(posted()).toHaveLength(2);
    expect(posted()[0].intentSalt).toBe(saltA);
    expect(posted()[1].intentSalt).not.toBe(saltA);
    expect(savedIntent()?.nonce).toBe(h.signTypedData.mock.calls[1][0].message.nonce);
    expect(viewB.result.current.held).toBe('ambiguous');
    // 少し待っても、古い hook から送られるものは無い (timer・照会・待ち行列のどれも A を送らない)。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    viewB.unmount();
  });

  it('429 の後の再送が offline で止まっている間に unmount → 開き直した後で online に戻っても、止まっていた再送は POST も枠の上書きもしない', async () => {
    // アプリと同じく 1 つの QueryClient を共有する (止まった mutation は QueryClient が online で再開する)。
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    replies = [{ status: 429, body: { error: 'ip_rate_limited' } }];
    const viewA = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: shared });
    await waitFor(() => expect(viewA.result.current.isRestoring).toBe(false));
    await press(viewA);
    expect(viewA.result.current.held).toBe('retry');

    onlineManager.setOnline(false);
    try {
      await act(async () => {
        viewA.result.current.move({ destination: DEST, amount: AMOUNT });
      });
      // offline なので mutationFn は始まらない (POST も無い)。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      viewA.unmount();
      const viewB = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: shared });
      await waitFor(() => expect(viewB.result.current.isRestoring).toBe(false));
      // online に戻ると、止まっていた A の再送が再開する → 番号が古いので何もしない。
      await act(async () => {
        onlineManager.setOnline(true);
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(savedIntent()).toBeNull();

      replies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
      await press(viewB, { destination: DEST, amount: AMOUNT * 2n });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(posted()[1].merchantValue).toBe((AMOUNT * 2n).toString());
      expect(savedIntent()?.nonce).toBe(h.signTypedData.mock.calls[1][0].message.nonce);
      viewB.unmount();
    } finally {
      onlineManager.setOnline(true);
    }
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

// 第 10 回レビュー G-1: 復旧の枠 (openpay:move-intent:v1) を書けない端末では送らない。枠が無いまま送ると、応答を失って開き直した
// 画面が未解決の移動を知らず、新しい署名 (別の nonce) で二重の移動になる。差し替えるのは sessionStorage の書き込みだけ
// (hook・保存の部品 lib/paymentIntentStorage は実物・localStorage = 支払う側の控えはそのまま)。
describe('useSalesMove: 復旧の枠を書けない端末では送らない (第 10 回レビュー G-1)', () => {
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  // when に当たるキーへの sessionStorage の書き込みを、throw (容量超過・保存の禁止) か drop (投げずに書かれない) にする。
  function breakSessionWrites(when: (key: string) => boolean, how: 'throw' | 'drop' = 'throw') {
    const real = Storage.prototype.setItem;
    spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage && when(key)) {
        if (how === 'throw') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return;
      }
      real.call(this, key, value);
    });
  }

  it('setItem が throw する端末: 署名を求める前に止める (署名なし・POST なし)。専用の文言の key になる', async () => {
    breakSessionWrites(() => true);
    const view = await mount();
    const { error } = await press(view);
    expect((error as Error).message).toBe('intent_storage_unavailable');
    expect(salesMoveErrorKey(error)).toBe('storageUnavailable');
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.result.current.held).toBeNull();
    expect(view.result.current.result).toBeUndefined();
    // 応答不明 (送信済みかもしれない) にはしない: 何も送っていない。
    expect(isRelayResponseUnknownError(error)).toBe(false);
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('署名の前の確かめは通ったが、枠そのものの書き込みが throw: 署名の後でも POST しない (読み戻しで止める)', async () => {
    breakSessionWrites((key) => key === SALES_MOVE_INTENT_STORAGE_KEY);
    const view = await mount();
    const { error } = await press(view);
    expect((error as Error).message).toBe('intent_storage_unavailable');
    expect(salesMoveErrorKey(error)).toBe('storageUnavailable');
    // 署名の前の確かめ (別のキー) は通るので、署名は 1 回求めている。
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // 署名済みの payload は保持しない (次は新しい署名から)。
    expect(view.result.current.held).toBeNull();
    expect(savedIntent()).toBeNull();
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('書き込みが投げずに捨てられる端末 (読み戻すと無い) でも POST しない', async () => {
    breakSessionWrites((key) => key === SALES_MOVE_INTENT_STORAGE_KEY, 'drop');
    const view = await mount();
    const { error } = await press(view);
    expect((error as Error).message).toBe('intent_storage_unavailable');
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.result.current.held).toBeNull();
  });

  it('読み戻したものが別の nonce (書けずに古い枠が残っている) なら POST せず、その枠も消さない', async () => {
    const view = await mount();
    const stale = JSON.stringify({
      version: 1,
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      merchantValue: AMOUNT.toString(),
      feeValue: FEE.toString(),
      nonce: `0x${'d'.repeat(64)}`,
      validBefore: '9999999999',
      issuedAt: 1_700_000_000_000,
    });
    window.sessionStorage.setItem(SALES_MOVE_INTENT_STORAGE_KEY, stale);
    breakSessionWrites((key) => key === SALES_MOVE_INTENT_STORAGE_KEY, 'drop');
    const { error } = await press(view);
    expect((error as Error).message).toBe('intent_storage_unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBe(stale);
  });

  it('止めた後に保存できるようになれば、新しい署名で移せる (止めたときの署名は使い回さない)', async () => {
    breakSessionWrites((key) => key === SALES_MOVE_INTENT_STORAGE_KEY);
    const view = await mount();
    await press(view);
    expect(fetchMock).not.toHaveBeenCalled();
    spy?.mockRestore();
    spy = undefined;
    const { result } = await press(view);
    expect(result).toEqual({ txHash: TX, success: true });
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 送ったのは 2 回目の署名の nonce (1 回目の署名は送っていない)。
    expect(JSON.parse(savedAtPost[0]!).nonce).toBe(h.signTypedData.mock.calls[1][0].message.nonce);
  });

  it('IP 制限で保持した payload の再送の前に書けなくなったら、再送せずに保持を捨てる', async () => {
    replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '30' } }];
    const view = await mount();
    await press(view);
    expect(view.result.current.held).toBe('retry');
    breakSessionWrites((key) => key === SALES_MOVE_INTENT_STORAGE_KEY);
    const { error } = await press(view);
    expect((error as Error).message).toBe('intent_storage_unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(view.result.current.held).toBeNull();
  });

  it('保存できる端末: 署名の前の確かめは枠のキーに書かず、確かめのキーも残さない (署名を待つ間に開き直しても塞がない)', async () => {
    let resolveSignature: (sig: Hex) => void = () => undefined;
    h.signTypedData.mockImplementationOnce(() => new Promise<Hex>((r) => (resolveSignature = r)));
    const view = await mount();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = view.result.current.moveAsync({ destination: DEST, amount: AMOUNT });
    });
    await waitFor(() => expect(h.signTypedData).toHaveBeenCalledTimes(1));
    // ウォレットの署名を待っている間: 枠はまだ無い (署名の後に書く)。確かめのキーも消してある。
    expect(savedIntent()).toBeNull();
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_PROBE_KEY)).toBeNull();
    await act(async () => {
      resolveSignature(SIGNATURE);
      await outcome;
    });
    expect(await outcome).toEqual({ txHash: TX, success: true });
    expect(savedAtPost[0]).not.toBeNull();
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_PROBE_KEY)).toBeNull();
  });

  // 第 10 回レビュー PR-03 Codex SHOULD: 開き直したときに枠を読めなかった (読み取りが投げた) のを「枠が無い」と読まない。読めないまま
  // 残っている未解決の枠を、読めるようになった後の新しい移動が上書きして署名・POST すると、二重の移動になる。
  describe('開き直したときに枠を読めなかった端末', () => {
    const UNRESOLVED = JSON.stringify({
      version: 1,
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      merchantValue: AMOUNT.toString(),
      feeValue: FEE.toString(),
      nonce: `0x${'c'.repeat(64)}`,
      validBefore: '9999999999',
      issuedAt: 1_700_000_000_000,
    });
    let readable = false;
    let readSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
      readable = false;
      const real = Storage.prototype.getItem;
      // 枠のキーの読み取りだけを、readable になるまで throw にする (サイトのデータへのアクセスを止めている等)。
      readSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (!readable && this === window.sessionStorage && key === SALES_MOVE_INTENT_STORAGE_KEY) {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        }
        return real.call(this, key);
      });
    });

    afterEach(() => {
      readSpy?.mockRestore();
      readSpy = undefined;
    });

    it('読めない間は移さない (署名・POST なし・専用の文言)。読めるようになって未解決の枠があれば、上書きせずにその枠を照会する', async () => {
      window.sessionStorage.setItem(SALES_MOVE_INTENT_STORAGE_KEY, UNRESOLVED);
      const view = await mount();
      // 読めなかったので、開き直したときの照会はしていない (保持も無い)。
      expect(h.resolveRelayIntent).not.toHaveBeenCalled();
      expect(view.result.current.held).toBeNull();

      const blocked = await press(view);
      expect((blocked.error as Error).message).toBe('intent_storage_unavailable');
      expect(salesMoveErrorKey(blocked.error)).toBe('storageUnavailable');
      expect(isRelayResponseUnknownError(blocked.error)).toBe(false);
      expect(h.signTypedData).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      readable = true;
      const adopted = await press(view);
      // 新しい署名ではなく、残っていた枠の nonce の照会 (既定の mock は unknown = 応答不明のまま保持)。
      expect(isRelayResponseUnknownError(adopted.error)).toBe(true);
      expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
      expect(h.resolveRelayIntent.mock.calls[0][0].intent).toMatchObject({ nonce: `0x${'c'.repeat(64)}`, routeKind: 'recover' });
      expect(view.result.current.held).toBe('ambiguous');
      expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBe(UNRESOLVED);
      expect(h.signTypedData).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      // 押し直しても署名しない (保持が残る間は照会だけ)。
      await press(view);
      expect(h.signTypedData).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('読めるようになって枠が空なら、今までどおり移せる', async () => {
      const view = await mount();
      readable = true;
      const { result } = await press(view);
      expect(result).toEqual({ txHash: TX, success: true });
      expect(h.signTypedData).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(h.resolveRelayIntent).not.toHaveBeenCalled();
    });
  });
});

// 第 10 回レビュー G-2: 202 pending を返した後、同じ画面でも status を照会して終端の結果へ進める。照会の間も、打ち切った後も、
// 新しい署名・POST はしない。照会の部品 (resolveRelayIntent) は境界として差し替える (実物で通すのは
// tests/hooks/useSalesMove.statusContract.test.tsx)。
describe('useSalesMove: 202 pending の後、同じ画面で照会する (第 10 回レビュー G-2)', () => {
  const TX2: Hex = `0x${'b'.repeat(64)}`;
  const PENDING: Reply = { status: 202, body: { ok: false, pending: true, txHash: TX } };

  function deferredRecovery() {
    let resolve: (outcome: unknown) => void = () => undefined;
    h.resolveRelayIntent.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    return (outcome: unknown) => resolve(outcome);
  }

  async function pressMove(view: View, params = { destination: DEST, amount: AMOUNT }) {
    await act(async () => {
      view.result.current.move(params);
    });
  }

  it('202 → 照会の間は送信済みのまま (署名しない) → 成立が分かれば、開き直さずに成功になる', async () => {
    replies = [PENDING];
    const settle = deferredRecovery();
    const view = await mount();
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true }));
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent.mock.calls[0][0].intent).toMatchObject({
      routeKind: 'recover',
      nonce: h.signTypedData.mock.calls[0][0].message.nonce,
    });
    expect(view.result.current.isRecovering).toBe(true);
    expect(view.result.current.held).toBe('ambiguous');

    // 照会の間: 押しても「もう一度確かめる」でも、署名・POST はせず、照会の 2 本目も始めない。
    await pressMove(view, { destination: DEST, amount: AMOUNT * 2n });
    await act(async () => {
      view.result.current.recheck();
    });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
    expect(view.result.current.result?.pending).toBe(true);

    await act(async () => settle({ kind: 'settled', txHash: TX, success: true }));
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(view.result.current.isRecovering).toBe(false);
    expect(view.result.current.isPending).toBe(false);
    expect(view.result.current.held).toBeNull();
    expect(view.result.current.error).toBeNull();
    expect(savedIntent()).toBeNull();
    // pending の控えが confirmed に上がる (同じ tx は 1 件)。
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'confirmed', feeAmount: '2' });

    // 成立の後に押しても送らない。
    await pressMove(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('202 → 照会の部品が候補の receipt の revert を返しても (settled + success:false)、不成立にしない。保持と枠を残し、署名しない', async () => {
    // 第 10 回レビュー PR-03 Codex MUST 1: 別の tx が同じ authorization を先に使っていれば JPYC は動いている。新しい署名を許すのは
    // 期限切れ未使用の証明だけ (照会の部品を実物で通すのは tests/hooks/useSalesMove.statusContract.test.tsx)。
    replies = [PENDING, { status: 200, body: { ok: true, txHash: TX2 } }];
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: false });
    const view = await mount();
    await pressMove(view);
    await waitFor(() => expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.isRecovering).toBe(false));
    expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true });
    expect(view.result.current.held).toBe('ambiguous');
    expect(view.result.current.error).toBeNull();
    expect(savedIntent()).not.toBeNull();
    // 控えは failed にしない (成立しなかった証拠ではない)。
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'pending' });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('sales_move.recovery_receipt_reverted', { chainId: CHAIN });

    await pressMove(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view.result.current.held).toBe('ambiguous');
  });

  it('202 → 期限切れ未使用が証明されたら、送信済みの表示を残さず不成立にする', async () => {
    replies = [PENDING];
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'expired' });
    const view = await mount();
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: null, success: false }));
    expect(view.result.current.held).toBeNull();
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.isRecovering).toBe(false);
    expect(savedIntent()).toBeNull();
  });

  it('202 → 照会を打ち切った後も署名しない。「もう一度確かめる」は照会だけをして、成立なら成功になる', async () => {
    replies = [PENDING];
    const view = await mount();
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result?.pending).toBe(true));
    await waitFor(() => expect(view.result.current.isRecovering).toBe(false));
    // 打ち切り (既定の mock は unknown): 送信済みのまま・保持と枠も残る・error にはしない。
    expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true });
    expect(view.result.current.held).toBe('ambiguous');
    expect(view.result.current.error).toBeNull();
    expect(savedIntent()).not.toBeNull();
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);

    // 打ち切りの後に押しても、署名・POST・照会のどれも始めない。
    await pressMove(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);

    // 「もう一度確かめる」でまた分からなければ、そのまま。
    await act(async () => {
      view.result.current.recheck();
    });
    await waitFor(() => expect(view.result.current.isRecovering).toBe(false));
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(2);
    expect(view.result.current.result?.pending).toBe(true);
    expect(view.result.current.held).toBe('ambiguous');

    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    await act(async () => {
      view.result.current.recheck();
    });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(3);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view.result.current.held).toBeNull();
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'confirmed' });

    // 保持が無くなった後の「もう一度確かめる」は何もしない。
    await act(async () => {
      view.result.current.recheck();
    });
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(3);
  });

  it('応答不明で照会を打ち切った後も、「もう一度確かめる」で成立が分かれば成功になる (応答不明の error は出さない)', async () => {
    replies = [{ network: true }];
    const view = await mount();
    const first = await press(view);
    expect(isRelayResponseUnknownError(first.error)).toBe(true);
    await waitFor(() => expect(isRelayResponseUnknownError(view.result.current.error)).toBe(true));
    expect(view.result.current.held).toBe('ambiguous');

    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    await act(async () => {
      view.result.current.recheck();
    });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.held).toBeNull();
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('開き直した後の照会を打ち切った後も、「もう一度確かめる」で結果が分かる (成立 → 成功・期限切れ未使用 → 何も出さず入力へ)', async () => {
    const stored = JSON.stringify({
      version: 1,
      chainId: CHAIN,
      from: FROM,
      merchant: DEST,
      merchantValue: AMOUNT.toString(),
      feeValue: FEE.toString(),
      nonce: `0x${'c'.repeat(64)}`,
      validBefore: '9999999999',
      issuedAt: 1_700_000_000_000,
    });
    window.sessionStorage.setItem(SALES_MOVE_INTENT_STORAGE_KEY, stored);
    const settled = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await waitFor(() => expect(isRelayResponseUnknownError(settled.result.current.error)).toBe(true));
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    await act(async () => {
      settled.result.current.recheck();
    });
    await waitFor(() => expect(settled.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(settled.result.current.error).toBeNull();
    expect(savedIntent()).toBeNull();
    settled.unmount();

    window.sessionStorage.setItem(SALES_MOVE_INTENT_STORAGE_KEY, stored);
    const expired = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await waitFor(() => expect(isRelayResponseUnknownError(expired.result.current.error)).toBe(true));
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'expired' });
    await act(async () => {
      expired.result.current.recheck();
    });
    await waitFor(() => expect(expired.result.current.held).toBeNull());
    // 前の画面の移動の不成立を、新しい操作に持ち越さない (mount の照会と同じ)。
    expect(expired.result.current.result).toBeUndefined();
    expect(expired.result.current.error).toBeNull();
    expect(savedIntent()).toBeNull();
    expect(h.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('IP 制限の後の再送が 202 になったときも、同じ画面で照会して成功になる', async () => {
    replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '30' } }, PENDING];
    const view = await mount();
    await press(view);
    expect(view.result.current.held).toBe('retry');
    expect(h.resolveRelayIntent).not.toHaveBeenCalled();
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    const second = await press(view);
    expect(second.result).toEqual({ txHash: TX, success: false, pending: true });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(posted()).toHaveLength(2);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
  });

  it('IP 制限で保持している間の「もう一度確かめる」は何もしない (照会は送信済みかもしれない保持だけ)', async () => {
    replies = [{ status: 429, body: { error: 'ip_rate_limited' } }];
    const view = await mount();
    await press(view);
    expect(view.result.current.held).toBe('retry');
    await act(async () => {
      view.result.current.recheck();
    });
    expect(h.resolveRelayIntent).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // unmount の後の照会は、照会の部品を実物で通して tests/hooks/useSalesMove.statusContract.test.tsx が確かめる (sleep の間の
  // unmount で読むのをやめる・status の読み取りの途中の unmount でその fetch を取り消す・枠は残り開き直した画面が続きを読む)。

  it('StrictMode の mount→unmount→mount の後でも、202 の後の照会の結果が画面に届く', async () => {
    replies = [PENDING];
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    const effectRuns: string[] = [];
    const view = renderHook(
      () => {
        useEffect(() => {
          effectRuns.push('mount');
          return () => {
            effectRuns.push('unmount');
          };
        }, []);
        return useSalesMove(DEPLOYMENT, LABELS);
      },
      { wrapper: wrapper(), reactStrictMode: true },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

// 第 10 回レビュー D-4: 成立が確定した表示から、開き直さずに次の移動を始める (画面の「もう一度移す」)。
describe('useSalesMove: 成立の後の resetAfterSuccess (第 10 回レビュー D-4)', () => {
  const TX2: Hex = `0x${'b'.repeat(64)}`;
  const SIGNATURE2: Hex = `0x${'cd'.repeat(65)}`;
  const DEST2: Address = '0x2222222222222222222222222222222222222222';
  const PENDING: Reply = { status: 202, body: { ok: false, pending: true, txHash: TX } };
  const OK2: Reply = { status: 200, body: { ok: true, txHash: TX2 } };

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

  // 画面と同じ入口 (move)。成立・送信済みの後の守りを通す。
  async function pressMove(view: View, params = { destination: DEST, amount: AMOUNT }) {
    await act(async () => {
      view.result.current.move(params);
    });
  }

  async function resetAfterSuccess(view: View) {
    await act(async () => {
      view.result.current.resetAfterSuccess();
    });
  }

  it('成功 → resetAfterSuccess → 入力に戻り、次の move は新しい nonce・新しい署名で 1 回だけ POST する', async () => {
    replies = [{ status: 200, body: { ok: true, txHash: TX } }, OK2];
    h.signTypedData.mockResolvedValueOnce(SIGNATURE).mockResolvedValueOnce(SIGNATURE2);
    const view = await mount();
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    // 成立の表示のままでは、押しても送らない (今までどおり)。
    await pressMove(view, { destination: DEST2, amount: AMOUNT * 2n });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await resetAfterSuccess(view);
    expect(view.result.current.result).toBeUndefined();
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.held).toBeNull();
    expect(view.result.current.isPending).toBe(false);
    // 開け直しただけでは、署名も POST もしない。枠は成立の時点で消えたままで、成立の控えは残る。
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedIntent()).toBeNull();
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(loadPayerReceipts()[0]).toMatchObject({ txHash: TX, status: 'confirmed' });

    await pressMove(view, { destination: DEST2, amount: AMOUNT * 2n });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX2, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = posted();
    const nonce1 = h.signTypedData.mock.calls[0][0].message.nonce;
    const nonce2 = h.signTypedData.mock.calls[1][0].message.nonce;
    expect(nonce2).not.toBe(nonce1);
    expect(second.intentSalt).not.toBe(first.intentSalt);
    // 2 回目の POST は 2 回目の署名と入力だけ (前の署名・前の送り先・前の額を送らない)。
    expect(first.signature).toBe(SIGNATURE);
    expect(second).toMatchObject({ signature: SIGNATURE2, merchant: DEST2, merchantValue: (AMOUNT * 2n).toString() });
    // POST の時点の枠は、その移動の nonce。
    expect(JSON.parse(savedAtPost[1]!)).toMatchObject({ nonce: nonce2, merchant: DEST2 });
    expect(savedIntent()).toBeNull();
    expect(loadPayerReceipts().map((r) => r.txHash).sort()).toEqual([TX, TX2].sort());
  });

  // 開けるのは、返している result が success のときだけ。ほかの状態では、呼ばれても結果・エラー・保持・枠をそのまま残す。
  type Arrange = () => Promise<{ view: View; signs: number; posts: number }>;
  const NOT_SUCCESS: [string, Arrange][] = [
    [
      '202 pending (照会を打ち切った後)',
      async () => {
        replies = [PENDING];
        const view = await mount();
        await pressMove(view);
        await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true }));
        await waitFor(() => expect(view.result.current.isRecovering).toBe(false));
        expect(view.result.current.held).toBe('ambiguous');
        return { view, signs: 1, posts: 1 };
      },
    ],
    [
      '202 pending (照会の間)',
      async () => {
        replies = [PENDING];
        h.resolveRelayIntent.mockImplementationOnce(() => new Promise(() => undefined));
        const view = await mount();
        await pressMove(view);
        await waitFor(() => expect(view.result.current.result?.pending).toBe(true));
        expect(view.result.current.isRecovering).toBe(true);
        return { view, signs: 1, posts: 1 };
      },
    ],
    [
      '応答不明 (fetch の失敗)',
      async () => {
        replies = [{ network: true }];
        const view = await mount();
        await pressMove(view);
        await waitFor(() => expect(isRelayResponseUnknownError(view.result.current.error)).toBe(true));
        expect(view.result.current.held).toBe('ambiguous');
        return { view, signs: 1, posts: 1 };
      },
    ],
    [
      '開き直した枠が未解決',
      async () => {
        storeIntent();
        const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
        await waitFor(() => expect(isRelayResponseUnknownError(view.result.current.error)).toBe(true));
        expect(view.result.current.held).toBe('ambiguous');
        return { view, signs: 0, posts: 0 };
      },
    ],
    [
      'IP 制限で保持した再送待ち',
      async () => {
        replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '20' } }];
        const view = await mount();
        await pressMove(view);
        await waitFor(() => expect(isRelayIpRateLimitedError(view.result.current.error)).toBe(true));
        expect(view.result.current.held).toBe('retry');
        return { view, signs: 1, posts: 1 };
      },
    ],
    [
      '成立しなかった (revert)',
      async () => {
        replies = [{ status: 200, body: { ok: false, reverted: true, txHash: TX } }];
        const view = await mount();
        await pressMove(view);
        await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: false }));
        return { view, signs: 1, posts: 1 };
      },
    ],
    [
      'server の拒否 (signature_invalid)',
      async () => {
        replies = [{ status: 400, body: { ok: false, error: 'signature_invalid' } }];
        const view = await mount();
        await pressMove(view);
        await waitFor(() => expect(view.result.current.error?.message).toBe('signature_invalid'));
        return { view, signs: 1, posts: 1 };
      },
    ],
  ];

  it.each(NOT_SUCCESS)(
    '%s: resetAfterSuccess を呼んでも開かない (結果・エラー・保持・枠はそのまま・署名も POST もしない)',
    async (_name, arrange) => {
      const { view, signs, posts } = await arrange();
      const before = {
        result: view.result.current.result,
        error: view.result.current.error,
        held: view.result.current.held,
        isRecovering: view.result.current.isRecovering,
        slot: window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY),
        receipts: JSON.stringify(loadPayerReceipts()),
        recoveries: h.resolveRelayIntent.mock.calls.length,
      };
      await resetAfterSuccess(view);
      expect(view.result.current.result).toEqual(before.result);
      expect(view.result.current.error).toBe(before.error);
      expect(view.result.current.held).toBe(before.held);
      expect(view.result.current.isRecovering).toBe(before.isRecovering);
      expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBe(before.slot);
      expect(JSON.stringify(loadPayerReceipts())).toBe(before.receipts);
      expect(h.signTypedData).toHaveBeenCalledTimes(signs);
      expect(fetchMock).toHaveBeenCalledTimes(posts);
      expect(h.resolveRelayIntent).toHaveBeenCalledTimes(before.recoveries);
    },
  );

  it.each(NOT_SUCCESS.slice(0, 4))('%s: resetAfterSuccess の後に押しても、新しい署名は出ない', async (_name, arrange) => {
    const { view, signs, posts } = await arrange();
    await resetAfterSuccess(view);
    await pressMove(view, { destination: DEST2, amount: AMOUNT });
    expect(h.signTypedData).toHaveBeenCalledTimes(signs);
    expect(fetchMock).toHaveBeenCalledTimes(posts);
    expect(view.result.current.held).toBe('ambiguous');
    expect(savedIntent()).not.toBeNull();
  });

  it('202 → 照会で成立 (mutation の data は pending のまま) → resetAfterSuccess で入力に戻る (送信済みの表示に戻らない)', async () => {
    replies = [PENDING, OK2];
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    const view = await mount();
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    expect(view.result.current.held).toBeNull();
    expect(savedIntent()).toBeNull();

    await resetAfterSuccess(view);
    expect(view.result.current.result).toBeUndefined();
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.isPending).toBe(false);

    await pressMove(view, { destination: DEST2, amount: AMOUNT });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX2, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.signTypedData.mock.calls[1][0].message.nonce).not.toBe(h.signTypedData.mock.calls[0][0].message.nonce);
    // 照会は 1 回目の 202 の後の 1 本だけ (2 回目は 200 で確定)。
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
  });

  it('開き直したときの照会で成立 → resetAfterSuccess で入力に戻り、新しい署名で移せる (照会した枠の nonce は使わない)', async () => {
    storeIntent();
    h.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    replies = [OK2];
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    // 開け直す前は送らない。
    await pressMove(view);
    expect(h.signTypedData).not.toHaveBeenCalled();

    await resetAfterSuccess(view);
    expect(view.result.current.result).toBeUndefined();
    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX2, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.signTypedData.mock.calls[0][0].message.nonce).not.toBe(`0x${'c'.repeat(64)}`);
    expect(h.resolveRelayIntent).toHaveBeenCalledTimes(1);
  });

  it('成立の表示の後に moveAsync で始めた試みと同じ tick に呼ばれても、その試みの結果を画面から消さない', async () => {
    replies = [{ status: 200, body: { ok: true, txHash: TX } }, OK2];
    const view = await mount();
    await press(view);
    expect(view.result.current.result).toEqual({ txHash: TX, success: true });
    await act(async () => {
      const second = view.result.current.moveAsync({ destination: DEST2, amount: AMOUNT });
      // この時点では、画面はまだ 1 回目の成立を描いている (result は success)。試み中なので何もしない。
      view.result.current.resetAfterSuccess();
      await second;
    });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX2, success: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('StrictMode の mount→unmount→mount でも、resetAfterSuccess と再描画で前の署名は送られない。次の移動は新しい署名だけ', async () => {
    replies = [{ status: 200, body: { ok: true, txHash: TX } }, OK2];
    h.signTypedData.mockResolvedValueOnce(SIGNATURE).mockResolvedValueOnce(SIGNATURE2);
    const effectRuns: string[] = [];
    const view = renderHook(
      () => {
        useEffect(() => {
          effectRuns.push('mount');
          return () => {
            effectRuns.push('unmount');
          };
        }, []);
        return useSalesMove(DEPLOYMENT, LABELS);
      },
      { wrapper: wrapper(), reactStrictMode: true },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);

    await pressMove(view);
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX, success: true }));
    await resetAfterSuccess(view);
    expect(view.result.current.result).toBeUndefined();
    // 再描画しても、時間が経っても、署名・POST・照会・枠の書き込みは起きない。
    view.rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.resolveRelayIntent).not.toHaveBeenCalled();
    expect(savedIntent()).toBeNull();
    expect(view.result.current.result).toBeUndefined();

    await pressMove(view, { destination: DEST2, amount: AMOUNT });
    await waitFor(() => expect(view.result.current.result).toEqual({ txHash: TX2, success: true }));
    expect(h.signTypedData).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = posted();
    expect(first.signature).toBe(SIGNATURE);
    expect(second.signature).toBe(SIGNATURE2);
    expect(second.intentSalt).not.toBe(first.intentSalt);
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);
    view.unmount();
  });
});
