// 第 10 回レビュー A-1 (P1・money-path): Pimlico の送信の応答を失っても、記録とラッチが残り、
// 再試行・通常決済・別の内容の支払いが二重払いにならないこと。
//
// 失敗シナリオ (直す前): bundler は UserOperation を受理したが、応答が http の timeout (10 秒) を超える。
// sendUserOperation が throw し、hash も記録も無いまま通常の error で終わる。1 本目は mine される。
// お客様がもう一度押して署名すると、別の nonce key の 2 本目も成立する。
//
// 直した後の不変条件: 署名済みの op を保存した時点から、その intent は「開いている」。開いている間は、
// 別の nonce の op・別の内容の支払いを作らず、画面は通常決済も止める (isUnknown)。閉じるのは
//   c1 候補の hash のどれかに receipt がある
//   c2 最初の送信を bundler が検証で拒否した (HTTP 2xx + ERC-7769 の code) → 記録を消したと確かめてから
//   c4 保存から 7 日を過ぎ、候補に receipt が無く、EntryPoint の nonce も未使用 → 記録を消したと確かめてから
// だけ。それ以外 (応答不明・送り直し / 作り直しの拒否 (c3)・nonce が進んだのに receipt が無い (c5)) は開いたまま。
//
// mock は境界だけ: useSmartAccount が返す client・bundler の HTTP (fetch の FAKE_BUNDLER_URL だけ)・EntryPoint の
// 読み取り・receipt の照会 (tests/_helpers/fakePimlicoBundler.ts)、wagmi、logger、localStorage の失敗を作る spy。
// hook と lib/smartAccount/pimlicoSend.ts (viem の http transport を含む) は実物。
// bundler に「届いた後に応答が失われた」は fetch の失敗で作る (timeout と同じく応答不明。実物の timeout は
// tests/lib/smartAccount/pimlicoSend.test.ts)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import {
  entryPoint07Address,
  UserOperationReceiptNotFoundError,
} from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import type { ReactNode } from 'react';
import {
  PIMLICO_PENDING_KEY_PREFIX,
  useBatchPayment,
} from '@/hooks/useBatchPayment';
import { derivePayGuards } from '@/lib/paymentFlowGuards/pay';
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
import { useAccount, usePublicClient } from 'wagmi';
import { logger } from '@/lib/logger';
import { mockHook } from '../_helpers/wagmiMock';
import {
  bundlerTimeout,
  createFakeBundlerWorld,
  fakePimlicoClients,
  fakePublicClient,
  lostResponse,
  routePimlicoReceiptApi,
  type BundlerHttpReply,
  type FakeBundlerWorld,
} from '../_helpers/fakePimlicoBundler';

const usdcDep = defaultDeploymentForSymbol('usdc');
const TOKEN: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const FEE_RECV: Address = getAddress('0x2222222222222222222222222222222222222222');
const CUSTOMER_A: Address = getAddress('0x3333333333333333333333333333333333333333');
const CUSTOMER_B: Address = getAddress('0x4444444444444444444444444444444444444444');
const OTHER_SENDER: Address = getAddress('0x5555555555555555555555555555555555555555');
const SEVEN_DAYS_AND_A_MINUTE = 7 * 24 * 60 * 60 * 1000 + 60_000;

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

type SignedOp = Record<string, unknown>;
type StoredRecord = {
  status: string;
  userOpHash: Hex;
  callFingerprint: Hex;
  updatedAt: number;
  send?: {
    entryPoint: Address;
    sender: Address;
    nonceKey: string;
    nonceSeq: string;
    signedUserOp: SignedOp;
    priorUserOpHashes?: Hex[];
  };
};

function pendingKeys(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index),
  ).filter(
    (key): key is string => key !== null && key.startsWith(PIMLICO_PENDING_KEY_PREFIX),
  );
}

function storedRecord(): StoredRecord | null {
  const keys = pendingKeys();
  if (keys.length === 0) return null;
  expect(keys).toHaveLength(1);
  return JSON.parse(window.localStorage.getItem(keys[0]) ?? 'null') as StoredRecord;
}

function rewriteStoredRecord(change: (record: StoredRecord) => StoredRecord) {
  const key = pendingKeys()[0];
  const record = JSON.parse(window.localStorage.getItem(key) ?? '{}') as StoredRecord;
  window.localStorage.setItem(key, JSON.stringify(change(record)));
}

// 保存してから 7 日と 1 分たった記録にする。
function ageStoredRecord() {
  rewriteStoredRecord((record) => ({
    ...record,
    updatedAt: Date.now() - SEVEN_DAYS_AND_A_MINUTE,
  }));
}

function recordNonce(record: StoredRecord | null): bigint {
  if (!record?.send) throw new Error('送信の控えが無い');
  return (BigInt(record.send.nonceKey) << 64n) | BigInt(record.send.nonceSeq);
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

let world: FakeBundlerWorld;

// client を作り (mount のたびに作り直す = ページの読み直し)、useSmartAccount に載せる。world は test の間そのまま。
function mountClients(options?: { sender?: Address; customer?: Address }) {
  const fake = fakePimlicoClients({ world, sender: options?.sender });
  mockHook(useSmartAccount, { data: fake.data, isLoading: false, error: null });
  mockHook(useAccount, { chainId: baseSepolia.id, address: options?.customer });
  return fake;
}

type Fake = ReturnType<typeof mountClients>;

// bundler が op を受理した後、応答だけが失われる (A-1 の失敗シナリオ)。
function acceptThenLoseResponse(fake: Fake) {
  fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
    world.accept(params[0]);
    throw lostResponse();
  });
}

// bundler が op を受理した後、HTTP の層では失敗の答えが返る (proxy・上流の内部の失敗)。
function acceptThenReply(fake: Fake, reply: BundlerHttpReply) {
  fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
    world.accept(params[0]);
    return reply;
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

// bundler が受理し、すぐ mine される (receipt が取れる)。
function acceptAndMine(fake: Fake) {
  fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
    const hash = world.accept(params[0]);
    world.mine(hash);
    return { result: hash };
  });
}

function sentOp(fake: Fake, index: number): SignedOp {
  return fake.bundlerSend.mock.calls[index][0].params[0];
}

function render() {
  return renderHook(() => useBatchPayment(usdcDep), { wrapper: makeWrapper() });
}

