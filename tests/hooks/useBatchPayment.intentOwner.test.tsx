// 第 10 回レビュー PR-02 の Codex レビュー (P1)・money-path: 記録への「後からの書き込み」と「削除」は、storage にいま入って
// いる記録が同じ intent のときだけ行う (持ち主の確認)。
//
// 失敗シナリオ (直す前・Codex が本物の pimlicoIntent / pimlicoSend で再現した順番):
//   筋 1: 画面 1 が A を送って receipt を待つ間に離れる → 画面 2 が A の receipt を得て A を閉じる → 画面 3 が別の nonce の B を
//         送り、応答を失って B の記録が開いたまま → 画面 1 の receipt 待ちが失敗し、応答不明の書き込み (holdAsUnknown) が
//         B の記録を A で上書きする → reload は A を receipt で閉じ、B を知らない → B を払い直すと別の nonce で二重払い。
//   筋 2: 画面 1 の A の最初の送信への「検証で拒否」が遅れる → その間に画面 2 が同じ nonce で A を作り直して確定 → 画面 3 が
//         B を始めて応答を失う → 遅れて届いた拒否の片付け (c2 の key ごとの削除) が、mempool にある B の記録を消す。
//
// 「同じ intent」= 送信の控えのある記録は EntryPoint・sender・nonce (key と seq) が同じ (同じ nonce で作り直した op は hash が
// 違っても同じ intent)。控えの無い記録 (控えを足す前の記録・MAv2) は userOpHash が同じ。storage が空・別の intent・読めない
// ときは書かない・消さない (空のときに書くと、閉じた記録を復活させる)。
//
// mock は境界だけ: useSmartAccount が返す client・bundler の HTTP・EntryPoint の読み取り・receipt の照会
// (tests/_helpers/fakePimlicoBundler.ts)、wagmi、logger。hook と lib/smartAccount/pimlicoIntent.ts・pimlicoSend.ts は実物。
// 「世界」(bundler の mempool・EntryPoint の nonce) は test の間 1 つで、hook を mount し直しても残る。bundler の HTTP は
// その時点で最後に作った client の bundlerSend へ届く (送り始めた request は、送った時の bundlerSend が答える)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import { WaitForUserOperationReceiptTimeoutError } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import type { ReactNode } from 'react';
import {
  PIMLICO_PENDING_KEY_PREFIX,
  useBatchPayment,
} from '@/hooks/useBatchPayment';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

vi.mock('@/hooks/useSmartAccount', () => ({
  useSmartAccount: vi.fn(),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useWalletClient: vi.fn(() => ({ data: undefined })),
  usePublicClient: vi.fn(() => undefined),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useAccount } from 'wagmi';
import { logger } from '@/lib/logger';
import { mockHook } from '../_helpers/wagmiMock';
import {
  createFakeBundlerWorld,
  fakePimlicoClients,
  lostResponse,
  type BundlerHttpReply,
  type FakeBundlerWorld,
  type FakeReceipt,
} from '../_helpers/fakePimlicoBundler';

const usdcDep = defaultDeploymentForSymbol('usdc');
const TOKEN: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const FEE_RECV: Address = getAddress('0x2222222222222222222222222222222222222222');
const SEVEN_DAYS_AND_A_MINUTE = 7 * 24 * 60 * 60 * 1000 + 60_000;
const PAYMASTER_EXPIRED = { error: { code: -32500, message: 'AA32 paymaster expired or not due' } };

// 10 USDC の支払い (A)。
const PARAMS = {
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  merchantAmount: 10_000_000n,
  feeReceiver: FEE_RECV,
  feeAmount: 0n,
};
// 金額だけ違う別の支払い (B・20 USDC)。
const OTHER_PARAMS = { ...PARAMS, merchantAmount: 20_000_000n };

type GasPriceTier = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
const TIER: GasPriceTier = { maxFeePerGas: 50n * 10n ** 9n, maxPriorityFeePerGas: 1n };
type WaitForReceipt = (parameters: { hash: Hex }) => Promise<unknown>;

function pendingKeys(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index),
  ).filter(
    (key): key is string => key !== null && key.startsWith(PIMLICO_PENDING_KEY_PREFIX),
  );
}

