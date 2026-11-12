// 第 10 回レビュー A-2 (P2)・A-3 (P3)・money-path: Pimlico の経路の「画面を離れた試み」と「同じ tick の二度押し」。
//
// A-2 の失敗シナリオ (直す前): ウォレットの署名を待つ間に画面を離れる (hook が unmount する)。react-query の mutation は
// unmount の後も走る。開き直した画面 (新しい hook) は記録が無いので新しい支払いを通す。ウォレットに残った古い署名の要求を
// 承認すると、古い試みが別の nonce の UserOperation を保存して送り、両方成立する。
// A-3 の失敗シナリオ (直す前): 同じ tick に mutate が 2 回 → mutation が 2 つでき、署名の要求が 2 つ出る。
//
// 直した後の原則は 1 つ: 失効した試み (unmount した hook の instance) は、新しい効果を始めない (署名を求めない・storage を
// 書かない・消さない・bundler へ渡さない)。すでに bundler へ渡した op の後始末は変えない。
//
// mock は境界だけ: useSmartAccount が返す client・bundler の HTTP・EntryPoint の読み取り・receipt の照会
// (tests/_helpers/fakePimlicoBundler.ts)、wagmi、logger。hook と lib/smartAccount/pimlicoIntent.ts・pimlicoSend.ts は実物。
// 「世界」(bundler の mempool・EntryPoint の nonce) は test の間 1 つで、hook を mount し直しても残る。bundler の HTTP は
// 最後に作った client の bundlerSend へ届く (URL が同じ) ので、古い試みの送信も新しい client の bundlerSend に数えられる。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderView, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import { UserOperationReceiptNotFoundError } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { Suspense, use, useEffect, useLayoutEffect, type ReactNode } from 'react';
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
} from '../_helpers/fakePimlicoBundler';

const usdcDep = defaultDeploymentForSymbol('usdc');
const TOKEN: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const FEE_RECV: Address = getAddress('0x2222222222222222222222222222222222222222');
const SEVEN_DAYS_AND_A_MINUTE = 7 * 24 * 60 * 60 * 1000 + 60_000;
const SIGNATURE = `0x${'5a'.repeat(65)}` as Hex;
const PAYMASTER_EXPIRED = { error: { code: -32500, message: 'AA32 paymaster expired or not due' } };

// 10 USDC の支払い。
const PARAMS = {
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  merchantAmount: 10_000_000n,
  feeReceiver: FEE_RECV,
  feeAmount: 0n,
};
// 金額だけ違う別の支払い (20 USDC)。
const OTHER_PARAMS = { ...PARAMS, merchantAmount: 20_000_000n };

type GasPriceTier = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
const TIER: GasPriceTier = { maxFeePerGas: 50n * 10n ** 9n, maxPriorityFeePerGas: 1n };

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
function mountClients() {
  const getUserOperationGasPrice = vi.fn(async () => ({ slow: TIER, standard: TIER, fast: TIER }));
  const fake = fakePimlicoClients({ world, getUserOperationGasPrice });
  mockHook(useSmartAccount, { data: fake.data, isLoading: false, error: null });
  mockHook(useAccount, { chainId: baseSepolia.id });
  return { ...fake, getUserOperationGasPrice };
}

type Fake = ReturnType<typeof mountClients>;

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

// hook を mount する。unmount の後の mutation (画面はもう無い) の終わり方は、QueryClient の MutationCache で見る。
function render(options?: { reactStrictMode?: boolean }) {
  const qc = newQueryClient();
  const hook = renderHook(() => useBatchPayment(usdcDep), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
    ...options,
  });
  const lastMutation = () => {
    const mutation = qc.getMutationCache().getAll().at(-1);
    if (!mutation) throw new Error('mutation が無い');
    return mutation.state;
  };
  return { ...hook, mutationCount: () => qc.getMutationCache().getAll().length, lastMutation };
}

type Hook = ReturnType<typeof render>;

