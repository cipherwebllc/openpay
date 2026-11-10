// 第 10 回レビュー A-1 (P1・money-path): Pimlico の送信の応答を失っても、記録とラッチが残り、
// 再試行が別の nonce の UserOperation (= 二重払い) にならないこと。
//
// 失敗シナリオ (直す前): bundler は UserOperation を受理したが、応答が http の timeout (10 秒) を超える。
// sendUserOperation が throw し、hash も記録も無いまま通常の error で終わる。1 本目は mine される。
// お客様がもう一度押して署名すると、別の nonce key の 2 本目も成立する。
//
// 直した後: nonce を決める → 準備 → 署名 → **保存** (hash・署名済みの op・nonce) → 送信。
// 安全の根拠は nonce の固定 (EntryPoint は同じ nonce の op を最大 1 本しか実行しない)。
//
// mock は境界だけ (useSmartAccount が返す client・bundler・EntryPoint = tests/_helpers/fakePimlicoBundler.ts、
// wagmi、logger)。hook と lib/smartAccount/pimlicoSend.ts は実物。
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
  bundlerJsonRpcError,
  bundlerTimeout,
  createFakeBundlerWorld,
  fakePimlicoClients,
  type FakeBundlerWorld,
} from '../_helpers/fakePimlicoBundler';

const usdcDep = defaultDeploymentForSymbol('usdc');
const TOKEN: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const MERCHANT: Address = getAddress('0x1111111111111111111111111111111111111111');
const FEE_RECV: Address = getAddress('0x2222222222222222222222222222222222222222');

const PARAMS = {
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  merchantAmount: 10_000_000n,
  feeReceiver: FEE_RECV,
  feeAmount: 0n,
};
// 金額だけ違う別の支払い。
const OTHER_PARAMS = { ...PARAMS, merchantAmount: 20_000_000n };

type SignedOp = Record<string, unknown>;
type StoredRecord = {
  status: string;
  userOpHash: Hex;
  callFingerprint: Hex;
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
function mountClients() {
  const fake = fakePimlicoClients({ world });
  mockHook(useSmartAccount, { data: fake.data, isLoading: false, error: null });
  mockHook(useAccount, { chainId: baseSepolia.id });
  return fake;
}

type Fake = ReturnType<typeof mountClients>;

// bundler が op を受理した後、応答だけが失われる (A-1 の失敗シナリオ)。
function acceptThenLoseResponse(fake: Fake) {
  fake.request.mockImplementationOnce(async ({ params }) => {
    world.accept(params[0]);
    throw bundlerTimeout();
  });
}

// op が bundler に届かないまま timeout する。
function loseRequest(fake: Fake) {
  fake.request.mockImplementationOnce(async () => {
    throw bundlerTimeout();
  });
}

// bundler が受理し、すぐ mine される (receipt が取れる)。
function acceptAndMine(fake: Fake) {
  fake.request.mockImplementationOnce(async ({ params }) => {
    const hash = world.accept(params[0]);
    world.mine(hash);
    return hash;
  });
}

function sentOp(fake: Fake, index: number): SignedOp {
  return fake.request.mock.calls[index][0].params[0];
}

function render() {
  return renderHook(() => useBatchPayment(usdcDep), { wrapper: makeWrapper() });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  world = createFakeBundlerWorld({ chainId: baseSepolia.id });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('署名 → 保存 → 送信の順 (A-1)', () => {
  it('送信の時点で、hash・署名済みの op・nonce (key と seq) が保存されている', async () => {
    const fake = mountClients();
    let atSend: StoredRecord | null = null;
    fake.request.mockImplementationOnce(async ({ params }) => {
      atSend = storedRecord();
      const hash = world.accept(params[0]);
      world.mine(hash);
      return hash;
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

    // 送信は raw の eth_sendUserOperation を 1 回 (再送なし)。
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.request.mock.calls[0][0].method).toBe('eth_sendUserOperation');
    expect(fake.request.mock.calls[0][0].params[1]).toBe(world.entryPoint);
    expect(fake.request.mock.calls[0][1]).toEqual({ retryCount: 0 });

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
    expect(logger.warn).not.toHaveBeenCalledWith('pimlico.send.hash-mismatch', expect.anything());
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
  });

  it('bundler が受理した後に応答だけ失われる (timeout) → 通常の error にせず応答不明にラッチし、再試行は新しい op を作らない', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));

    const op = sentOp(fake, 0);
    // 通常の失敗として見せない (見せると画面が再試行を開ける)。
    expect(result.current.error).toBeNull();
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
    expect(fake.request).toHaveBeenCalledTimes(1);
    // 確定した支払いは 1 本だけ。
    expect(world.mined).toHaveLength(1);
    expect(result.current.data?.userOpHash).toBe(world.hashOf(op));
    expect(result.current.data?.success).toBe(true);
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
    expect(fake.request).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(fake.request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isUnknown).toBe(true);
    expect(fake.request.mock.calls[1][0]).toEqual(fake.request.mock.calls[0][0]);
    expect(fake.request.mock.calls[1][1]).toEqual({ retryCount: 0 });
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
    expect(fake.request).toHaveBeenCalledTimes(1);
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
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(storedRecord()?.status).toBe('unknown');
  });
});