// storage の記録 (文字列のまま)。「1 字も変わっていない」を比べる。
function storedRaw(): string | null {
  const keys = pendingKeys();
  if (keys.length === 0) return null;
  expect(keys).toHaveLength(1);
  return window.localStorage.getItem(keys[0]);
}

// 保存してから 7 日と 1 分たった記録にする。
function ageStoredRecord() {
  const key = pendingKeys()[0];
  const record = JSON.parse(window.localStorage.getItem(key) ?? '{}') as { updatedAt: number };
  window.localStorage.setItem(
    key,
    JSON.stringify({ ...record, updatedAt: Date.now() - SEVEN_DAYS_AND_A_MINUTE }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let world: FakeBundlerWorld;

// client を作り (mount のたびに作り直す)、useSmartAccount に載せる。前の hook を unmount してから呼ぶ
// (unmount した hook の mutation は、最後に描いた時の client を使い続ける)。
function mountClients(options?: { waitForUserOperationReceipt?: WaitForReceipt }) {
  const fake = fakePimlicoClients({
    world,
    getUserOperationGasPrice: async () => ({ slow: TIER, standard: TIER, fast: TIER }),
    waitForUserOperationReceipt: options?.waitForUserOperationReceipt,
  });
  mockHook(useSmartAccount, { data: fake.data, isLoading: false, error: null });
  mockHook(useAccount, { chainId: baseSepolia.id });
  return fake;
}

type Fake = ReturnType<typeof mountClients>;

// MAv2 (aa-sdk の facade・lib/smartAccount/mav2.ts の形): sendUserOperation しか無く、送信の控えの無い記録を書く。
function mountMav2(options: { hash: Hex; waitForUserOperationReceipt: WaitForReceipt }) {
  const sendUserOperation = vi.fn(async (_parameters: { calls: unknown[] }) => options.hash);
  mockHook(useSmartAccount, {
    data: {
      provider: 'pimlico',
      entryPointVersion: '0.7',
      smartAccountClient: { sendUserOperation },
      pimlicoClient: {
        waitForUserOperationReceipt: options.waitForUserOperationReceipt,
        getUserOperationGasPrice: async () => ({ slow: TIER, standard: TIER, fast: TIER }),
      },
      paymasterMode: 'sponsorship',
    },
    isLoading: false,
    error: null,
  } as never);
  mockHook(useAccount, { chainId: baseSepolia.id });
  return { sendUserOperation };
}

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

// hook を mount する。unmount の後の mutation (画面はもう無い) の終わり方は、QueryClient の MutationCache で見る。
function render() {
  const qc = newQueryClient();
  const hook = renderHook(() => useBatchPayment(usdcDep), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  const lastMutation = () => {
    const mutation = qc.getMutationCache().getAll().at(-1);
    if (!mutation) throw new Error('mutation が無い');
    return mutation.state;
  };
  return { ...hook, lastMutation };
}

type Hook = ReturnType<typeof render>;

async function settledMutation(hook: Hook) {
  await waitFor(() => expect(['success', 'error']).toContain(hook.lastMutation().status));
  return hook.lastMutation();
}

function sentOp(fake: Fake, index: number): Record<string, unknown> {
  return fake.bundlerSend.mock.calls[index][0].params[0];
}

// bundler が受理し、すぐ mine される (receipt が取れる)。
function acceptAndMine(fake: Fake) {
  fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
    const hash = world.accept(params[0]);
    world.mine(hash);
    return { result: hash };
  });
}

// bundler が op を受理した後、応答だけが失われる (op は mempool に残る)。
function acceptThenLoseResponse(fake: Fake) {
  fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
    world.accept(params[0]);
    throw lostResponse();
  });
}

// op が bundler に届かないまま応答が無い。
function loseRequest(fake: Fake) {
  fake.bundlerSend.mockImplementationOnce(async () => {
    throw lostResponse();
  });
}

// bundler が op を受け取らずに答える (world は触らない)。
function replyOnce(fake: Fake, reply: BundlerHttpReply) {
  fake.bundlerSend.mockImplementationOnce(async () => reply);
}