// /pay の送信可否 (lib/paymentFlowGuards/pay.ts の実物) に、この hook の状態を渡したとき、**通常決済** を始められるか。
// 通常決済の経路に必要なほかの条件 (接続・金額・残高) はすべて満たした状態にする。
function standardPaymentOpen(gasless: {
  isPending: boolean;
  isUnknown: boolean;
  pendingStoreUnavailable: boolean;
  data?: { success: boolean };
}): boolean {
  return derivePayGuards({
    isStandard: true,
    useRelay: false,
    standard: {
      isRestoring: false,
      isPending: false,
      isUnknown: false,
      isFeeError: false,
      hasActiveIntent: false,
      data: undefined,
    },
    relay: {
      error: null,
      recoveryState: null,
      isRestoring: false,
      isPending: false,
      hasActiveIntent: false,
    },
    gasless: {
      isPending: gasless.isPending,
      isUnknown: gasless.isUnknown,
      pendingStoreUnavailable: gasless.pendingStoreUnavailable,
      data: gasless.data,
    },
    crossChainLocked: false,
    crossChainResult: undefined,
    params: { token: 'usdc', chain: 'base' },
    address: undefined,
    arcScannedScope: '',
    arcRecoveryScope: '',
    cctpResumeSaved: false,
    activeQuote: { data: undefined },
    isConnected: true,
    wrongChain: false,
    saData: undefined,
    breakdown: { merchantReceives: 1n, customerPays: 1n },
    insufficientBalance: false,
    merchantUnderflow: false,
    expired: false,
    timeMeasured: true,
    splitBlocked: false,
  }).canSubmit;
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

describe('署名 → 保存 → 送信の順 (A-1)', () => {
  it('送信の時点で、hash・署名済みの op・nonce (key と seq) が保存されている', async () => {
    const fake = mountClients();
    let atSend: StoredRecord | null = null;
    fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
      atSend = storedRecord();
      const hash = world.accept(params[0]);
      world.mine(hash);
      return { result: hash };
    });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const op = sentOp(fake, 0);
    const saved = atSend as StoredRecord | null;
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('pending');
    expect(saved?.userOpHash).toBe(world.hashOf(op));
    // 保存した op = 送った op (1 字も違わない)。
    expect(saved?.send?.signedUserOp).toEqual(op);
    expect(saved?.send?.entryPoint).toBe(world.entryPoint);
    // 保存した nonce = 署名の前に決めた nonce = 送った op の nonce。
    expect(recordNonce(saved)).toBe(BigInt(op.nonce as Hex));
    expect(recordNonce(saved)).toBe(await fake.getNonce.mock.results[0].value);

    // 送信は bundler の HTTP へ eth_sendUserOperation を 1 回 (再送なし)。
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend.mock.calls[0][0].params[1]).toBe(world.entryPoint);

    // 成功の経路の結果は分ける前と同じ形。記録は消える。計算した hash と返った hash は同じ (warn なし)。
    expect(result.current.data).toEqual({
      userOpHash: world.hashOf(op),
      txHash: `0x${'b'.repeat(64)}`,
      blockNumber: 12345n,
      success: true,
      actualGasCost: 1_000n,
      provider: 'pimlico',
    });
    expect(pendingKeys()).toHaveLength(0);
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.settledOtherIntent).toBe(false);
    expect(logger.warn).not.toHaveBeenCalledWith('pimlico.send.hash-mismatch', expect.anything());
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
  });

  it('bundler が受理した後に応答だけ失われる → 通常の error にせず応答不明にラッチし (通常決済も止める)、再試行は新しい op を作らない', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    const op = sentOp(fake, 0);
    // 通常の失敗として見せない (見せると画面が再試行を開ける)。通常決済も始められない。
    expect(result.current.error).toBeNull();
    expect(standardPaymentOpen(result.current)).toBe(false);
    expect(result.current.pendingUserOpHash).toBe(world.hashOf(op));
    expect(storedRecord()).toMatchObject({
      status: 'unknown',
      userOpHash: world.hashOf(op),
      send: { signedUserOp: op },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'pimlico.send.response-unknown',
      expect.objectContaining({ userOpHash: world.hashOf(op) }),
    );

    // 1 本目が mine される。お客様がもう一度「支払う」を押す (同じ内容)。
    world.mine();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // 2 本目は作られていない: nonce の採番・準備・署名はどれも 1 回のまま。
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(fake.prepareUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    // 確定した支払いは 1 本だけ。同じ内容の確定なので、画面の支払いとして出してよい。
    expect(world.mined).toHaveLength(1);
    expect(result.current.data?.userOpHash).toBe(world.hashOf(op));
    expect(result.current.data?.success).toBe(true);
    expect(result.current.settledOtherIntent).toBe(false);
    expect(result.current.isUnknown).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('応答不明の間は、別の内容の支払いを通さない (署名も送信もしない)', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    result.current.mutate(OTHER_PARAMS);
    await waitFor(() =>
      expect(result.current.variables?.merchantAmount).toBe(OTHER_PARAMS.merchantAmount),
    );
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(world.mempoolHashes()).toHaveLength(1);
  });

  it('op が bundler に届いていなかった → 確かめると、保存した署名済みの op を 1 字も変えずに送り直す (署名は増えない)', async () => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    expect(world.mempoolHashes()).toHaveLength(0);

    // 確かめる: receipt なし → nonce は未使用 → 同じ op を送り直す → 受理。まだ mine されていないので応答不明のまま。
    result.current.retryReceipt();
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isUnknown).toBe(true);
    expect(fake.bundlerSend.mock.calls[1][0]).toEqual(fake.bundlerSend.mock.calls[0][0]);
    expect(world.mempoolHashes()).toEqual([world.hashOf(sentOp(fake, 0))]);
    // 送り直しの前に、receipt と EntryPoint の nonce を読んでいる。
    expect(fake.getUserOperationReceipt).toHaveBeenCalledWith({
      hash: world.hashOf(sentOp(fake, 0)),
    });
    expect(fake.readContract).toHaveBeenCalledTimes(1);
    expect(fake.readContract.mock.calls[0][0]).toMatchObject({
      address: world.entryPoint,
      functionName: 'getNonce',
    });

    world.mine();
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.prepareUserOperation).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('mine されたが receipt がまだ引けない (nonce はもう使われた) → 送り直さずに receipt を待つ', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const hash = world.hashOf(sentOp(fake, 0));

    world.mine();
    // bundler の 1 回ずつの照会はまだ receipt を返さない (索引の遅れ)。EntryPoint の nonce は進んでいる。
    fake.getUserOperationReceipt.mockRejectedValueOnce(
      new UserOperationReceiptNotFoundError({ hash }),
    );
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fake.readContract).toHaveBeenCalledTimes(1);
    // 使われた nonce の op は送り直さない・作り直さない。
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.waitForUserOperationReceipt).toHaveBeenCalledWith({ hash });
    expect(result.current.data?.userOpHash).toBe(hash);
    expect(world.mined).toHaveLength(1);
  });

  it('確かめる照会そのものが失敗 → 応答不明のまま、何も送らない', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    fake.getUserOperationReceipt.mockRejectedValueOnce(new Error('HTTP request failed'));
    result.current.retryReceipt();
    await waitFor(() => expect(fake.getUserOperationReceipt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(storedRecord()?.status).toBe('unknown');
  });
});