describe('bundler が断った送信と、同じ nonce での作り直し (A-1)', () => {
  it('bundler が JSON-RPC の error で断った → 今までどおりの error (応答不明にしない)。次の送信は同じ nonce で作り直す', async () => {
    const fake = mountClients();
    fake.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));

    // viem の sendUserOperation が投げるのと同じ形の error。応答不明ではない。
    expect(result.current.error?.name).toBe('UserOperationExecutionError');
    expect(result.current.error?.message).toContain('internal error');
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.pendingUserOpHash).toBeUndefined();
    // 記録は消さない (nonce の予約として残す)。
    const rejected = storedRecord();
    expect(rejected?.status).toBe('rejected');
    const firstOp = sentOp(fake, 0);
    expect(recordNonce(rejected)).toBe(BigInt(firstOp.nonce as Hex));

    // お客様がもう一度押す → 作り直し (署名は 2 回目)。
    acceptAndMine(fake);
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const secondOp = sentOp(fake, 1);
    // 作り直しの op の nonce は 1 本目と同じ。nonce を採り直していない。
    expect(secondOp.nonce).toBe(firstOp.nonce);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    expect(fake.prepareUserOperation).toHaveBeenCalledTimes(2);
    expect(fake.prepareUserOperation.mock.calls[1][0].nonce).toBe(BigInt(firstOp.nonce as Hex));
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(world.mined).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('断られた後に金額を変えた支払いも、同じ nonce で作る (別の nonce の op を作る道が無い)', async () => {
    const fake = mountClients();
    fake.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32005, 'rate limit exceeded');
    });
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));
    const firstRecord = storedRecord();

    let atSecondSend: StoredRecord | null = null;
    fake.request.mockImplementationOnce(async ({ params }) => {
      atSecondSend = storedRecord();
      const hash = world.accept(params[0]);
      world.mine(hash);
      return hash;
    });
    result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(sentOp(fake, 1).nonce).toBe(sentOp(fake, 0).nonce);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    const second = atSecondSend as StoredRecord | null;
    expect(second?.callFingerprint).not.toBe(firstRecord?.callFingerprint);
    // 別の内容の支払いなので、前の op の hash は「同じ支払いの作り直し」としては引き継がない。
    expect(second?.send?.priorUserOpHashes).toBeUndefined();
    expect(world.mined).toHaveLength(1);
  });

  it('元の op が mempool に残ったまま作り直しても、確定するのは 1 本だけ (EntryPoint が同じ nonce の 2 本目を AA25 で断る)', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const op1 = sentOp(fake, 0);
    const hash1 = world.hashOf(op1);

    // 確かめる: 送り直しに bundler が一時的な error (internal) で答える。元の op は mempool に残っている。
    fake.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    result.current.retryReceipt();
    // → 同じ nonce で作り直す (署名 2 回目) → bundler は同じ nonce の別の op を「Replacement underpriced」で断る。
    await waitFor(() => expect(fake.request).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const op2 = sentOp(fake, 2);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(op2.nonce).toBe(op1.nonce);
    expect(op2).not.toEqual(op1);
    expect(fake.getNonce).toHaveBeenCalledTimes(1);
    // 応答不明のまま。通常の error にも、新しい支払いにも開かない。
    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
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

  it('作り直しより先に元の op が取り込まれていたら、作り直しは AA25 で落ち、元の op の receipt で確定する', async () => {
    const fake = mountClients();
    acceptThenLoseResponse(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const hash1 = world.hashOf(sentOp(fake, 0));

    // 確かめる: nonce を読んだ直後に元の op が mine され、送り直しは AA25 で断られる (読みと送りの間の隙間)。
    fake.request.mockImplementationOnce(async ({ params }) => {
      world.mine(hash1);
      return world.accept(params[0]);
    });
    result.current.retryReceipt();
    await waitFor(() => expect(fake.request).toHaveBeenCalledTimes(3));
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

    // 送り直しを bundler が断る (paymaster の期限切れ) → 作り直しの署名をお客様が断る。
    fake.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32500, 'AA32 paymaster expired or not due');
    });
    fake.signUserOperation.mockRejectedValueOnce(new Error('User rejected the request.'));
    result.current.retryReceipt();
    await waitFor(() => expect(fake.signUserOperation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.isUnknown).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fake.request).toHaveBeenCalledTimes(2);
    const after = storedRecord();
    expect(after?.userOpHash).toBe(before?.userOpHash);
    expect(after?.send?.signedUserOp).toEqual(before?.send?.signedUserOp);
    expect(after?.send?.priorUserOpHashes).toBeUndefined();
  });

  it('断られたはずの op が実は取り込まれていた → 次の送信は新しい op を作らず、その receipt で確定する', async () => {
    const fake = mountClients();
    // bundler は op を mempool に入れた後で error を返した。
    fake.request.mockImplementationOnce(async ({ params }) => {
      world.accept(params[0]);
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isUnknown).toBe(false);
    const hash1 = world.hashOf(sentOp(fake, 0));
    world.mine(hash1);

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.userOpHash).toBe(hash1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(world.mined).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(0);
  });

  it('断られたはずの op が取り込まれていたとき、別の内容の支払いは通さず、元の支払いの結果不明として保持する', async () => {
    const fake = mountClients();
    fake.request.mockImplementationOnce(async ({ params }) => {
      world.accept(params[0]);
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));
    const hash1 = world.hashOf(sentOp(fake, 0));
    world.mine(hash1);

    result.current.mutate(OTHER_PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.pendingUserOpHash).toBe(hash1);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(storedRecord()?.status).toBe('unknown');

    // 確かめる → 元の支払いの結果として確定する。
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.userOpHash).toBe(hash1);
    expect(result.current.variables?.merchantAmount).toBe(PARAMS.merchantAmount);
    expect(world.mined).toHaveLength(1);
  });

  it('断られた後の再試行で照会が失敗 → 通常の error のまま、何も作らない (記録も変えない)', async () => {
    const fake = mountClients();
    fake.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isError).toBe(true));
    const before = window.localStorage.getItem(pendingKeys()[0]);

    fake.readContract.mockRejectedValueOnce(new Error('eth_call failed'));
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.error?.message).toBe('eth_call failed'));

    expect(result.current.isUnknown).toBe(false);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(pendingKeys()[0])).toBe(before);
  });
});