// 画面 (新しい hook) で B (別の内容・別の nonce) を送る。受理されたが応答を失い、B の記録が開いたまま。
async function openOtherIntent(fake: Fake, hook: Hook) {
  acceptThenLoseResponse(fake);
  hook.result.current.mutate(OTHER_PARAMS);
  await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
  await waitFor(() => expect(hook.result.current.isPending).toBe(false));
  const raw = storedRaw();
  expect(raw).not.toBeNull();
  const [hash] = world.mempoolHashes();
  return { raw, hash };
}

// reload: 画面は B を確かめる。B が mine された後、お客様が B を払い直しても新しい nonce を採らず、B は 1 回だけ成立する。
async function reloadPaysOtherOnce(bHash: Hex) {
  const fake = mountClients();
  const hook = render();
  await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
  expect(hook.result.current.pendingUserOpHash).toBe(bHash);
  world.mine(bHash);
  hook.result.current.mutate(OTHER_PARAMS);
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(fake.getNonce).not.toHaveBeenCalled();
  expect(fake.signUserOperation).not.toHaveBeenCalled();
  expect(world.mined.filter((op) => op.hash === bHash)).toHaveLength(1);
  expect(world.mempoolHashes()).toHaveLength(0);
  expect(pendingKeys()).toHaveLength(0);
}

// 画面 1 が A を送り (受理)、receipt を待つ間に離れる。receipt 待ちは test が止めておき、後で終わらせる。
async function sendAndLeaveWhileWaiting() {
  const receiptWait = deferred<FakeReceipt>();
  const firstWait = vi.fn((_parameters: { hash: Hex }) => receiptWait.promise);
  mountClients({ waitForUserOperationReceipt: firstWait });
  const firstHook = render();
  firstHook.result.current.mutate(PARAMS);
  await waitFor(() => expect(firstWait).toHaveBeenCalledTimes(1));
  const [aHash] = world.mempoolHashes();
  firstHook.unmount();
  return { firstHook, receiptWait, aHash };
}