describe('最初の送信の失敗の分類: 閉じるのは HTTP 2xx の検証の拒否だけ (c2・c3・MUST 1)', () => {
  it.each([
    { code: -32500, message: "AA21 didn't pay prefund" },
    { code: -32501, message: 'AA33 reverted' },
    { code: -32507, message: 'AA24 signature error' },
    { code: -32602, message: 'invalid UserOperation field' },
  ])(
    '最初の送信を bundler が検証で拒否した (HTTP 200・$code) → 今までどおりの error で閉じる: 記録を消し、通常決済も金額を変えた支払い (新しい nonce) もできる (c2)',
    async (rejection) => {
      const fake = mountClients();
      replyOnce(fake, { error: rejection });
      const { result } = render();

      result.current.mutate(PARAMS);
      await waitFor(() => expect(result.current.isError).toBe(true));

      // viem の sendUserOperation が投げるのと同じ形の error。応答不明ではない。
      expect(result.current.error?.name).toBe('UserOperationExecutionError');
      expect(result.current.isUnknown).toBe(false);
      expect(result.current.pendingUserOpHash).toBeUndefined();
      // nonce の予約は残さない。
      expect(pendingKeys()).toHaveLength(0);
      expect(standardPaymentOpen(result.current)).toBe(true);

      acceptAndMine(fake);
      result.current.mutate(OTHER_PARAMS);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(fake.getNonce).toHaveBeenCalledTimes(2);
      expect(sentOp(fake, 1).nonce).not.toBe(sentOp(fake, 0).nonce);
      expect(world.mined).toHaveLength(1);
      expect(result.current.settledOtherIntent).toBe(false);
    },
  );

  it('最初の送信の検証の拒否でも、記録を消したと確かめられなければ閉じない (残った署名済みの op が後で送られうる)', async () => {
    const fake = mountClients();
    replyOnce(fake, { error: { code: -32500, message: "AA21 didn't pay prefund" } });
    const { result } = render();
    failStorage({ failReadBacks: 0, failRemove: 'noop' });

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.error).toBeNull();
    expect(standardPaymentOpen(result.current)).toBe(false);
    expect(pendingKeys()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.send.rejected-unverified', expect.anything());
  });

  it('HTTP 500 に JSON-RPC の error (-32603) が載っても、bundler が受理していれば: 応答不明にして通常決済も止め、元の op の確定を待つ (MUST 1・Codex の再現)', async () => {
    const fake = mountClients();
    // 上流は op を受理したが、proxy / 内部の失敗で HTTP 500 + JSON-RPC の error が返る。
    acceptThenReply(fake, { error: { code: -32603, message: 'internal error' }, status: 500 });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    // 直す前: 「断られた」と読み、画面は通常の error・通常決済は開いたまま (払い直すと元の op も成立して二重)。
    expect(result.current.error).toBeNull();
    expect(standardPaymentOpen(result.current)).toBe(false);
    expect(storedRecord()?.status).toBe('unknown');

    world.mine();
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.userOpHash).toBe(world.hashOf(sentOp(fake, 0)));
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
  });

  it.each<{ label: string; reply: BundlerHttpReply }>([
    { label: 'HTTP 200 + -32603 internal', reply: { error: { code: -32603, message: 'internal error' } } },
    { label: 'HTTP 200 + -32005 rate limit', reply: { error: { code: -32005, message: 'rate limit exceeded' } } },
    { label: 'HTTP 500 + -32500 (allowlist の code でも 5xx)', reply: { error: { code: -32500, message: 'AA21' }, status: 500 } },
    { label: 'HTTP 429 + -32005', reply: { error: { code: -32005, message: 'too many requests' }, status: 429 } },
    { label: 'HTTP 502 (本文が JSON-RPC でない)', reply: { status: 502, body: 'bad gateway' } },
  ])('最初の送信への答えが $label → 応答不明 (開いたまま): 記録を残し、同じ内容の再試行も新しい nonce を採らない', async ({ reply }) => {
    const fake = mountClients();
    replyOnce(fake, reply);
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    expect(result.current.error).toBeNull();
    expect(standardPaymentOpen(result.current)).toBe(false);
    expect(storedRecord()?.status).toBe('unknown');

    // 確かめる: 届いていなかったので同じ op を送り直す (署名・nonce の採番は増えない)。
    result.current.retryReceipt();
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(fake.bundlerSend.mock.calls[1][0]).toEqual(fake.bundlerSend.mock.calls[0][0]);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
  });

  it('送り直しを bundler が検証で拒否 → 同じ nonce で作り直す。作り直しが allowlist の code (Replacement underpriced) で断られても閉じない (c3)', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const op1 = sentOp(fake, 0);
    const hash1 = world.hashOf(op1);

    // 確かめる: 送り直しを bundler が検証で拒否 (paymaster の期限切れ)。元の op は mempool に残っている。
    replyOnce(fake, { error: { code: -32500, message: 'AA32 paymaster expired or not due' } });
    result.current.retryReceipt();
    // → 同じ nonce で作り直す (署名 2 回目) → bundler は同じ nonce の別の op を「Replacement underpriced」で断る。
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const op2 = sentOp(fake, 2);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(op2.nonce).toBe(op1.nonce);
    expect(op2).not.toEqual(op1);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    // 応答不明のまま。通常の error にも、新しい支払い・通常決済にも開かない。
    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
    expect(standardPaymentOpen(result.current)).toBe(false);
    const rebuilt = storedRecord();
    expect(rebuilt?.status).toBe('unknown');
    expect(rebuilt?.userOpHash).toBe(world.hashOf(op2));
    expect(rebuilt?.send?.priorUserOpHashes).toEqual([hash1]);
    expect(recordNonce(rebuilt)).toBe(BigInt(op1.nonce as Hex));

    // 元の op が mine される。EntryPoint は同じ nonce の 2 本目をもう受け付けない。
    world.mine(hash1);
    expect(() => world.accept(op2)).toThrow(/AA25/);

    // 確かめる → 作り直す前の op の receipt で確定する。
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.userOpHash).toBe(hash1);
    expect(world.mined).toHaveLength(1);
    expect(world.mined[0].hash).toBe(hash1);
    expect(result.current.isUnknown).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
    // 3 回目の署名は無い。
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
  });

  it.each<{ label: string; reply: BundlerHttpReply }>([
    { label: 'HTTP 500 + -32603', reply: { error: { code: -32603, message: 'internal error' }, status: 500 } },
    { label: 'HTTP 200 + -32603', reply: { error: { code: -32603, message: 'internal error' } } },
  ])('送り直しへの答えが応答不明 ($label) → 作り直さない (署名を求めない)・開いたまま', async ({ reply }) => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    replyOnce(fake, reply);
    result.current.retryReceipt();
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.prepareUserOperation).toHaveBeenCalledTimes(1);
    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('作り直しより先に元の op が取り込まれていたら、作り直しは AA25 で落ち、元の op の receipt で確定する', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const hash1 = world.hashOf(sentOp(fake, 0));

    // 確かめる: nonce を読んだ直後に元の op が mine され、送り直しは AA25 (-32500・HTTP 200) で断られる (読みと送りの間の隙間)。
    fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
      world.mine(hash1);
      return world.respond(params[0]);
    });
    result.current.retryReceipt();
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    // 作り直しの op (同じ nonce) も AA25 で断られた。確定は 1 本のまま、応答不明を保つ。
    expect(sentOp(fake, 2).nonce).toBe(sentOp(fake, 0).nonce);
    expect(world.mined).toHaveLength(1);
    expect(world.mempoolHashes()).toHaveLength(0);
    expect(result.current.isUnknown).toBe(true);

    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.userOpHash).toBe(hash1);
    expect(world.mined).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('応答不明の作り直しでウォレットの署名を断った → 応答不明のまま・記録は元の op のまま', async () => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const before = storedRecord();

    // 送り直しを bundler が検証で拒否する (paymaster の期限切れ) → 作り直しの署名をお客様が断る。
    replyOnce(fake, { error: { code: -32500, message: 'AA32 paymaster expired or not due' } });
    fake.signUserOperation.mockRejectedValueOnce(new Error('User rejected the request.'));
    result.current.retryReceipt();
    await waitFor(() => expect(fake.signUserOperation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
    const after = storedRecord();
    expect(after?.userOpHash).toBe(before?.userOpHash);
    expect(after?.send?.signedUserOp).toEqual(before?.send?.signedUserOp);
    expect(after?.send?.priorUserOpHashes).toBeUndefined();
  });
});

