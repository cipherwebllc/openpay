// hooks/useSalesMove の照会を、/api/relay/jpyc/status の実際の応答の約束で通す (照会の部品 lib/relay/relayIntentRecovery は実物・
// fetch の境界だけを差し替える・Codex SHOULD・PR #1040)。
//
// status route (app/api/relay/jpyc/status/route.ts) の約束:
//   - authorization が未使用でも、冪等の記録 (relay:idem: の hash・IDEM_TTL_SEC = 1,800 秒) がある間は indeterminate を返す
//     (送信済みの tx が後から revert しても、置換・再送と区別できないので unused を新しい署名の許可に使わない)。
//   - revert した receipt は成立の証拠にしない (settled を返さない)。
//   - 記録が消えた後は unused。署名の期限が分かるときだけ、期限切れ未使用の証明 expiry: 'expired' / まだ期限前 'live' を付ける。
// hook は indeterminate の間はロック (再署名しない) のまま。解除は「連続 2 回の unused で、最新の応答が expiry: 'expired'」
// (照会の部品 lib/relay/relayIntentRecovery.ts の規則・indeterminate と応答なしは連続の数を 0 に戻す) か、成立の証明 (settled)
// だけ。1 回の revert を理由に解除しない (受容した限界・hook の冒頭のコメント)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import ja from '@/messages/ja.json';
import { renderWithIntl } from '../_helpers/i18n';