// 画面 2: 保存された A を確かめ、receipt で閉じる (記録は消える)。
async function closeByReceipt() {
  mountClients();
  const hook = render();
  await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
  hook.result.current.retryReceipt();
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(pendingKeys()).toHaveLength(0);
  hook.unmount();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  world = createFakeBundlerWorld({ chainId: baseSepolia.id });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('筋 1: 送った後の応答不明の書き込み (holdAsUnknown) は、同じ intent の記録だけを書く', () => {
  it.each([
    { label: '失敗する (応答不明)', fails: true },
    { label: '成功する (A の receipt)', fails: false },
  ])(
    '画面 1 が A の receipt を待つ間に、画面 2 が A を閉じ、画面 3 の B が応答を失って開いている → 画面 1 の receipt 待ちが$label → B の記録はそのまま。reload の後も B を確かめ、B は 1 回だけ成立する (Codex の再現)',
    async ({ fails }) => {
      const { firstHook, receiptWait, aHash } = await sendAndLeaveWhileWaiting();
      world.mine(aHash);
      await closeByReceipt();

      const third = mountClients();
      const thirdHook = render();
      const other = await openOtherIntent(third, thirdHook);
      expect(other.hash).not.toBe(aHash);
      thirdHook.unmount();
      vi.mocked(logger.warn).mockClear();

      // 直す前: 失敗のとき、A を応答不明として書き、B の記録を上書きした (reload は A を閉じ、B を知らない)。
      if (fails) receiptWait.reject(new WaitForUserOperationReceiptTimeoutError({ hash: aHash }));
      else receiptWait.resolve(world.receiptOf(aHash) as FakeReceipt);
      const ended = await settledMutation(firstHook);

      expect(storedRaw()).toBe(other.raw);
      // 終わり方は今までどおり (失敗 = 応答不明・成功 = A の確定)。
      expect(ended.status).toBe(fails ? 'error' : 'success');
      if (fails) {
        expect(ended.error?.message).toBe('response-unknown');
        expect(logger.warn).toHaveBeenCalledWith(
          'pimlico.pending.not-owner',
          expect.objectContaining({ userOpHash: aHash, stored: 'other' }),
        );
      }

      await reloadPaysOtherOnce(other.hash);
      expect(world.mined.map((op) => op.hash)).toEqual([aHash, other.hash]);
    },
  );

  it('画面 1 の receipt 待ちの失敗が、ほかの画面が A を閉じた後に届いても、閉じた記録を書き戻さない (空のときは書かない)', async () => {
    const { firstHook, receiptWait, aHash } = await sendAndLeaveWhileWaiting();
    world.mine(aHash);
    await closeByReceipt();

    // 直す前: 終わった A の記録が復活し、次に開いた画面が応答不明で止まった。
    receiptWait.reject(new WaitForUserOperationReceiptTimeoutError({ hash: aHash }));
    const ended = await settledMutation(firstHook);

    expect(pendingKeys()).toHaveLength(0);
    expect(ended.error?.message).toBe('response-unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      'pimlico.pending.not-owner',
      expect.objectContaining({ userOpHash: aHash, stored: 'none' }),
    );
    mountClients();
    const next = render();
    expect(next.result.current.isUnknown).toBe(false);
  });
});

describe('筋 2: 最初の送信の拒否の片付け (c2) は、同じ intent の記録だけを消す', () => {
  it.each([
    { label: '画面 3 の B が応答を失って開いている', withOther: true },
    { label: 'ほかに開いている支払いが無い', withOther: false },
  ])(
    'A の最初の送信への拒否が遅れる間に、画面 2 が同じ nonce で A を作り直して確定し、$label → 遅れて届いた拒否は別の intent の記録を消さない・消す記録が無ければ閉じた扱い (Codex の再現)',
    async ({ withOther }) => {
      // 画面 1: A を保存して送る。bundler は受け付けず、その答え (検証で拒否) が遅れる。
      const first = mountClients();
      const rejection = deferred<BundlerHttpReply>();
      first.bundlerSend.mockImplementationOnce(() => rejection.promise);
      const firstHook = render();
      firstHook.result.current.mutate(PARAMS);
      await waitFor(() => expect(first.bundlerSend).toHaveBeenCalledTimes(1));
      expect(pendingKeys()).toHaveLength(1);
      const aNonce = sentOp(first, 0).nonce;
      firstHook.unmount();

      // 画面 2: A を確かめる → 送り直しを bundler が検証で拒否 → 同じ nonce で作り直す → 受理・mine → 確定 (記録は消える)。
      const second = mountClients();
      replyOnce(second, PAYMASTER_EXPIRED);
      acceptAndMine(second);
      const secondHook = render();
      await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
      secondHook.result.current.retryReceipt();
      await waitFor(() => expect(secondHook.result.current.isSuccess).toBe(true));
      expect(sentOp(second, 1).nonce).toBe(aNonce);
      expect(world.mined).toHaveLength(1);
      expect(pendingKeys()).toHaveLength(0);
      secondHook.unmount();

      let other: { raw: string | null; hash: Hex } | null = null;
      if (withOther) {
        const third = mountClients();
        const thirdHook = render();
        other = await openOtherIntent(third, thirdHook);
        thirdHook.unmount();
      }

      // A の最初の送信への拒否が今ごろ届く。直す前: 片付けの key ごとの削除が、mempool にある B の記録を消した。
      rejection.resolve(PAYMASTER_EXPIRED);
      const ended = await settledMutation(firstHook);

      expect(storedRaw()).toBe(other?.raw ?? null);
      expect(ended.status).toBe('error');
      if (other) {
        // 別の intent の記録が入っている: 閉じたとは伝えない (応答不明で終える)。B は mempool にあるまま。
        expect(ended.error?.message).toBe('response-unknown');
        expect(world.mempoolHashes()).toEqual([other.hash]);
        await reloadPaysOtherOnce(other.hash);
      } else {
        // 消す記録がもう無い (ほかの画面が閉じた): 今までどおり閉じた扱い (検証の拒否の error)。
        expect(ended.error?.name).toBe('UserOperationExecutionError');
      }
    },
  );
});

describe('hash の直し (bundler の返した hash で記録を直す) は、同じ intent の記録だけを直す', () => {
  it.each([
    { label: 'ほかの画面が A を閉じて空', withOther: false },
    { label: 'ほかの画面の B が開いている', withOther: true },
  ])(
    'A の送信への答え (計算と違う hash) が遅れる間に $label → 遅れて届いた hash で記録を書かない',
    async ({ withOther }) => {
      // 画面 1: A を送る。bundler は受理したが、答え (計算と違う hash) が遅れる。receipt 待ちは止めておく。
      const answer = deferred<void>();
      const receiptWait = deferred<FakeReceipt>();
      const firstWait = vi.fn((_parameters: { hash: Hex }) => receiptWait.promise);
      const first = mountClients({ waitForUserOperationReceipt: firstWait });
      const returned = `0x${'e'.repeat(64)}` as Hex;
      first.bundlerSend.mockImplementationOnce(async ({ params }) => {
        world.accept(params[0]);
        await answer.promise;
        return { result: returned };
      });
      const firstHook = render();
      firstHook.result.current.mutate(PARAMS);
      await waitFor(() => expect(first.bundlerSend).toHaveBeenCalledTimes(1));
      firstHook.unmount();

      // A が mine される (receipt は計算した hash に付く)。画面 2 がその receipt で A を閉じる。
      const [aHash] = world.mempoolHashes();
      world.mine(aHash);
      await closeByReceipt();
      let expected: string | null = null;
      if (withOther) {
        const third = mountClients();
        const thirdHook = render();
        expected = (await openOtherIntent(third, thirdHook)).raw;
        thirdHook.unmount();
      }

      // 答えが届く → hash の直し → receipt 待ち。直す前: 閉じた A を復活させる・B の記録を A で上書きする。
      answer.resolve();
      await waitFor(() => expect(firstWait).toHaveBeenCalledTimes(1));
      expect(firstWait).toHaveBeenCalledWith({ hash: returned });
      expect(storedRaw()).toBe(expected);

      // 返った hash の receipt は引けない → 応答不明で終える (書かない)。
      receiptWait.reject(new WaitForUserOperationReceiptTimeoutError({ hash: returned }));
      const ended = await settledMutation(firstHook);
      expect(ended.error?.message).toBe('response-unknown');
      expect(storedRaw()).toBe(expected);
    },
  );
});

describe('期限で閉じる削除 (c4・c5) は、同じ intent の記録だけを消す', () => {
  it('期限を過ぎた A を確かめる間に、別のタブが A を閉じて B を始めた → このタブの期限の片付けは B の記録を消さず、閉じたとも伝えない', async () => {
    const seedFake = mountClients();
    loseRequest(seedFake);
    const seed = render();
    seed.result.current.mutate(PARAMS);
    await waitFor(() => expect(seed.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(seed.result.current.isPending).toBe(false));
    seed.unmount();
    ageStoredRecord();

    // タブ 1 とタブ 2 が同時に開いている (どちらも画面にある = mount 中)。タブ 1 は EntryPoint の nonce の読み取りを待つ。
    const fake = mountClients();
    const nonceRead = deferred<bigint>();
    fake.readContract.mockImplementationOnce(() => nonceRead.promise);
    const tab1 = render();
    const tab2 = render();
    await waitFor(() => expect(tab1.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(tab2.result.current.isUnknown).toBe(true));
    tab1.result.current.retryReceipt();
    await waitFor(() => expect(fake.readContract).toHaveBeenCalledTimes(1));

    // タブ 2: 同じ A を期限で閉じ (c4)、B を送る。受理されたが応答を失い、B の記録が開いたまま。
    tab2.result.current.retryReceipt();
    await waitFor(() => expect(tab2.result.current.isUnknown).toBe(false));
    await waitFor(() => expect(tab2.result.current.isPending).toBe(false));
    expect(pendingKeys()).toHaveLength(0);
    const other = await openOtherIntent(fake, tab2);
    vi.mocked(logger.warn).mockClear();

    // タブ 1 の読み取りが返る (未使用・期限切れ)。直す前: key ごとの削除が B の記録を消し、閉じたと伝えた。
    nonceRead.resolve(0n);
    await waitFor(() => expect(tab1.result.current.isPending).toBe(false));

    expect(storedRaw()).toBe(other.raw);
    expect(tab1.result.current.isUnknown).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith('pimlico.pending.expired-closed', expect.anything());
    expect(logger.warn).toHaveBeenCalledWith('pimlico.pending.expired-close-failed', expect.anything());
    expect(tab2.result.current.isUnknown).toBe(true);
  });
});

describe('確定の片付け (settle) は、同じ intent なら hash が変わっていても閉じる', () => {
  it('画面 1 が A の receipt を待つ間に、画面 2 が同じ nonce で作り直して開いたまま → A が mine され、画面 1 が A の receipt を得る → 作り直しの記録 (別の hash) も閉じる', async () => {
    const { firstHook, receiptWait, aHash } = await sendAndLeaveWhileWaiting();

    // 画面 2: A を確かめる → 送り直しを bundler が検証で拒否 → 同じ nonce で作り直す → mempool の A とぶつかって断られる (c3) →
    // 作り直した op の記録 (別の hash・前の候補に A) のまま開いたまま。
    const second = mountClients();
    replyOnce(second, PAYMASTER_EXPIRED);
    // 作り直しの準備は fee が違う (client を作り直すと偽物の fee の数え方も最初からなので、そのままだと A と同じ op になる)。
    const prepare = second.prepareUserOperation.getMockImplementation();
    if (!prepare) throw new Error('準備の偽物が無い');
    second.prepareUserOperation.mockImplementationOnce(async (parameters) => ({
      ...(await prepare(parameters)),
      maxFeePerGas: TIER.maxFeePerGas + 100n,
    }));
    const secondHook = render();
    await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
    secondHook.result.current.retryReceipt();
    await waitFor(() => expect(second.bundlerSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(secondHook.result.current.isPending).toBe(false));
    const rebuilt = JSON.parse(storedRaw() ?? 'null') as {
      userOpHash: Hex;
      send: { priorUserOpHashes?: Hex[] };
    };
    expect(rebuilt.userOpHash).not.toBe(aHash);
    expect(rebuilt.send.priorUserOpHashes).toEqual([aHash]);
    secondHook.unmount();

    // 直す前: hash だけで比べるので片付けず、終わった支払いの記録が残った (次の画面が応答不明で止まる)。
    world.mine(aHash);
    receiptWait.resolve(world.receiptOf(aHash) as FakeReceipt);
    const ended = await settledMutation(firstHook);

    expect(ended.status).toBe('success');
    expect(pendingKeys()).toHaveLength(0);
    mountClients();
    const next = render();
    expect(next.result.current.isUnknown).toBe(false);
  });
});

// 記録の書き込みと読み戻しの間に、別のタブの書き込みが入る (同じタブの中では、その間に JS は走らない)。nth 回目の記録の
// 書き込みの直後に、別のタブが B の記録 (別の nonce) を書く・記録を消す。
function anotherTabWritesAfter(nth: number, mode: 'other' | 'removed') {
  const realSet = Storage.prototype.setItem;
  const realRemove = Storage.prototype.removeItem;
  const state: { writes: number; otherRaw: string | null } = { writes: 0, otherRaw: null };
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    realSet.call(this, key, value);
    if (!key.startsWith(PIMLICO_PENDING_KEY_PREFIX) || ++state.writes !== nth) return;
    if (mode === 'removed') {
      realRemove.call(this, key);
      return;
    }
    const mine = JSON.parse(value) as { send: Record<string, unknown> };
    state.otherRaw = JSON.stringify({
      ...mine,
      userOpHash: `0x${'d'.repeat(64)}`,
      send: { ...mine.send, nonceKey: '42' },
    });
    realSet.call(this, key, state.otherRaw);
  });
  return state;
}

describe('保存を確かめられない op の片付け (onNotStored) も、同じ intent の記録だけを消す・書き戻す', () => {
  it('新しい支払いの保存の読み戻しの前に、別のタブが B の記録を書いた → 書いたかもしれない記録の片付けで B を消さない (送らずに開いたまま)', async () => {
    const fake = mountClients();
    const tab = anotherTabWritesAfter(1, 'other');
    const hook = render();

    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));

    // 直す前: key ごとの削除が B の記録を消し、「保存できません」(通常決済は開く) で終えた。
    expect(storedRaw()).toBe(tab.otherRaw);
    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(hook.result.current.pendingStoreUnavailable).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.pending.persist-unverified', expect.anything());
  });

  it.each([
    { label: 'B の記録を書いた', mode: 'other' as const },
    { label: '記録を閉じた (消した)', mode: 'removed' as const },
  ])(
    '作り直しの保存の読み戻しの前に、別のタブが$label → 元の記録を書き戻さない (送らずに開いたまま)',
    async ({ mode }) => {
      const fake = mountClients();
      loseRequest(fake);
      const hook = render();
      hook.result.current.mutate(PARAMS);
      await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
      await waitFor(() => expect(hook.result.current.isPending).toBe(false));

      // 確かめる → 送り直し (送る時刻の書き込み = 1 回目) を bundler が検証で拒否 → 同じ nonce で作り直す (書き込み = 2 回目)。
      replyOnce(fake, PAYMASTER_EXPIRED);
      const tab = anotherTabWritesAfter(2, mode);
      hook.result.current.retryReceipt();
      await waitFor(() => expect(fake.signUserOperation).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(hook.result.current.isPending).toBe(false));

      // 直す前: 元の記録を key ごとに書き戻し、B の記録を上書きする・閉じた記録を復活させる。
      expect(storedRaw()).toBe(tab.otherRaw);
      expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
      expect(hook.result.current.isUnknown).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith('pimlico.pending.persist-unverified', expect.anything());
    },
  );
});