describe('開いている intent の間は別の内容を受け付けず、成功の表示を確定した intent に結び付ける (MUST 2)', () => {
  it('10 USDC が応答不明の間に 20 USDC へ変えても、署名も送信もしない。確定は 10 USDC の intent で、画面の最後の送信 (20) とは別と分かる (Codex の再現)', async () => {
    const fake = mountClients();
    acceptThenReply(fake, { error: { code: -32603, message: 'internal error' }, status: 500 });
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const hash1 = world.hashOf(sentOp(fake, 0));

    // 画面の金額を 20 USDC に変えて「支払う」(フォームは isUnknown の間は押させないが、hook の関所でも止める)。
    result.current.mutate(OTHER_PARAMS);
    await waitFor(() =>
      expect(result.current.variables?.merchantAmount).toBe(OTHER_PARAMS.merchantAmount),
    );
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isUnknown).toBe(true);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).toHaveBeenCalledTimes(1);
    // 候補の hash は intent に結び付いたまま。
    expect(storedRecord()?.userOpHash).toBe(hash1);

    // 元の 10 USDC が mine される → 確かめる → 10 USDC の intent として確定。
    world.mine(hash1);
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.userOpHash).toBe(hash1);
    expect(result.current.variables?.merchantAmount).toBe(PARAMS.merchantAmount);
    // 画面から最後に送ったのは 20 USDC。この成功を画面の金額・明細で出さない (components/PaymentForm.tsx)。
    expect(result.current.settledOtherIntent).toBe(true);
    expect(world.mined).toHaveLength(1);
  });

  it('reload の後に確定した支払いは、この画面から送った支払いではない (settledOtherIntent)', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();

    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    acceptAndMine(second);
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(restored.result.current.settledOtherIntent).toBe(true);
  });
});

describe('期限: 黙って消さず、照合してから閉じる (c4・c5・MUST 3)', () => {
  it('受理後に応答を失い、op は mine された。7 日後に戻っても記録は消えず、新しい nonce の支払いを作らずに元の op で確定する (Codex の再現)', async () => {
    const first = mountClients();
    acceptThenLoseResponse(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    const hash1 = world.hashOf(sentOp(first, 0));
    firstHook.unmount();
    world.mine(hash1);
    ageStoredRecord();

    // 7 日後に戻る。直す前: 読み出しで記録を黙って消し、同じ支払いを新しい nonce で作れた (2 本とも成立)。
    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    expect(pendingKeys()).toHaveLength(1);
    expect(standardPaymentOpen(restored.result.current)).toBe(false);

    acceptAndMine(second);
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(restored.result.current.data?.userOpHash).toBe(hash1);
    expect(second.getNonce).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(world.mined).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('7 日を過ぎ、候補に receipt が無く EntryPoint の nonce も未使用 → 送り直さずに閉じる (画面は通常の入力に戻る)。その後の支払いは新しい nonce', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    const firstNonce = sentOp(first, 0).nonce;
    firstHook.unmount();
    ageStoredRecord();

    const second = mountClients();
    const restored = render();
    // 期限を過ぎても、照合するまでは開いたまま。
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));

    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(false));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    // 7 日前の op は送り直していない (今送るとその時点で成立しうる)。署名も求めない。
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.readContract).toHaveBeenCalledTimes(1);
    expect(pendingKeys()).toHaveLength(0);
    // 閉じたことは失敗ではない (画面に error を出さない)。通常決済も開く。
    expect(restored.result.current.error).toBeNull();
    expect(restored.result.current.data).toBeUndefined();
    expect(standardPaymentOpen(restored.result.current)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.pending.expired-closed', expect.anything());

    acceptAndMine(second);
    restored.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(second.getNonce).toHaveBeenCalledTimes(1);
    expect(sentOp(second, 0).nonce).not.toBe(firstNonce);
    expect(world.mined).toHaveLength(1);
  });

  it('期限の照合で閉じるときも、記録を消したと確かめられなければ開いたまま', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();
    ageStoredRecord();

    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    failStorage({ failReadBacks: 0, failRemove: 'noop' });
    restored.result.current.retryReceipt();
    await waitFor(() => expect(second.readContract).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    expect(restored.result.current.isUnknown).toBe(true);
    expect(standardPaymentOpen(restored.result.current)).toBe(false);
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.pending.expired-close-failed', expect.anything());
  });

  // 応答を失った op の nonce (key, seq) を別の op が使った状態の記録を作り、unmount する
  // (この支払いの hash には receipt が付かない = MetaMask の key 0 を別の支払いが使った等)。
  async function seedConsumedByOtherOp() {
    const first = mountClients();
    acceptThenLoseResponse(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    world.consumeNonceByOtherOp(BigInt(sentOp(first, 0).nonce as Hex));
    firstHook.unmount();
  }

  it('EntryPoint の nonce を別の op が使い、候補に receipt が無い (期限の前) → 成功とも不成立ともせず開いたまま (c5・MetaMask の key 0)', async () => {
    await seedConsumedByOtherOp();

    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    restored.result.current.retryReceipt();
    await waitFor(() => expect(second.waitForUserOperationReceipt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    // 成功と表示しない・開けて新しい支払いを許さない・送らない・署名を求めない。
    expect(restored.result.current.data).toBeUndefined();
    expect(restored.result.current.isUnknown).toBe(true);
    expect(standardPaymentOpen(restored.result.current)).toBe(false);
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(1);

    restored.result.current.mutate(OTHER_PARAMS);
    await waitFor(() =>
      expect(restored.result.current.variables?.merchantAmount).toBe(OTHER_PARAMS.merchantAmount),
    );
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));
    expect(second.getNonce).not.toHaveBeenCalled();
    expect(restored.result.current.isUnknown).toBe(true);
    expect(world.mined).toHaveLength(0);
  });

  it('同じ状態 (c5) で 7 日を過ぎた → 送らずに閉じる (端末に永久に残る止めを作らない)。その後の支払いは新しい nonce', async () => {
    await seedConsumedByOtherOp();
    ageStoredRecord();

    const second = mountClients();
    const restored = render();
    // 期限を過ぎても、照合するまでは開いたまま。
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(false));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    // 成功とは表示しない (data なし・error も出さない)。送らない・署名を求めない。記録は消える。
    expect(restored.result.current.data).toBeUndefined();
    expect(restored.result.current.error).toBeNull();
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.waitForUserOperationReceipt).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
    expect(standardPaymentOpen(restored.result.current)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'pimlico.pending.expired-closed',
      expect.objectContaining({ state: 'consumed' }),
    );

    acceptAndMine(second);
    restored.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(second.getNonce).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
  });
});

// localStorage の失敗を作る spy。setItem の直後の getItem (persistPimlicoPending の読み戻し) を failReadBacks 回だけ
// 投げる。failRemove: 'throw' = 記録の removeItem が投げる・'noop' = 黙って何も消さない (消したと確かめないと分からない)。
function failStorage(options: { failReadBacks: number; failRemove?: 'throw' | 'noop' }) {
  const realGet = Storage.prototype.getItem;
  const realSet = Storage.prototype.setItem;
  const realRemove = Storage.prototype.removeItem;
  let budget = options.failReadBacks;
  let readBackPending = false;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    realSet.call(this, key, value);
    readBackPending = key.startsWith(PIMLICO_PENDING_KEY_PREFIX) && budget > 0;
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    if (readBackPending) {
      readBackPending = false;
      budget -= 1;
      throw new DOMException('read failed', 'UnknownError');
    }
    return realGet.call(this, key);
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    if (options.failRemove && key.startsWith(PIMLICO_PENDING_KEY_PREFIX)) {
      if (options.failRemove === 'throw') {
        throw new DOMException('remove failed', 'UnknownError');
      }
      return;
    }
    realRemove.call(this, key);
  });
}