// unmount した hook の最後の mutation が payment_cancelled で終わるのを待つ。
async function expectCancelled(hook: Hook) {
  await waitFor(() => expect(hook.lastMutation().status).toBe('error'));
  expect(hook.lastMutation().error?.message).toBe('payment_cancelled');
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

// 応答不明の記録 (op は bundler に届いていない) を作り、その hook を返す。
async function seedUnknown() {
  const fake = mountClients();
  loseRequest(fake);
  const hook = render();
  hook.result.current.mutate(PARAMS);
  await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
  await waitFor(() => expect(hook.result.current.isPending).toBe(false));
  return { fake, hook };
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

describe('画面を離れた試みは、保存も送信もしない (A-2・(a))', () => {
  it('署名を待つ間に画面を離れ、開き直した画面で払い終えた後で古い署名を承認しても、古い試みは保存も送信もしない (A-2 の再現)', async () => {
    const first = mountClients();
    const signature = deferred<Hex>();
    first.signUserOperation.mockImplementationOnce(() => signature.promise);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(first.signUserOperation).toHaveBeenCalledTimes(1));
    // 署名を待つ間は storage に何も無い (開き直した画面は、古い試みを知る手がかりが無い)。
    expect(pendingKeys()).toHaveLength(0);
    firstHook.unmount();

    // 開き直した画面 (新しい hook) で同じ支払いを払い終える。
    const second = mountClients();
    acceptAndMine(second);
    const secondHook = render();
    expect(secondHook.result.current.isUnknown).toBe(false);
    secondHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(secondHook.result.current.isSuccess).toBe(true));
    expect(world.mined).toHaveLength(1);

    // ウォレットに残っていた古い署名の要求を承認する。直す前: 古い試みが別の nonce の op を保存して送り、2 本目が成立した。
    signature.resolve(SIGNATURE);
    await expectCancelled(firstHook);

    // bundler へ渡った op は、新しい画面の 1 本だけ (記録が無いことだけでは、成功の経路も記録を消すので確かめにならない)。
    expect(first.bundlerSend).not.toHaveBeenCalled();
    expect(second.bundlerSend).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
    expect(world.mempoolHashes()).toHaveLength(0);
    expect(pendingKeys()).toHaveLength(0);
    // 署名の後に捨てた回数を数えられる。
    expect(logger.info).toHaveBeenCalledWith(
      'pimlico.sign_abandoned',
      expect.objectContaining({ chainId: baseSepolia.id }),
    );
    // 新しい画面の成功はそのまま。
    expect(secondHook.result.current.isSuccess).toBe(true);
    expect(secondHook.result.current.isUnknown).toBe(false);
  });

  it('開き直した画面の支払いが開いている (応答不明) 間に古い署名を承認しても、その記録を上書きしない', async () => {
    const first = mountClients();
    const signature = deferred<Hex>();
    first.signUserOperation.mockImplementationOnce(() => signature.promise);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(first.signUserOperation).toHaveBeenCalledTimes(1));
    firstHook.unmount();

    // 新しい画面の支払いは bundler に受理されたが、応答を失った (開いている intent)。
    const second = mountClients();
    acceptThenLoseResponse(second);
    const secondHook = render();
    secondHook.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(secondHook.result.current.isPending).toBe(false));
    const openRecord = storedRaw();
    expect(openRecord).not.toBeNull();

    // 直す前: 古い試みが同じ key に自分の記録を書き (新しい画面の op を確かめる手がかりが消える)、別の nonce の op を送った。
    signature.resolve(SIGNATURE);
    await expectCancelled(firstHook);

    expect(storedRaw()).toBe(openRecord);
    expect(second.bundlerSend).toHaveBeenCalledTimes(1);
    expect(world.mempoolHashes()).toHaveLength(1);
    expect(secondHook.result.current.isUnknown).toBe(true);
  });

  it('照合の RPC を待つ間に画面を離れた送り直しは、記録を書き直さず、保存した op も送らない (署名は捨てていないので数えない)', async () => {
    const seed = await seedUnknown();
    seed.hook.unmount();

    const first = mountClients();
    const firstHook = render();
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    const before = storedRaw();
    // receipt の照会を止める。
    const lookup = deferred<never>();
    first.getUserOperationReceipt.mockImplementationOnce(() => lookup.promise);
    firstHook.result.current.retryReceipt();
    await waitFor(() => expect(first.getUserOperationReceipt).toHaveBeenCalledTimes(1));
    firstHook.unmount();

    // 照会が「まだ無い」で返る → nonce は未使用 → (生きていれば) 保存した op を送り直す所。
    lookup.reject(new UserOperationReceiptNotFoundError({ hash: `0x${'0'.repeat(64)}` }));
    await expectCancelled(firstHook);

    expect(first.readContract).toHaveBeenCalledTimes(1);
    expect(first.bundlerSend).not.toHaveBeenCalled();
    expect(world.mempoolHashes()).toHaveLength(0);
    // 送る時刻も書いていない (期限を延ばさない)。
    expect(storedRaw()).toBe(before);
    expect(logger.info).not.toHaveBeenCalledWith('pimlico.sign_abandoned', expect.anything());
  });
});