const FROM: Address = '0x9999999999999999999999999999999999999999';
const DEST: Address = '0x1111111111111111111111111111111111111111';
const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`;
const TX: Hex = `0x${'a'.repeat(64)}`;
const STORED_NONCE: Hex = `0x${'c'.repeat(64)}`;

const h = vi.hoisted(() => {
  const signTypedData = vi.fn();
  const readContract = vi.fn();
  return {
    signTypedData,
    readContract,
    walletClient: { data: { signTypedData } },
    publicClient: { readContract, getCode: vi.fn(), waitForTransactionReceipt: vi.fn() },
    account: { address: '0x9999999999999999999999999999999999999999', chainId: 80002, isConnected: true, connector: undefined },
    balance: { data: 100n * 10n ** 18n, isError: false },
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useWalletClient: () => h.walletClient,
  usePublicClient: () => h.publicClient,
  useReadContract: () => h.balance,
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null, variables: undefined }),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableSalesMove: true, enableJpycEip3009: true } };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => '0x5555555555555555555555555555555555555555' };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useSalesMove, SALES_MOVE_RELAY_URL } from '@/hooks/useSalesMove';
import { SalesMoveForm } from '@/components/SalesMoveForm';
import { SALES_MOVE_INTENT_STORAGE_KEY } from '@/lib/paymentIntentStorage';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { isRelayResponseUnknownError } from '@/lib/relay/relayResponseError';

const DEPLOYMENT = defaultDeploymentForSymbol('jpyc');
const CHAIN = DEPLOYMENT.chainId;
const FEE = relayGasFeeValue(CHAIN);
const AMOUNT = 5n * 10n ** 18n;
const LABELS = { delivered: '届く額', fee: '利用料', locale: 'ja' };
const STATUS_URL = '/api/relay/jpyc/status';
// 照会の部品の締め切り (90 秒) を越えるだけ進める。
const PAST_DEADLINE_MS = 100_000;

const INDETERMINATE = { ok: true, state: 'indeterminate' };
const UNUSED_EXPIRED = { ok: true, state: 'unused', expiry: 'expired' };
const UNUSED_LIVE = { ok: true, state: 'unused', expiry: 'live' };

let moveReplies: { status: number; body: unknown }[] = [];
let statusQueue: unknown[] = [];
let statusDefault: unknown = INDETERMINATE;
let statusBodies: Record<string, unknown>[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === STATUS_URL) {
    statusBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(statusQueue.length > 0 ? statusQueue.shift() : statusDefault), { status: 200 });
  }
  if (url === SALES_MOVE_RELAY_URL) {
    const reply = moveReplies.shift() ?? { status: 200, body: { ok: true, txHash: TX } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }
  throw new Error(`想定外の fetch: ${url}`);
});

const movePosts = () => fetchMock.mock.calls.filter(([input]) => String(input) === SALES_MOVE_RELAY_URL).length;
const savedIntent = () => window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY);

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
      nonce: STORED_NONCE,
      validBefore: '1700000300',
      issuedAt: 1_700_000_000_000,
    }),
  );
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// 押して、照会の締め切りまで時間を進めてから結果を読む (fake timers の下では act の中で promise を待たない)。
async function pressAndWait(view: { result: { current: ReturnType<typeof useSalesMove> } }) {
  let outcome: Promise<{ result?: unknown; error?: unknown }> = Promise.resolve({});
  act(() => {
    outcome = view.result.current
      .moveAsync({ destination: DEST, amount: AMOUNT })
      .then((result) => ({ result }), (error: unknown) => ({ error }));
  });
  await advance(PAST_DEADLINE_MS);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
  moveReplies = [];
  statusQueue = [];
  statusDefault = INDETERMINATE;
  statusBodies = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  h.signTypedData.mockResolvedValue(SIGNATURE);
  h.readContract.mockResolvedValue(1_000n * 10n ** 18n);
  h.publicClient.getCode.mockResolvedValue(undefined);
  h.publicClient.waitForTransactionReceipt.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSalesMove × status route の約束', () => {
  it('202 pending の後の照会: 冪等の記録がある間 (indeterminate) は送信済みのまま、押しても再署名・再 POST しない', async () => {
    moveReplies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    const first = await pressAndWait(view);
    expect(first.result).toEqual({ txHash: TX, success: false, pending: true });
    // 202 の後、同じ画面でも照会の部品が締め切りまで読み続けた (3・9・21・45・90 秒の 5 回・第 10 回レビュー G-2)。
    // indeterminate のままなので、結果は送信済み (pending) のまま。
    expect(statusBodies).toHaveLength(5);
    expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true });
    expect(view.result.current.isRecovering).toBe(false);

    const second = await pressAndWait(view);
    expect(isRelayResponseUnknownError(second.error)).toBe(true);
    // 押した分の照会がもう 5 回 (G-2 より前は、ここが最初の照会で合計 5 回だった)。中身は nonce の照会 (recover の形の公開 metadata)。
    expect(statusBodies).toHaveLength(10);
    expect(statusBodies[0]).toEqual({
      lookup: 'nonce',
      chainId: CHAIN,
      from: FROM,
      nonce: h.signTypedData.mock.calls[0][0].message.nonce,
      validBefore: h.signTypedData.mock.calls[0][0].message.validBefore.toString(),
    });
    expect(view.result.current.held).toBe('ambiguous');
    expect(savedIntent()).not.toBeNull();

    await pressAndWait(view);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(movePosts()).toBe(1);
    view.unmount();
  });

  it('202 pending の後、status が settled を返したら、押さず・開き直さずに成功になる (第 10 回レビュー G-2)', async () => {
    moveReplies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    statusQueue = [INDETERMINATE, { ok: true, state: 'settled', txHash: TX }];
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    act(() => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
    });
    await advance(0);
    expect(view.result.current.result).toEqual({ txHash: TX, success: false, pending: true });
    expect(view.result.current.isRecovering).toBe(true);
    expect(statusBodies).toHaveLength(0);

    // 1 回目の照会 (3 秒後) は indeterminate: 送信済みのまま。
    await advance(3_000);
    expect(statusBodies).toHaveLength(1);
    expect(view.result.current.result?.pending).toBe(true);

    // 2 回目の照会 (さらに 6 秒後) で成立: receipt を確かめて成功へ。
    await advance(6_000);
    expect(statusBodies).toHaveLength(2);
    expect(statusBodies[1]).toEqual({
      lookup: 'nonce',
      chainId: CHAIN,
      from: FROM,
      nonce: h.signTypedData.mock.calls[0][0].message.nonce,
      validBefore: h.signTypedData.mock.calls[0][0].message.validBefore.toString(),
    });
    expect(h.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: TX }));
    expect(view.result.current.result).toEqual({ txHash: TX, success: true });
    expect(view.result.current.isRecovering).toBe(false);
    expect(view.result.current.held).toBeNull();
    expect(savedIntent()).toBeNull();
    // 終端の後は読まない。署名・POST は最初の 1 回だけ。
    await advance(PAST_DEADLINE_MS);
    expect(statusBodies).toHaveLength(2);
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(movePosts()).toBe(1);
    view.unmount();
  });

  it('202 pending の後の照会の間に unmount したら、照会をやめる。枠は残り、開き直した画面が続きを照会する', async () => {
    moveReplies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    act(() => {
      view.result.current.move({ destination: DEST, amount: AMOUNT });
    });
    await advance(3_000);
    expect(statusBodies).toHaveLength(1);
    view.unmount();
    await advance(PAST_DEADLINE_MS);
    expect(statusBodies).toHaveLength(1);
    expect(savedIntent()).not.toBeNull();

    statusDefault = { ok: true, state: 'settled', txHash: TX };
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    const reopened = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await advance(3_000);
    expect(reopened.result.current.result).toEqual({ txHash: TX, success: true });
    expect(savedIntent()).toBeNull();
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    expect(movePosts()).toBe(1);
    reopened.unmount();
  });

  it('開き直したとき: indeterminate の間はロックのまま。記録が消えて期限切れ未使用が証明されたら入力に戻り、新しい署名を許す', async () => {
    storeIntent();
    const locked = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await advance(PAST_DEADLINE_MS);
    expect(locked.result.current.held).toBe('ambiguous');
    expect(isRelayResponseUnknownError(locked.result.current.error)).toBe(true);
    expect(savedIntent()).not.toBeNull();
    expect(statusBodies.every((b) => b.nonce === STORED_NONCE)).toBe(true);
    locked.unmount();

    // 冪等の記録が消えた後 (status は unused・署名の期限切れをチェーンで証明)。
    statusDefault = UNUSED_EXPIRED;
    const unlocked = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await advance(PAST_DEADLINE_MS);
    expect(unlocked.result.current.held).toBeNull();
    expect(unlocked.result.current.error).toBeNull();
    expect(unlocked.result.current.result).toBeUndefined();
    expect(savedIntent()).toBeNull();

    const fresh = await pressAndWait(unlocked);
    expect(fresh.result).toEqual({ txHash: TX, success: true });
    expect(h.signTypedData).toHaveBeenCalledTimes(1);
    unlocked.unmount();
  });

  it('unused でも署名がまだ期限前 (expiry: live) ならロックのまま', async () => {
    storeIntent();
    statusDefault = UNUSED_LIVE;
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await advance(PAST_DEADLINE_MS);
    expect(view.result.current.held).toBe('ambiguous');
    expect(savedIntent()).not.toBeNull();
    view.unmount();
  });

  it('期限切れ未使用が 1 回だけ (次が indeterminate) なら解除しない (連続 2 回が要る)', async () => {
    storeIntent();
    statusQueue = [UNUSED_EXPIRED, INDETERMINATE, UNUSED_EXPIRED, INDETERMINATE];
    statusDefault = INDETERMINATE;
    const view = renderHook(() => useSalesMove(DEPLOYMENT, LABELS), { wrapper: wrapper() });
    await advance(PAST_DEADLINE_MS);
    expect(view.result.current.held).toBe('ambiguous');
    expect(savedIntent()).not.toBeNull();
    view.unmount();
  });
});

describe('SalesMoveForm × status route の約束', () => {
  const m = ja.Create.salesMove;

  function renderForm() {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    return renderWithIntl(
      <QueryClientProvider client={qc}>
        <SalesMoveForm />
      </QueryClientProvider>,
    );
  }

  it('indeterminate の間は「送信済み・確定待ち」のまま入力を出さず、期限切れ未使用の証明の後に入力を出す', async () => {
    storeIntent();
    const locked = renderForm();
    await advance(PAST_DEADLINE_MS);
    expect(screen.getByText(m.pending)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.destinationLabel)).toBeNull();
    expect(screen.queryByRole('button', { name: m.signButton })).toBeNull();
    locked.unmount();

    statusDefault = UNUSED_EXPIRED;
    renderForm();
    await advance(PAST_DEADLINE_MS);
    expect(screen.queryByText(m.pending)).toBeNull();
    expect(screen.getByLabelText(m.destinationLabel)).toBeInTheDocument();
    expect(h.signTypedData).not.toHaveBeenCalled();
  });
});