describe('保存できないときは送らない・送っていない op の記録を残したまま開けない (A-1・MUST 4)', () => {
  it('保存の書き込みが throw → 送信しない。gasless だけ止め (pendingStoreUnavailable)、応答不明にはしない', async () => {
    const fake = mountClients();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.pendingStoreUnavailable).toBe(true));

    expect(setItem).toHaveBeenCalled();
    // 署名までは済んでいるが、op はどこにも送っていない。
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(world.mempoolHashes()).toHaveLength(0);
    // 送っていないので応答不明 (= 通常決済も止める) にはしない。通常の failure にも流さない (専用の文言)。
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.error).toBeNull();
    expect(pendingKeys()).toHaveLength(0);
  });

  it('書き込みは通るが読み戻すと違う → 書いたかもしれない記録を消したと確かめて、送信しない', async () => {
    const fake = mountClients();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.pendingStoreUnavailable).toBe(true));

    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(result.current.isUnknown).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('書けて読み戻しが投げる → 書いた記録を消したと確かめてから「保存できません」。reload の後に署名済みの op が送られない (Codex の再現)', async () => {
    const first = mountClients();
    failStorage({ failReadBacks: 1 });
    const firstHook = render();

    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.pendingStoreUnavailable).toBe(true));

    expect(first.bundlerSend).not.toHaveBeenCalled();
    expect(firstHook.result.current.isUnknown).toBe(false);
    // 直す前: 署名済みの op の記録が storage に残り、画面は「保存できません」(= 通常決済は開く) だった。
    expect(pendingKeys()).toHaveLength(0);
    firstHook.unmount();
    vi.restoreAllMocks();

    // reload: 確かめる記録が無いので、何も送られない。
    const second = mountClients();
    const restored = render();
    expect(restored.result.current.isUnknown).toBe(false);
    restored.result.current.retryReceipt();
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(world.mempoolHashes()).toHaveLength(0);
  });

  it.each([
    { label: 'removeItem が投げる', failRemove: 'throw' as const },
    { label: 'removeItem が黙って消さない', failRemove: 'noop' as const },
  ])('書けて読み戻しが投げ、記録を消したと確かめられない ($label) → 送っていなくても開いたまま (応答不明・通常決済も止める)', async ({ failRemove }) => {
    const fake = mountClients();
    failStorage({ failReadBacks: 1, failRemove });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(standardPaymentOpen(result.current)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.pending.persist-unverified', expect.anything());

    // 別の内容の支払いも作らない。
    result.current.mutate(OTHER_PARAMS);
    await waitFor(() =>
      expect(result.current.variables?.merchantAmount).toBe(OTHER_PARAMS.merchantAmount),
    );
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
  });

  it('応答不明の作り直しでも、保存できなければ送らない (元の記録のまま)', async () => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const before = window.localStorage.getItem(pendingKeys()[0]);

    replyOnce(fake, { error: { code: -32500, message: 'AA32 paymaster expired or not due' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.pendingStoreUnavailable).toBe(true));

    // 送り直し (2 回目) は断られ、作り直しの op は保存できないので送っていない。
    expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(result.current.isUnknown).toBe(true);
    expect(window.localStorage.getItem(pendingKeys()[0])).toBe(before);
  });

  it('応答不明の作り直しで読み戻しが投げる → 元の記録に書き戻したと確かめ、送らない (開いたまま)', async () => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const before = storedRecord();

    replyOnce(fake, { error: { code: -32500, message: 'AA32 paymaster expired or not due' } });
    failStorage({ failReadBacks: 1 });
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.pendingStoreUnavailable).toBe(true));

    expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(result.current.isUnknown).toBe(true);
    vi.restoreAllMocks();
    expect(storedRecord()).toEqual(before);
  });
});

describe('reload の後 (保存した記録だけ) (A-1)', () => {
  it('新しい支払いの入口は閉じ、確かめる入口だけが開く', async () => {
    const first = mountClients();
    acceptThenLoseResponse(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    const hash1 = world.hashOf(sentOp(first, 0));
    firstHook.unmount();

    // ページを読み直す: client・hook・QueryClient を作り直す。残るのは localStorage の記録と bundler の世界だけ。
    // reactStrictMode で mount → unmount → mount (effect の二重実行) を通しても同じ結果になること。
    const second = mountClients();
    const restored = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
      reactStrictMode: true,
    });
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    expect(restored.result.current.pendingUserOpHash).toBe(hash1);
    expect(restored.result.current.error).toBeNull();

    // 新しい支払い (別の内容) は通らない。
    restored.result.current.mutate(OTHER_PARAMS);
    await waitFor(() =>
      expect(restored.result.current.variables?.merchantAmount).toBe(
        OTHER_PARAMS.merchantAmount,
      ),
    );
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));
    expect(restored.result.current.isUnknown).toBe(true);
    expect(second.getNonce).not.toHaveBeenCalled();
    expect(second.prepareUserOperation).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.bundlerSend).not.toHaveBeenCalled();

    // 同じ内容でもう一度「支払う」を押しても、新しい op は作らない (確かめるだけ)。
    // bundler は op を持っているので、送り直しは「Already known」→ receipt を待つ → まだ無い → 応答不明のまま。
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(second.bundlerSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));
    expect(sentOp(second, 0)).toEqual(sentOp(first, 0));
    expect(restored.result.current.isUnknown).toBe(true);
    expect(second.getNonce).not.toHaveBeenCalled();
    expect(second.prepareUserOperation).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(world.mempoolHashes()).toEqual([hash1]);

    // mine された後に確かめる → 確定。
    world.mine();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(restored.result.current.data?.userOpHash).toBe(hash1);
    expect(world.mined).toHaveLength(1);
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
  });

  it('保存の直後にページが落ちた (送信の結果を知らない pending の記録) も、応答不明として復元する', async () => {
    const first = mountClients();
    // 送信が返らないまま (ページが落ちる)。
    first.bundlerSend.mockImplementationOnce(() => new Promise<BundlerHttpReply>(() => undefined));
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(first.bundlerSend).toHaveBeenCalledTimes(1));
    expect(storedRecord()?.status).toBe('pending');
    firstHook.unmount();

    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));

    // 確かめる → 届いていなかったので、保存した op をそのまま送る → mine → 確定。署名は要らない。
    acceptAndMine(second);
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(sentOp(second, 0)).toEqual(sentOp(first, 0));
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(world.mined).toHaveLength(1);
  });

  it('送信の控えが無い古い記録も読める: 今までどおり hash の receipt の照会だけを行う', async () => {
    const legacyHash = `0x${'c'.repeat(64)}` as Hex;
    // この欄を足す前の版が書いた記録 (send が無い)。fingerprint は確かめる経路に入れるため、今の版で作る。
    const seed = mountClients();
    acceptThenLoseResponse(seed);
    const seedHook = render();
    seedHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(seedHook.result.current.isUnknown).toBe(true));
    seedHook.unmount();
    const key = pendingKeys()[0];
    const { send: _send, ...legacy } = JSON.parse(
      window.localStorage.getItem(key) ?? '{}',
    ) as Record<string, unknown>;
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...legacy, status: 'pending', userOpHash: legacyHash }),
    );

    const fake = mountClients();
    const waitForReceipt = vi.mocked(fake.waitForUserOperationReceipt);
    waitForReceipt.mockResolvedValueOnce({
      success: true,
      actualGasCost: 5n,
      receipt: { transactionHash: `0x${'d'.repeat(64)}` as Hex, blockNumber: 9n },
    });
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    expect(restored.result.current.pendingUserOpHash).toBe(legacyHash);

    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));

    expect(waitForReceipt).toHaveBeenCalledWith({ hash: legacyHash });
    expect(restored.result.current.data?.userOpHash).toBe(legacyHash);
    // 送り直し・nonce の読み取り・1 回ずつの receipt の照会はしない (控えが無いので、できない)。
    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(fake.readContract).not.toHaveBeenCalled();
    expect(fake.getUserOperationReceipt).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
  });
});