describe('画面を離れた試みは、ウォレットに署名を求めない (A-2・(b))', () => {
  it('準備を待つ間に画面を離れる → 準備が済んでも署名の要求を出さない', async () => {
    const first = mountClients();
    const gate = deferred<void>();
    const prepare = first.prepareUserOperation.getMockImplementation();
    if (!prepare) throw new Error('準備の偽物が無い');
    first.prepareUserOperation.mockImplementationOnce(async (parameters) => {
      await gate.promise;
      return prepare(parameters);
    });
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(first.prepareUserOperation).toHaveBeenCalledTimes(1));
    firstHook.unmount();

    gate.resolve();
    await expectCancelled(firstHook);

    expect(first.signUserOperation).not.toHaveBeenCalled();
    expect(first.bundlerSend).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
  });
});

describe('画面を離れた作り直しは、元の記録を書き戻さない (A-2・(a)(c)・計画レビュー M1)', () => {
  it.each([
    { label: '承認する', approve: true },
    { label: '断る', approve: false },
  ])(
    '作り直しの署名を待つ間に画面を離れ、開き直した画面が同じ nonce で確定した後で、古い署名の要求を$label → 消えた記録は復活せず、送信も増えない',
    async ({ approve }) => {
      const seed = await seedUnknown();
      const seededNonce = seed.fake.bundlerSend.mock.calls[0][0].params[0].nonce;
      seed.hook.unmount();

      // 画面 1: 確かめる → 送り直しを bundler が検証で拒否 → 同じ nonce で作り直す → 署名を待つ。
      const first = mountClients();
      const signature = deferred<Hex>();
      first.signUserOperation.mockImplementationOnce(() => signature.promise);
      replyOnce(first, PAYMASTER_EXPIRED);
      const firstHook = render();
      await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
      firstHook.result.current.retryReceipt();
      await waitFor(() => expect(first.signUserOperation).toHaveBeenCalledTimes(1));
      // 元の記録は storage に残っている (書き戻すまでもない)。
      expect(pendingKeys()).toHaveLength(1);
      firstHook.unmount();

      // 画面 2: 同じ記録を確かめる → 送り直しは拒否 → 同じ nonce で作り直す (署名) → 受理 → mine → 確定。記録は消える。
      const second = mountClients();
      replyOnce(second, PAYMASTER_EXPIRED);
      acceptAndMine(second);
      const secondHook = render();
      await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
      secondHook.result.current.retryReceipt();
      await waitFor(() => expect(secondHook.result.current.isSuccess).toBe(true));
      expect(second.bundlerSend).toHaveBeenCalledTimes(2);
      expect(second.bundlerSend.mock.calls[1][0].params[0].nonce).toBe(seededNonce);
      expect(world.mined).toHaveLength(1);
      expect(pendingKeys()).toHaveLength(0);

      // 画面 1 の古い署名の要求。直す前の形 (元の記録を応答不明として書き戻す) だと、終わった支払いの記録が復活し、
      // 期限 (7 日) まで gasless も通常決済も止まる。
      if (approve) signature.resolve(SIGNATURE);
      else signature.reject(new Error('User rejected the request.'));
      await expectCancelled(firstHook);

      expect(pendingKeys()).toHaveLength(0);
      expect(first.bundlerSend).toHaveBeenCalledTimes(1);
      expect(second.bundlerSend).toHaveBeenCalledTimes(2);
      expect(world.mined).toHaveLength(1);
      expect(world.mempoolHashes()).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalledWith('pimlico.rebuild.prepare-failed', expect.anything());
      expect(logger.warn).not.toHaveBeenCalledWith('pimlico.rebuild.rejected', expect.anything());

      // 開き直せば、止まっていない (記録が無い)。
      secondHook.unmount();
      mountClients();
      const thirdHook = render();
      expect(thirdHook.result.current.isUnknown).toBe(false);
    },
  );
});