describe('保存できないときは送らない (A-1)', () => {
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
    expect(fake.request).not.toHaveBeenCalled();
    expect(world.mempoolHashes()).toHaveLength(0);
    // 送っていないので応答不明 (= 通常決済も止める) にはしない。通常の failure にも流さない (専用の文言)。
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.error).toBeNull();
    expect(pendingKeys()).toHaveLength(0);
  });

  it('書き込みは通るが読み戻すと違う (保存を確かめられない) → 送信しない', async () => {
    const fake = mountClients();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    const { result } = render();

    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.pendingStoreUnavailable).toBe(true));

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.current.isUnknown).toBe(false);
  });

  it('応答不明の作り直しでも、保存できなければ送らない (元の記録のまま)', async () => {
    const fake = mountClients();
    loseRequest(fake);
    const { result } = render();
    result.current.mutate(PARAMS);
    await waitFor(() => expect(result.current.isUnknown).toBe(true));
    const before = window.localStorage.getItem(pendingKeys()[0]);

    fake.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32500, 'AA32 paymaster expired or not due');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    result.current.retryReceipt();
    await waitFor(() => expect(result.current.pendingStoreUnavailable).toBe(true));

    // 送り直し (2 回目) は断られ、作り直しの op は保存できないので送っていない。
    expect(fake.request).toHaveBeenCalledTimes(2);
    expect(fake.signUserOperation).toHaveBeenCalledTimes(2);
    expect(result.current.isUnknown).toBe(true);
    expect(window.localStorage.getItem(pendingKeys()[0])).toBe(before);
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
    expect(second.request).not.toHaveBeenCalled();

    // 同じ内容でもう一度「支払う」を押しても、新しい op は作らない (確かめるだけ)。
    // bundler は op を持っているので、送り直しは「Already known」→ receipt を待つ → まだ無い → 応答不明のまま。
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(second.request).toHaveBeenCalledTimes(1));
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
    first.request.mockImplementationOnce(() => new Promise<Hex>(() => undefined));
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(first.request).toHaveBeenCalledTimes(1));
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

  it('断られた送信の記録 (rejected) は、reload の後も画面を応答不明にせず、次の送信を保存した nonce で作る', async () => {
    const first = mountClients();
    first.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isError).toBe(true));
    const firstNonce = sentOp(first, 0).nonce;
    firstHook.unmount();

    const second = mountClients();
    const restored = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
      reactStrictMode: true,
    });
    // 記録はあるが、応答不明ではない。
    expect(storedRecord()?.status).toBe('rejected');
    expect(restored.result.current.isUnknown).toBe(false);
    expect(restored.result.current.pendingUserOpHash).toBeUndefined();

    acceptAndMine(second);
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(restored.result.current.isUnknown).toBe(false);
    expect(sentOp(second, 0).nonce).toBe(firstNonce);
    expect(second.getNonce).not.toHaveBeenCalled();
    expect(world.mined).toHaveLength(1);
  });

  // 記録の EntryPoint を、今の account の EntryPoint (0.8) と違うもの (0.7) に書き換える
  // = 記録を書いた後に account の種類 (委任先) が変わった状態。
  function rewriteRecordEntryPoint() {
    const key = pendingKeys()[0];
    const record = JSON.parse(window.localStorage.getItem(key) ?? '{}') as StoredRecord;
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...record, send: { ...record.send, entryPoint: entryPoint07Address } }),
    );
  }

  it('記録の EntryPoint が今の account と違う → 同じ nonce が効かないので送らない (receipt を待つだけ)', async () => {
    const first = mountClients();
    loseRequest(first);
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isUnknown).toBe(true));
    firstHook.unmount();
    rewriteRecordEntryPoint();

    const second = mountClients();
    const restored = render();
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    restored.result.current.retryReceipt();
    await waitFor(() => expect(second.waitForUserOperationReceipt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    // 別の EntryPoint の上では「同じ nonce は 1 本だけ」が成り立たない。送り直しも作り直しもしない。
    expect(second.request).not.toHaveBeenCalled();
    expect(second.readContract).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(restored.result.current.isUnknown).toBe(true);
  });

  it('断られた送信の記録でも、EntryPoint が今の account と違えば新しい op を作らない (結果不明として保持)', async () => {
    const first = mountClients();
    first.request.mockImplementationOnce(async () => {
      throw bundlerJsonRpcError(-32603, 'internal error');
    });
    const firstHook = render();
    firstHook.result.current.mutate(PARAMS);
    await waitFor(() => expect(firstHook.result.current.isError).toBe(true));
    firstHook.unmount();
    rewriteRecordEntryPoint();

    const second = mountClients();
    const restored = render();
    expect(restored.result.current.isUnknown).toBe(false);
    restored.result.current.mutate(PARAMS);
    await waitFor(() => expect(restored.result.current.isUnknown).toBe(true));
    await waitFor(() => expect(restored.result.current.isPending).toBe(false));

    expect(second.getNonce).not.toHaveBeenCalled();
    expect(second.signUserOperation).not.toHaveBeenCalled();
    expect(second.request).not.toHaveBeenCalled();
    expect(storedRecord()?.status).toBe('unknown');
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
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.readContract).not.toHaveBeenCalled();
    expect(fake.getUserOperationReceipt).not.toHaveBeenCalled();
    expect(pendingKeys()).toHaveLength(0);
  });
});

describe('hash の扱いと、分けない client (A-1)', () => {
  it('bundler の返した hash が計算と違う → 返った hash を正として記録を直し、warn を残す', async () => {
    const fake = mountClients();
    const returned = `0x${'e'.repeat(64)}` as Hex;
    fake.request.mockImplementationOnce(async ({ params }) => {
      world.accept(params[0]);
      return returned;
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