describe('復元した記録の中の関係を確かめる (SHOULD)', () => {
  // 応答不明の記録を作って unmount する (送信は届いていない = 送り直せば成立しうる op)。
  async function seedUnknownRecord() {
    const first = mountClients({ customer: CUSTOMER_A });
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();
    return first;
  }

  // nonceRead: 'saved' = EntryPoint の nonce を記録の EntryPoint・sender で読む (照合は今の account に依存しない・Codex 第 2 回
  // MUST 3)。'none' = 記録の中が食い違うので読まない (読んでも署名済みの op の照合にならない)。
  async function expectReceiptOnly(second: Fake, nonceRead: 'saved' | 'none') {
    const saved = storedRecord();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    restored.result.current.retryReceipt();
    await waitFor(() => expect(second.waitForUserOperationReceipt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));
    // 送り直しも作り直しもしない。開いたまま。
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(restored.result.current.isUnknown).toBe(true);
    expect(standardPaymentOpen(restored.result.current)).toBe(false);
    if (nonceRead === 'none') {
      expect(second.readContract).not.toHaveBeenCalled();
    } else {
      expect(second.readContract).toHaveBeenCalledTimes(1);
      expect(second.readContract.mock.calls[0][0]).toMatchObject({
        address: saved?.send?.entryPoint,
        functionName: 'getNonce',
        args: [saved?.send?.sender, BigInt(saved?.send?.nonceKey ?? -1)],
      });
    }
  }

  it('記録の EntryPoint が今の account と違う → 同じ nonce が効かないので送らない (receipt を待つだけ)', async () => {
    await seedUnknownRecord();
    rewriteStoredRecord((record) => ({
      ...record,
      send: record.send && { ...record.send, entryPoint: entryPoint07Address },
    }));
    await expectReceiptOnly(mountClients({ customer: CUSTOMER_A }), 'saved');
  });

  it('今の client の account (sender) が記録と違う (同じ接続先のまま account の中身が変わった) → 送らない', async () => {
    await seedUnknownRecord();
    await expectReceiptOnly(mountClients({ customer: CUSTOMER_A, sender: OTHER_SENDER }), 'saved');
  });

  it('署名済みの op の nonce が記録の nonce と違う (記録の中が食い違う) → 送り直さない・作り直さない', async () => {
    await seedUnknownRecord();
    rewriteStoredRecord((record) => ({
      ...record,
      send: record.send && {
        ...record.send,
        nonceSeq: (BigInt(record.send.nonceSeq) + 1n).toString(),
      },
    }));
    await expectReceiptOnly(mountClients({ customer: CUSTOMER_A }), 'none');
  });

  it('署名済みの op の sender が記録の sender と違う → 送り直さない・作り直さない', async () => {
    await seedUnknownRecord();
    rewriteStoredRecord((record) => ({
      ...record,
      send: record.send && {
        ...record.send,
        signedUserOp: { ...record.send.signedUserOp, sender: OTHER_SENDER },
      },
    }));
    await expectReceiptOnly(mountClients({ customer: CUSTOMER_A }), 'none');
  });

  it('接続先を別の account に切り替えると、その account の支払いは別の範囲 (前の account の記録は残り、戻ると開いたまま)', async () => {
    const fake = mountClients({ customer: CUSTOMER_A });
    acceptThenLoseResponse(fake);
    const hook = render();
    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));

    mockHook(useAccount, { chainId: baseSepolia.id, address: CUSTOMER_B });
    hook.rerender();
    await waitFor(() => expect(hook.result.current.isUnknown).toBe(false));
    acceptAndMine(fake);
    hook.result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(fake.getNonce).toHaveBeenCalledTimes(2);
    // A の記録はそのまま。
    expect(pendingKeys()).toHaveLength(1);
    expect(pendingKeys()[0]).toContain(CUSTOMER_A.toLowerCase());

    mockHook(useAccount, { chainId: baseSepolia.id, address: CUSTOMER_A });
    hook.rerender();
    await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
    expect(standardPaymentOpen(hook.result.current)).toBe(false);
  });
});

describe('送信を分ける部品の遅延読み込み (bundle の予算)', () => {
  // intent の関所 lib/smartAccount/pimlicoIntent.ts (送信の部品 pimlicoSend.ts を読む) は、Pimlico の経路で使うときに
  // hook が dynamic import する。読み込みの失敗を作る。
  function failPimlicoSendImport() {
    vi.doMock('@/lib/smartAccount/pimlicoIntent', () => {
      throw new Error('chunk load failed');
    });
  }
  afterEach(() => {
    vi.doUnmock('@/lib/smartAccount/pimlicoIntent');
  });

  it('順番は nonce → 準備 → 署名 → 保存 → 送信 のまま (読み込みは nonce の前)', async () => {
    const fake = mountClients();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    acceptAndMine(fake);
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const firstPersist = setItem.mock.calls.findIndex(([key]) =>
      String(key).startsWith(PIMLICO_PENDING_KEY_PREFIX),
    );
    const order = [
      fake.getNonce.mock.invocationCallOrder[0],
      fake.prepareUserOperation.mock.invocationCallOrder[0],
      fake.signUserOperation.mock.invocationCallOrder[0],
      setItem.mock.invocationCallOrder[firstPersist],
      fake.bundlerSend.mock.invocationCallOrder[0],
    ];
    expect(order.every((n) => n !== undefined)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('新しい支払いで読み込みに失敗 → 今までどおりの error (応答不明にしない)。nonce・署名・保存・送信はどれもしない', async () => {
    const fake = mountClients();
    const { result } = render();
    failPimlicoSendImport();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));

    // 読み込みの error がそのまま届く (vitest は mock の factory が投げた error を「mock の読み込みに失敗した」で包む)。
    expect(result.current.error?.message).toMatch(/error when mocking a module/);
    expect(result.current.error?.name).not.toBe('PimlicoResponseUnknownError');
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.pendingStoreUnavailable).toBe(false);
    expect(standardPaymentOpen(result.current)).toBe(true);
    expect(fake.getNonce).not.toHaveBeenCalled();
    expect(fake.prepareUserOperation).not.toHaveBeenCalled();
    expect(fake.signUserOperation).not.toHaveBeenCalled();
    expect(fake.bundlerSend).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
  });

  it('開いている intent があるときに読み込みに失敗 → 開いたまま (memory に無く storage から読んだ記録も先にラッチする)', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();

    // mount の時の読み出しだけ失敗させる (memory に記録が無いまま、次の送信で storage から読む)。
    const second = mountClients();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new DOMException('read failed', 'UnknownError');
    });
    const restored = render();
    expect(restored.result.current.isUnknown).toBe(false);
    failPimlicoSendImport();

    // 同じ内容 (記録の calls と同じ) で押す: 内容の照合を通り、部品の読み込みまで進む。
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    // 読み込みの失敗で終わった (照合も送信もしていない) が、画面には出さず開いたまま。
    expect(restored.result.current.isError).toBe(true);
    expect(restored.result.current.error).toBeNull();
    expect(standardPaymentOpen(restored.result.current)).toBe(false);
    expect(second.getNonce).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.getUserOperationReceipt).not.toHaveBeenCalled();
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(1);
  });
});