describe('控えの無い記録 (MAv2) の receipt 待ちの失敗 (hook) も、同じ記録 (hash) のときだけ書く', () => {
  const H1 = `0x${'a'.repeat(64)}` as Hex;
  const H2 = `0x${'c'.repeat(64)}` as Hex;
  const RECEIPT: FakeReceipt = {
    success: true,
    actualGasCost: 1_000n,
    receipt: { transactionHash: `0x${'b'.repeat(64)}` as Hex, blockNumber: 12345n },
  };

  it.each([
    { label: '閉じて空', withOther: false },
    { label: '別の支払いが開いている', withOther: true },
  ])(
    '画面 1 の receipt 待ちが、画面 2 が記録を閉じた後に失敗する ($label) → 書き戻さない・上書きしない',
    async ({ withOther }) => {
      const receiptWait = deferred<never>();
      mountMav2({ hash: H1, waitForUserOperationReceipt: () => receiptWait.promise });
      const firstHook = render();
      firstHook.result.current.mutate(PARAMS);
      await waitFor(() => expect(pendingKeys()).toHaveLength(1));
      firstHook.unmount();

      // 画面 2: H1 の記録を確かめて receipt で閉じる。別の支払いは H2 を返し、その receipt は引けない (応答不明)。
      mountMav2({
        hash: H2,
        waitForUserOperationReceipt: async ({ hash }) => {
          if (hash === H1) return RECEIPT;
          throw new WaitForUserOperationReceiptTimeoutError({ hash });
        },
      });
      const secondHook = render();
      await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
      secondHook.result.current.retryReceipt();
      await waitFor(() => expect(secondHook.result.current.isSuccess).toBe(true));
      expect(pendingKeys()).toHaveLength(0);
      let expected: string | null = null;
      if (withOther) {
        secondHook.result.current.mutate(OTHER_PARAMS);
        await waitFor(() => expect(secondHook.result.current.pendingUserOpHash).toBe(H2));
        await waitFor(() => expect(secondHook.result.current.isPending).toBe(false));
        expected = storedRaw();
        expect(expected).not.toBeNull();
      }
      secondHook.unmount();

      // 直す前: 画面 1 が H1 を応答不明として書き、閉じた記録を復活させる・H2 の記録を上書きする。
      receiptWait.reject(new WaitForUserOperationReceiptTimeoutError({ hash: H1 }));
      const ended = await settledMutation(firstHook);

      expect(storedRaw()).toBe(expected);
      expect(ended.error?.message).toBe('response-unknown');
    },
  );
});