describe('画面を離れた試みは、期限で記録を閉じない (A-2・(d))', () => {
  it('期限を過ぎた記録の照合の RPC を待つ間に画面を離れ、開き直した画面が閉じて新しい支払いの記録を書いた後 → 古い試みはその記録を消さない', async () => {
    const seed = await seedUnknown();
    seed.hook.unmount();
    ageStoredRecord();

    // 画面 1: 確かめる → EntryPoint の nonce の読み取りを待つ。
    const first = mountClients();
    const nonceRead = deferred<bigint>();
    first.readContract.mockImplementationOnce(() => nonceRead.promise);
    const firstHook = render();
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.result.current.retryReceipt();
    await waitFor(() => expect(first.readContract).toHaveBeenCalledTimes(1));
    firstHook.unmount();

    // 画面 2: 同じ記録を照合で閉じ (c4)、別の支払いを送る。受理されたが応答を失い、その記録が storage に残る。
    const second = mountClients();
    const secondHook = render();
    await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
    secondHook.result.current.retryReceipt();
    await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(false));
    await waitFor(() => expect(secondHook.result.current.isPending).toBe(false));
    expect(pendingKeys()).toHaveLength(0);
    acceptThenLoseResponse(second);
    secondHook.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(secondHook.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(secondHook.result.current.isPending).toBe(false));
    const openRecord = storedRaw();
    expect(openRecord).not.toBeNull();
    vi.mocked(logger.warn).mockClear();

    // 画面 1 の読み取りが返る (nonce は未使用・期限切れ)。直す前: key ごとの無条件の削除で、画面 2 の記録が消えた
    // (応答を失った支払いを確かめられず、別の nonce で払い直せる)。
    nonceRead.resolve(0n);
    await expectCancelled(firstHook);

    expect(storedRaw()).toBe(openRecord);
    expect(logger.warn).not.toHaveBeenCalledWith('pimlico.pending.expired-closed', expect.anything());
    expect(secondHook.result.current.isUnknown).toBe(true);
  });
});

describe('unmount の後に始まった試みは、何も読まず・書かず・求めない (mutationFn の先頭)', () => {
  it('mutate と同じ tick に unmount (新しい支払い) → storage も RPC も読まず、署名も求めない', async () => {
    const fake = mountClients();
    const hook = render();
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    hook.result.current.mutate(PARAMS);
    hook.unmount();
    await expectCancelled(hook);

    const touched = (calls: unknown[][]) =>
      calls.filter(([key]) => String(key).startsWith(PIMLICO_PENDING_KEY_PREFIX));
    expect(touched(getItem.mock.calls)).toEqual([]);
    expect(touched(setItem.mock.calls)).toEqual([]);
    expect(touched(removeItem.mock.calls)).toEqual([]);
    expect(fake.getUserOperationGasPrice).not.toHaveBeenCalled();
    expect(fake.getNonce).not.toHaveBeenCalled();
    expect(fake.prepareUserOperation).not.toHaveBeenCalled();
    expect(fake.signUserOperation).not.toHaveBeenCalled();
    expect(fake.bundlerSend).not.toHaveBeenCalled();
  });

  it('「同じ送信内容を再確認」と同じ tick に unmount (開いている intent) → 照合の RPC も読まず、記録もそのまま', async () => {
    const seed = await seedUnknown();
    seed.hook.unmount();

    const fake = mountClients();
    const hook = render();
    await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
    const before = storedRaw();

    hook.result.current.retryReceipt();
    hook.unmount();
    await expectCancelled(hook);

    expect(fake.getUserOperationReceipt).not.toHaveBeenCalled();
    expect(fake.readContract).not.toHaveBeenCalled();
    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(storedRaw()).toBe(before);
  });
});

describe('mount の印は、画面がある間は外れない', () => {
  it('reactStrictMode の mount → unmount → mount の後も、1 回の支払いが通る', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const hook = render({ reactStrictMode: true });
    // StrictMode が effect を 2 回走らせている (mount → unmount → mount): mount の時の記録の読み出しが 2 回。
    expect(
      getItem.mock.calls.filter(([key]) => String(key).startsWith(PIMLICO_PENDING_KEY_PREFIX)),
    ).toHaveLength(2);

    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
  });

  // /pay の画面は <Suspense> の中にある。再 suspend で隠れた子は layout effect だけが外れ、passive effect は残る。
  // mount の印を useLayoutEffect で持つと、画面が残っているのに署名を捨てる (払えたはずの支払いが黙って消える)。
  it('<Suspense> の中で隣が再 suspend して隠れている間に署名が返っても、支払いは送られる (印は useEffect で持つ)', async () => {
    const fake = mountClients();
    const signature = deferred<Hex>();
    fake.signUserOperation.mockImplementationOnce(() => signature.promise);
    acceptAndMine(fake);
    const qc = newQueryClient();
    const never = new Promise<never>(() => undefined);
    const cleanups = { layout: 0, passive: 0 };
    let payment: ReturnType<typeof useBatchPayment> | undefined;

    function Payer() {
      payment = useBatchPayment(usdcDep);
      // React が隠れた子の layout effect だけを外すことを、この test の中で確かめるための目印。
      useLayoutEffect(() => () => void (cleanups.layout += 1), []);
      useEffect(() => () => void (cleanups.passive += 1), []);
      return null;
    }
    function Neighbor({ suspend }: { suspend: boolean }) {
      if (suspend) use(never);
      return null;
    }
    const tree = (suspend: boolean) => (
      <QueryClientProvider client={qc}>
        <Suspense fallback={null}>
          <Payer />
          <Neighbor suspend={suspend} />
        </Suspense>
      </QueryClientProvider>
    );

    const view = renderView(tree(false));
    payment?.mutate(PARAMS);
    await waitFor(() => expect(fake.signUserOperation).toHaveBeenCalledTimes(1));

    // 隣が suspend する → 境界は fallback を出し、Payer は隠れる (unmount はしない)。
    view.rerender(tree(true));
    expect(cleanups).toEqual({ layout: 1, passive: 0 });

    signature.resolve(SIGNATURE);
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(world.mined).toHaveLength(1));
    expect(qc.getMutationCache().getAll().at(-1)?.state.status).toBe('success');
    view.unmount();
  });
});