describe('hash の扱いと、分けない client (A-1)', () => {
  it('bundler の返した hash が計算と違う → 返った hash を正として記録を直し、warn を残す', async () => {
    const fake = mountClients();
    const returned = `0x${'e'.repeat(64)}` as Hex;
    fake.bundlerSend.mockImplementationOnce(async ({ params }) => {
      world.accept(params[0]);
      return { result: returned };
    });
    const waitForReceipt = vi.mocked(fake.waitForUserOperationReceipt);
    waitForReceipt.mockRejectedValueOnce(new Error('UserOperationReceiptTimeoutError'));
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    const computed = world.hashOf(sentOp(fake, 0));
    expect(computed).not.toBe(returned);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.send.hash-mismatch', {
      computed,
      returned,
    });
    expect(waitForReceipt).toHaveBeenCalledWith({ hash: returned });
    expect(result.current.pendingUserOpHash).toBe(returned);
    expect(storedRecord()?.userOpHash).toBe(returned);
    // nonce と署名済みの op はそのまま (安全の根拠は nonce)。
    expect(recordNonce(storedRecord())).toBe(BigInt(sentOp(fake, 0).nonce as Hex));
  });

  it('MAv2 (aa-sdk の facade) は今までどおり sendUserOperation を呼ぶ: 分けない・送信の控えを書かない', async () => {
    const hash = `0x${'a'.repeat(64)}` as Hex;
    const sendUserOperation = vi.fn(async (_parameters: { calls: unknown[] }) => hash);
    const waitForUserOperationReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error('UserOperationReceiptTimeoutError'));
    const getUserOperationGasPrice = vi.fn(async () => {
      const tier = { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n };
      return { slow: tier, standard: tier, fast: tier };
    });
    // lib/smartAccount/mav2.ts が返す形: smartAccountClient は { sendUserOperation } だけ。
    mockHook(useSmartAccount, {
      data: {
        provider: 'pimlico',
        entryPointVersion: '0.7',
        smartAccountClient: { sendUserOperation },
        pimlicoClient: { waitForUserOperationReceipt, getUserOperationGasPrice },
        paymasterMode: 'sponsorship',
      },
      isLoading: false,
      error: null,
    } as never);
    mockHook(useAccount, { chainId: baseSepolia.id });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    expect(sendUserOperation).toHaveBeenCalledTimes(1);
    expect(sendUserOperation.mock.calls[0][0].calls).toHaveLength(1);
    // 今までどおり hash が返った後に記録する。送信の控え (nonce・署名済みの op) は無い。
    const record = storedRecord();
    expect(record).toMatchObject({ status: 'unknown', userOpHash: hash });
    expect(record?.send).toBeUndefined();
  });

  it('MAv2 (facade) の sendUserOperation が throw したときの扱いも今までのまま (通常の error・記録なし)', async () => {
    const sendUserOperation = vi.fn(async () => {
      throw bundlerTimeout();
    });
    const getUserOperationGasPrice = vi.fn(async () => {
      const tier = { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n };
      return { slow: tier, standard: tier, fast: tier };
    });
    mockHook(useSmartAccount, {
      data: {
        provider: 'pimlico',
        entryPointVersion: '0.7',
        smartAccountClient: { sendUserOperation },
        pimlicoClient: { waitForUserOperationReceipt: vi.fn(), getUserOperationGasPrice },
        paymasterMode: 'sponsorship',
      },
      isLoading: false,
      error: null,
    } as never);
    mockHook(useAccount, { chainId: baseSepolia.id });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));

    // この PR は MAv2 の送信を変えない (分けられない)。本番では JPYC は relay・USDC は MAv2 非対応で、ここに来ない。
    expect(result.current.isUnknown).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
  });
});

// ---- Codex 第 2 回レビュー (REQUEST CHANGES) の 3 件 ----------------------------------------------------------------

// 1 回目の書き込みは通り、その読み戻しが投げる。片付け (removeItem) は通り、消えたかの確かめ (getItem) が投げる。
// その後の書き込みはずっと投げる (Codex 第 2 回 MUST 1 の再現の storage)。
function failStorageAfterPartialCleanup() {
  const realGet = Storage.prototype.getItem;
  const realSet = Storage.prototype.setItem;
  const realRemove = Storage.prototype.removeItem;
  let writes = 0;
  let failNextGet = false;
  const isPending = (key: string) => key.startsWith(PIMLICO_PENDING_KEY_PREFIX);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (!isPending(key)) return realSet.call(this, key, value);
    writes += 1;
    if (writes > 1) throw new DOMException('quota', 'QuotaExceededError');
    realSet.call(this, key, value);
    failNextGet = true;
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    if (failNextGet && isPending(key)) {
      failNextGet = false;
      throw new DOMException('read failed', 'UnknownError');
    }
    return realGet.call(this, key);
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    realRemove.call(this, key);
    if (isPending(key)) failNextGet = true;
  });
}

describe('送る前に保存を確かめる: memory にだけ残った署名済みの op は送らない (Codex 第 2 回 MUST 1)', () => {
  it('保存の読み戻しが投げ、片付けの確かめも投げ、その後は書けない → 「同じ送信内容を再確認」で送らない。reload の後の支払いと合わせて、EntryPoint が実行する支払いは 1 本だけ (Codex の再現)', async () => {
    const first = mountClients();
    failStorageAfterPartialCleanup();
    const hook = render();

    hook.result.current.mutate(PARAMS);
    await waitFor(() => expect(hook.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    // 送っていない。storage には残っていない (片付けは効いたが、確かめられなかった)。memory のラッチだけが残る。
    expect(first.bundlerSend).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
    expect(standardPaymentOpen(hook.result.current)).toBe(false);

    // 「同じ送信内容を再確認」: 照合 (receipt・nonce) は読むが、送る前に保存を確かめられないので送らない。
    // 送っていれば、bundler は受理して応答だけ失われる (直す前はこの op が mempool に入っていた)。
    acceptThenLoseResponse(first);
    hook.result.current.retryReceipt();
    await waitFor(() => expect(first.readContract).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    expect(first.bundlerSend).not.toHaveBeenCalled();
    expect(world.mempoolHashes()).toHaveLength(0);
    expect(hook.result.current.isUnknown).toBe(true);
    expect(hook.result.current.pendingStoreUnavailable).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(standardPaymentOpen(hook.result.current)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('pimlico.send.not-stored', expect.anything());
    hook.unmount();
    vi.restoreAllMocks();

    // reload: 記録は無いので、新しい支払い (別の nonce) が通る。
    const second = mountClients();
    const restored = render();
    expect(restored.result.current.isUnknown).toBe(false);
    acceptAndMine(second);
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));

    // bundler に残っている op があれば、それも mine される (直す前: 1 本目の 10 USDC も成立して 2 本)。
    for (const hash of world.mempoolHashes()) world.mine(hash);
    expect(world.mined).toHaveLength(1);
  });

  it('送り直しの前に、storage に同じ記録があれば書き直さずに送る (読めるだけで確かめられる)', async () => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    acceptAndMine(fake);
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fake.bundlerSend).toHaveBeenCalledTimes(2);
    expect(setItem.mock.calls.filter(([key]) => String(key).startsWith(PIMLICO_PENDING_KEY_PREFIX))).toEqual([]);
  });

  it('memory にだけある記録でも、書けるようになっていれば書いて読み戻してから送る (reload の後も同じ op を確かめられる)', async () => {
    const fake = mountClients();
    failStorageAfterPartialCleanup();
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(pendingKeys()).toHaveLength(0);
    vi.restoreAllMocks();

    loseRequest(fake);
    result.current.retryReceipt();
    await waitFor(() => expect(fake.bundlerSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    // 送る前に保存した記録 = 送った op。
    expect(storedRecord()?.send?.signedUserOp).toEqual(sentOp(fake, 0));
    expect(result.current.pendingStoreUnavailable).toBe(false);
    expect(result.current.isUnknown).toBe(true);
  });
});

describe('別の intent の確定は、その intent 自体の受取先・金額だけで記録する (Codex 第 2 回 MUST 2)', () => {
  it('reload の後に確定した intent は recoveredIntent に保存した params を返す (今の画面の店・注文と組み合わせる材料を出さない)', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();

    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    acceptAndMine(second);
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));

    expect(usdcDep.chainId).toBe(baseSepolia.id);
    expect(restored.result.current.settledOtherIntent).toBe(true);
    expect(restored.result.current.recoveredIntent).toEqual(PARAMS);
  });

  it('画面から送った支払いの確定では recoveredIntent は無い', async () => {
    const fake = mountClients();
    acceptAndMine(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.settledOtherIntent).toBe(false);
    expect(result.current.recoveredIntent).toBeNull();
  });

  it('記録の chain が今の画面の deployment と違う → 帰属を確かめられないので recoveredIntent は null (履歴・控えを書かない)', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();

    // 同じ token の address を別の chain に持つ画面 (JPYC は chain をまたいで同じ address)。ウォレットは記録の chain のまま。
    const otherChainDep = { ...usdcDep, chainId: 11_155_111 };
    const second = mountClients();
    const restored = renderHook(() => useBatchPayment(otherChainDep), { wrapper: makeWrapper() });
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    acceptAndMine(second);
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));

    expect(restored.result.current.settledOtherIntent).toBe(true);
    expect(restored.result.current.recoveredIntent).toBeNull();
  });
});

describe('照合 (読むだけ) は今の account で送れるかに依存しない (Codex 第 2 回 MUST 3)', () => {
  // 委任を外した (pristine に戻した): useSmartAccount は client を作らない (pristine を弾く)。
  function revokeDelegation() {
    mockHook(useSmartAccount, { data: undefined, isLoading: false, error: new Error('pristine') });
    mockHook(useAccount, { chainId: baseSepolia.id });
  }

  // 応答不明の記録を作って unmount する。delivered = bundler に届いて mempool にある (mine は test が決める)。
  async function seedOpenIntent(delivered: boolean) {
    const first = mountClients();
    if (delivered) acceptThenLoseResponse(first);
    else loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    const hash = (storedRecord() as StoredRecord).userOpHash;
    firstHook.unmount();
    return hash;
  }

  async function renderRestored() {
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    expect(standardPaymentOpen(restored.result.current)).toBe(false);
    return restored;
  }

  it('委任を外した後、7 日を過ぎた記録: receipt も nonce の使用も無い → 照合で閉じ、通常決済が開く (Codex の再現)', async () => {
    const hash = await seedOpenIntent(false);
    ageStoredRecord();
    revokeDelegation();
    const lookups = routePimlicoReceiptApi(world);
    const pub = fakePublicClient(world);
    vi.mocked(usePublicClient).mockReturnValue(pub.client as never);

    const restored = await renderRestored();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(false));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    expect(lookups).toHaveBeenCalledWith(hash);
    expect(pub.readContract).toHaveBeenCalledTimes(1);
    expect(pub.readContract.mock.calls[0][0]).toMatchObject({
      address: world.entryPoint,
      functionName: 'getNonce',
    });
    expect(pendingKeys()).toHaveLength(0);
    expect(restored.result.current.error).toBeNull();
    expect(standardPaymentOpen(restored.result.current)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'pimlico.pending.expired-closed',
      expect.objectContaining({ state: 'open' }),
    );
  });

  it('委任を外した後でも、op が取り込まれていれば receipt で確定する (期限の前)', async () => {
    const hash = await seedOpenIntent(true);
    world.mine(hash);
    revokeDelegation();
    routePimlicoReceiptApi(world);
    vi.mocked(usePublicClient).mockReturnValue(fakePublicClient(world).client as never);

    const restored = await renderRestored();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));

    expect(restored.result.current.data).toMatchObject({ userOpHash: hash, success: true });
    expect(restored.result.current.isUnknown).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
    expect(world.mined).toHaveLength(1);
  });

  it('委任を外した後、期限の前で receipt も無い → 送らずに開いたまま。照合は記録を書き換えない (期限を延ばさない) ので、7 日を過ぎた後の照合で閉じる', async () => {
    await seedOpenIntent(false);
    const before = window.localStorage.getItem(pendingKeys()[0]);
    revokeDelegation();
    routePimlicoReceiptApi(world);
    vi.mocked(usePublicClient).mockReturnValue(fakePublicClient(world).client as never);

    const restored = await renderRestored();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));
    await waitFor(() => expect(logger.warn).toHaveBeenCalledWith('pimlico.verify.send-unavailable', expect.anything()));
    expect(restored.result.current.isUnknown).toBe(true);
    expect(standardPaymentOpen(restored.result.current)).toBe(false);
    expect(window.localStorage.getItem(pendingKeys()[0])).toBe(before);
    expect(world.mempoolHashes()).toHaveLength(0);
    restored.unmount();

    // 7 日後に戻る (記録の時刻は最後に送った時のまま)。
    ageStoredRecord();
    const later = await renderRestored();
    later.result.current.retryReceipt();
    await waitFor(() => expect(later.result.current.isUnknown).toBe(false));
    expect(pendingKeys()).toHaveLength(0);
    expect(standardPaymentOpen(later.result.current)).toBe(true);
  });

  it('照合に要る chain の client が読めない (wagmi の public client が無い・別の chain) → 7 日を過ぎていても開いたまま。読めるようになったら閉じる', async () => {
    await seedOpenIntent(false);
    ageStoredRecord();
    revokeDelegation();
    routePimlicoReceiptApi(world);
    vi.mocked(usePublicClient).mockReturnValue(fakePublicClient(world, 1).client as never);

    const restored = await renderRestored();
    restored.result.current.retryReceipt();
    await waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('pimlico.verify.probe-failed', expect.anything()),
    );
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));
    expect(restored.result.current.isUnknown).toBe(true);
    expect(pendingKeys()).toHaveLength(1);
    expect(standardPaymentOpen(restored.result.current)).toBe(false);

    vi.mocked(usePublicClient).mockReturnValue(fakePublicClient(world).client as never);
    restored.rerender();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(false));
    expect(pendingKeys()).toHaveLength(0);
  });

  it('記録の EntryPoint が今の account と違う (委任先を変えた) → 送らないが、7 日を過ぎていれば記録の EntryPoint の nonce を読んで閉じる (Codex の再現)', async () => {
    await seedOpenIntent(false);
    rewriteStoredRecord((record) => ({
      ...record,
      send: record.send && { ...record.send, entryPoint: entryPoint07Address },
    }));
    ageStoredRecord();
    const second = mountClients();

    const restored = await renderRestored();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(false));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    expect(second.readContract.mock.calls[0][0]).toMatchObject({ address: entryPoint07Address });
    expect(second.bundlerSend).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.waitForUserOperationReceipt).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
    expect(standardPaymentOpen(restored.result.current)).toBe(true);
  });

  it('Circle の経路に切り替わった後も、7 日を過ぎた Pimlico の記録を照合で閉じる (送らない)', async () => {
    await seedOpenIntent(false);
    ageStoredRecord();
    mockHook(useSmartAccount, {
      data: { provider: 'circle' },
      isLoading: false,
      error: null,
    } as never);
    mockHook(useAccount, { chainId: baseSepolia.id });
    routePimlicoReceiptApi(world);
    vi.mocked(usePublicClient).mockReturnValue(fakePublicClient(world).client as never);

    const restored = await renderRestored();
    restored.result.current.retryReceipt();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(false));
    expect(pendingKeys()).toHaveLength(0);
    expect(world.mempoolHashes()).toHaveLength(0);
  });
});