describe('同じ tick の二度押しは、1 回だけ走る (A-3)', () => {
  it('同じ内容の mutate が 2 回 → mutation は 1 つ。準備・署名・送信は 1 回', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    const hook = render();

    hook.result.current.mutate(PARAMS);
    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(hook.mutationCount()).toBe(1);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(fake.prepareUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
  });

  it('別の内容の mutate が 2 回 → 走るのは 1 回目だけ。1 回目の成功は「別の intent の確定」にならない', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    const hook = render();

    hook.result.current.mutate(PARAMS);
    hook.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(hook.mutationCount()).toBe(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(hook.result.current.variables?.merchantAmount).toBe(PARAMS.merchantAmount);
    // 無視した 2 回目の内容を「画面から最後に送った支払い」にしない (すると、払えた 10 USDC の成功が出なくなる)。
    expect(hook.result.current.settledOtherIntent).toBe(false);
    expect(hook.result.current.recoveredIntent).toBeNull();
  });

  it('mutateAsync の 2 回目は payment_in_progress で断り、1 回目はそのまま成功する', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    const hook = render();

    const firstAttempt = hook.result.current.mutateAsync(PARAMS);
    const secondAttempt = hook.result.current.mutateAsync(OTHER_PARAMS);

    await expect(secondAttempt).rejects.toThrow('payment_in_progress');
    await expect(firstAttempt).resolves.toMatchObject({ success: true, provider: 'pimlico' });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.mutationCount()).toBe(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(hook.result.current.settledOtherIntent).toBe(false);
  });

  it('「同じ送信内容を再確認」が同じ tick に 2 回 → 照合も送り直しも 1 回', async () => {
    const { fake, hook } = await seedUnknown();
    expect(hook.mutationCount()).toBe(1);

    hook.result.current.retryReceipt();
    hook.result.current.retryReceipt();
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));

    expect(hook.mutationCount()).toBe(2);
    expect(fake.getUserOperationReceipt).toHaveBeenCalledTimes(1);
    expect(fake.readContract).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
  });

  it('「同じ送信内容を再確認」と同じ tick の mutate は無視される (fingerprint も書かない)', async () => {
    const { fake, hook } = await seedUnknown();

    world.accept(fake.bundlerSend.mock.calls[0][0].params[0]);
    world.mine();
    hook.result.current.retryReceipt();
    hook.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(hook.mutationCount()).toBe(2);
    expect(hook.result.current.variables?.merchantAmount).toBe(PARAMS.merchantAmount);
    // 画面から最後に送ったのは 10 USDC のまま = 同じ内容の確定。
    expect(hook.result.current.settledOtherIntent).toBe(false);
  });
});

describe('試み中の印は、試みが終わると外れる (A-3)', () => {
  it('確かめる記録が無いときの「再確認」は何もしない。その後の支払いは通る', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    const hook = render();

    hook.result.current.retryReceipt();
    expect(hook.mutationCount()).toBe(0);
    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
  });

  it('ウォレットで署名を断った後、もう一度送れる', async () => {
    const fake = mountClients();
    fake.signUserOperation.mockRejectedValueOnce(new Error('User rejected the request.'));
    acceptAndMine(fake);
    const hook = render();

    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.error?.message).toBe('User rejected the request.');

    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(world.mined).toHaveLength(1);
  });

  it('成功の後、次の支払いを送れる', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    acceptAndMine(fake);
    const hook = render();

    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    hook.result.current.mutate(OTHER_PARAMS);
    await waitFor(() =>
      expect(hook.result.current.variables?.merchantAmount).toBe(OTHER_PARAMS.merchantAmount),
    );
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(hook.mutationCount()).toBe(2);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
    expect(world.mined).toHaveLength(2);
    expect(hook.result.current.settledOtherIntent).toBe(false);
  });
});
