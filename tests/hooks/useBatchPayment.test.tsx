import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { base, baseSepolia, polygon } from 'viem/chains';
import type { ReactNode } from 'react';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { GasCongestedError } from '@/lib/gasCeiling';
import { defaultDeploymentForSymbol, type PaymasterMode } from '@/lib/tokens';

const usdcDep = defaultDeploymentForSymbol('usdc');
const jpycDep = defaultDeploymentForSymbol('jpyc');

// 外部依存である useSmartAccount を境界モック。テスト対象 (useBatchPayment)
// の実コードは実行され、calls 配列の組み立てや encodeFunctionData の動作が
// 実際にチェックされる。
vi.mock('@/hooks/useSmartAccount', () => ({
  useSmartAccount: vi.fn(),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
}));
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useAccount } from 'wagmi';
import { mockHook } from '../_helpers/wagmiMock';

const TOKEN: Address = getAddress(
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
);
const MERCHANT: Address = getAddress(
  '0x1111111111111111111111111111111111111111',
);
const FEE_RECV: Address = getAddress(
  '0x2222222222222222222222222222222222222222',
);

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const GWEI = 10n ** 9n;

let sendUserOperation: ReturnType<typeof vi.fn>;
let waitForUserOperationReceipt: ReturnType<typeof vi.fn>;
let getUserOperationGasPrice: ReturnType<typeof vi.fn>;

// useBatchPayment は gasless 経路でのみ呼ばれるため、'unavailable' は到達不能。
// テストの paymasterMode も SmartAccountBundle と同じ narrow union を使う。
type GaslessPaymasterMode = Exclude<PaymasterMode, 'unavailable'>;

function mountReady(opts?: {
  maxFeePerGas?: bigint;
  chainId?: number;
  paymasterMode?: GaslessPaymasterMode;
}) {
  // testnet (Base Sepolia, 既定 ceiling 1000 gwei) を使い、観測値はその下を既定。
  const maxFeePerGas = opts?.maxFeePerGas ?? 50n * GWEI;
  const chainId = opts?.chainId ?? baseSepolia.id;
  const paymasterMode: GaslessPaymasterMode = opts?.paymasterMode ?? 'sponsorship';

  sendUserOperation = vi
    .fn()
    .mockResolvedValue(`0x${'a'.repeat(64)}` as Hex);
  waitForUserOperationReceipt = vi.fn().mockResolvedValue({
    success: true,
    receipt: {
      transactionHash: `0x${'b'.repeat(64)}` as Hex,
      blockNumber: 12345n,
    },
  });
  getUserOperationGasPrice = vi.fn().mockResolvedValue({
    slow: { maxFeePerGas: maxFeePerGas / 2n, maxPriorityFeePerGas: 1n },
    standard: { maxFeePerGas, maxPriorityFeePerGas: 1n },
    fast: { maxFeePerGas, maxPriorityFeePerGas: 1n },
  });

  mockHook(useSmartAccount, {
    data: {
      smartAccountClient: { sendUserOperation },
      pimlicoClient: { waitForUserOperationReceipt, getUserOperationGasPrice },
      paymasterMode,
    },
    isLoading: false,
    error: null,
  });
  mockHook(useAccount, { chainId });
}

describe('useBatchPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('店主送金 + 手数料を 1 つの UserOp の calls[2] にバッチ化', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 99_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 1_000_000n,
    });

    await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());

    const arg = sendUserOperation.mock.calls[0][0];
    expect(arg.calls).toHaveLength(2);
    expect(arg.calls[0].to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(arg.calls[1].to.toLowerCase()).toBe(TOKEN.toLowerCase());

    // 1 件目: 店主への transfer
    const d1 = decodeFunctionData({ abi: erc20Abi, data: arg.calls[0].data });
    expect(d1.functionName).toBe('transfer');
    expect((d1.args as readonly unknown[])[0]).toBeTypeOf('string');
    expect(
      ((d1.args as readonly [string, bigint])[0] as string).toLowerCase(),
    ).toBe(MERCHANT.toLowerCase());
    expect((d1.args as readonly [string, bigint])[1]).toBe(99_000_000n);

    // 2 件目: 運営への手数料 transfer
    const d2 = decodeFunctionData({ abi: erc20Abi, data: arg.calls[1].data });
    expect(d2.functionName).toBe('transfer');
    expect(
      ((d2.args as readonly [string, bigint])[0] as string).toLowerCase(),
    ).toBe(FEE_RECV.toLowerCase());
    expect((d2.args as readonly [string, bigint])[1]).toBe(1_000_000n);

    await waitFor(() =>
      expect(waitForUserOperationReceipt).toHaveBeenCalledOnce(),
    );
  });

  it('merchantAmount = 0 の場合は手数料のみの 1 call', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 0n,
      feeReceiver: FEE_RECV,
      feeAmount: 100_000n,
    });

    await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
    const arg = sendUserOperation.mock.calls[0][0];
    expect(arg.calls).toHaveLength(1);
    const d = decodeFunctionData({ abi: erc20Abi, data: arg.calls[0].data });
    expect((d.args as readonly [string, bigint])[1]).toBe(100_000n);
  });

  it('Phase 1: feeAmount = 0 でも batch は成立、calls から fee transfer が除外される', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 50_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 0n,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sendUserOperation).toHaveBeenCalledOnce();
    const arg = sendUserOperation.mock.calls[0][0];
    // merchant transfer 1 件のみ、fee transfer なし
    expect(arg.calls).toHaveLength(1);
    const d = decodeFunctionData({ abi: erc20Abi, data: arg.calls[0].data });
    expect((d.args as readonly [string, bigint])[0]).toBe(MERCHANT);
    expect((d.args as readonly [string, bigint])[1]).toBe(50_000_000n);
  });

  it('Phase 1: feeAmount < 0 は非負ガードで reject', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 50_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: -1n,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/feeAmount/);
    expect(sendUserOperation).not.toHaveBeenCalled();
  });

  it('Phase 1: 両方 0 → batch は no-op で成功 (calls 0 件は smart account 側で reject される想定だが本テストは guard 動作のみ確認)', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 0n,
      feeReceiver: FEE_RECV,
      feeAmount: 0n,
    });

    // merchantAmount=0n は guard を通過、空 calls で sendUserOperation が呼ばれる
    await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
    const arg = sendUserOperation.mock.calls[0][0];
    expect(arg.calls).toHaveLength(0);
  });

  it('Smart Account 未準備 → エラー', async () => {
    mockHook(useSmartAccount, {
      data: undefined,
      isLoading: true,
      error: null,
    });
    mockHook(useAccount, { chainId: baseSepolia.id });
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 1n,
      feeReceiver: FEE_RECV,
      feeAmount: 1n,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/Smart Account/);
  });

  it('enabled=false を useSmartAccount に伝播する', () => {
    mockHook(useSmartAccount, {
      data: undefined,
      isLoading: false,
      error: null,
    });
    mockHook(useAccount, { chainId: baseSepolia.id });

    renderHook(() => useBatchPayment(usdcDep, false), {
      wrapper: makeWrapper(),
    });

    expect(useSmartAccount).toHaveBeenCalledWith(usdcDep, false);
  });

  it('成功時に userOpHash と txHash を返却', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 99_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 1_000_000n,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.success).toBe(true);
    expect(result.current.data!.userOpHash).toMatch(/^0x[a-f]{64}$/i);
    expect(result.current.data!.txHash).toMatch(/^0x[a-f]{64}$/i);
    expect(result.current.data!.blockNumber).toBe(12345n);
  });

  it('extraRecipients (split) が指定されると calls に追加される', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    const B: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const C: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 50_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 1_000_000n,
      extraRecipients: [
        { to: B, amount: 30_000_000n },
        { to: C, amount: 19_000_000n },
      ],
    });

    await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
    const arg = sendUserOperation.mock.calls[0][0];
    // primary + 2 extras + fee = 4 calls
    expect(arg.calls).toHaveLength(4);
    // 2nd call: B
    const dB = decodeFunctionData({ abi: erc20Abi, data: arg.calls[1].data });
    expect((dB.args as readonly [string, bigint])[0].toLowerCase()).toBe(
      B.toLowerCase(),
    );
    expect((dB.args as readonly [string, bigint])[1]).toBe(30_000_000n);
    // 3rd call: C
    const dC = decodeFunctionData({ abi: erc20Abi, data: arg.calls[2].data });
    expect((dC.args as readonly [string, bigint])[0].toLowerCase()).toBe(
      C.toLowerCase(),
    );
    // 4th call: fee
    const dF = decodeFunctionData({ abi: erc20Abi, data: arg.calls[3].data });
    expect((dF.args as readonly [string, bigint])[0].toLowerCase()).toBe(
      FEE_RECV.toLowerCase(),
    );
  });

  it('extraRecipients に amount=0 が混ざる → エラー', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    const B: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 50_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 1_000_000n,
      extraRecipients: [{ to: B, amount: 0n }],
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/split/);
    expect(sendUserOperation).not.toHaveBeenCalled();
  });

  it('sendUserOperation が reject → mutation エラーに伝播', async () => {
    mountReady();
    sendUserOperation.mockRejectedValueOnce(new Error('AA21 didn\'t pay prefund'));
    const { result } = renderHook(() => useBatchPayment(usdcDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 99_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 1_000_000n,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('prefund');
  });

  describe('gas price ceiling (赤字回避ガード)', () => {
    it('sponsorship mode + 上限以下 → 通常通り送信される', async () => {
      // testnet (Base Sepolia) ceiling = 1000 gwei、観測 50 gwei は安全圏
      mountReady({ maxFeePerGas: 50n * GWEI, chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
      expect(getUserOperationGasPrice).toHaveBeenCalledOnce();
    });

    it('sponsorship mode + 上限超過 → GasCongestedError、sendUserOperation は呼ばれない', async () => {
      // testnet ceiling 1000 gwei を上回る 1500 gwei を返す
      mountReady({ maxFeePerGas: 1500n * GWEI, chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeInstanceOf(GasCongestedError);
      expect(sendUserOperation).not.toHaveBeenCalled();
    });

    it('erc20 mode + 上限以下 → 通常通り送信 (顧客の USDC 出費保護のため check は実行)', async () => {
      mountReady({
        maxFeePerGas: 50n * GWEI,
        chainId: baseSepolia.id,
        paymasterMode: 'erc20',
      });
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
      expect(getUserOperationGasPrice).toHaveBeenCalledOnce();
    });

    it('erc20 mode + 上限超過 → GasCongestedError (顧客が高額 USDC を払う事故を防ぐ)', async () => {
      mountReady({
        maxFeePerGas: 1500n * GWEI,
        chainId: baseSepolia.id,
        paymasterMode: 'erc20',
      });
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeInstanceOf(GasCongestedError);
      expect(sendUserOperation).not.toHaveBeenCalled();
    });

    it('chainId が undefined (ウォレット未接続相当) → ガード skip して送信進行', async () => {
      // chainId なし: ガード判定をスキップ。本来は呼出側 (UI) が gating する
      // が、defense-in-depth で hook 内部もクラッシュしない振る舞いを保証。
      mountReady({ maxFeePerGas: 1500n * GWEI });
      mockHook(useAccount, { chainId: undefined });
      const { result } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
      expect(getUserOperationGasPrice).not.toHaveBeenCalled();
    });

    it('Phase 1: feeAmount=0 でも gas price ceiling は通る (両方 OK で送信成立)', async () => {
      // Phase 1: feeAmount=0 はもはやエラーパスではない。gas ceiling は normal に
      // チェックされ、merchant tx 1 件で batch が成立する。
      mountReady({ maxFeePerGas: 50n * GWEI, chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 50_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 0n,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(getUserOperationGasPrice).toHaveBeenCalledOnce();
    });

    it('Polygon mainnet (chainId=137) sponsorship: 1000 gwei 以下 OK / 超過 reject', async () => {
      // 既定 ceiling は Polygon mainnet 1000 gwei (2026-05 base fee 上昇に追従)
      mountReady({ maxFeePerGas: 999n * GWEI, chainId: polygon.id });
      const { result: ok } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });
      ok.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());

      // reset for the over-ceiling case
      vi.clearAllMocks();
      mountReady({ maxFeePerGas: 1100n * GWEI, chainId: polygon.id });
      const { result: ng } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });
      ng.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(ng.current.isError).toBe(true));
      expect(ng.current.error).toBeInstanceOf(GasCongestedError);
    });

    it('Base mainnet (chainId=8453) sponsorship: 10 gwei 以下 OK / 超過 reject', async () => {
      // 既定 ceiling は Base mainnet 10 gwei
      mountReady({ maxFeePerGas: 9n * GWEI, chainId: base.id }); // 9 gwei
      const { result: ok } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });
      ok.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());

      vi.clearAllMocks();
      mountReady({ maxFeePerGas: 15n * GWEI, chainId: base.id }); // 15 gwei = 超過
      const { result: ng } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });
      ng.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(ng.current.isError).toBe(true));
      expect(ng.current.error).toBeInstanceOf(GasCongestedError);
    });
  });

  describe('並行性 / re-mutation の挙動 (race condition)', () => {
    it('1 回目 fail → 2 回目で recover (state がリセットされ成功する)', async () => {
      mountReady();
      // 1 回目は sendUserOperation が reject
      sendUserOperation.mockRejectedValueOnce(new Error('AA21 prefund'));
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(result.current.isError).toBe(true));

      // 2 回目は成功
      sendUserOperation.mockResolvedValueOnce(`0x${'a'.repeat(64)}` as Hex);
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.error).toBeNull();
    });

    it('gas ceiling 取得中に 2 回連続 mutate → 両方で getUserOperationGasPrice が呼ばれる (独立した実行)', async () => {
      // gasPrice fetch を deferred にして、2 つの mutate を interleave させる
      const gates: Array<() => void> = [];
      getUserOperationGasPrice = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            gates.push(() =>
              resolve({
                slow: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
                standard: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
                fast: { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 1n },
              }),
            );
          }),
      );
      sendUserOperation = vi
        .fn()
        .mockResolvedValue(`0x${'a'.repeat(64)}` as Hex);
      waitForUserOperationReceipt = vi.fn().mockResolvedValue({
        success: true,
        receipt: {
          transactionHash: `0x${'b'.repeat(64)}` as Hex,
          blockNumber: 1n,
        },
      });
      mockHook(useSmartAccount, {
        data: {
          smartAccountClient: { sendUserOperation },
          pimlicoClient: { waitForUserOperationReceipt, getUserOperationGasPrice },
          paymasterMode: 'sponsorship' as const,
        },
        isLoading: false,
        error: null,
      });
      mockHook(useAccount, { chainId: baseSepolia.id });

      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      // 連続 mutate (両方とも gas price fetch 中で deferred)
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 2n,
        feeReceiver: FEE_RECV,
        feeAmount: 2n,
      });

      await waitFor(() => expect(getUserOperationGasPrice).toHaveBeenCalledTimes(2));
      // 両 gate を解放 → 両 mutation 完走
      gates[0]?.();
      gates[1]?.();
      await waitFor(() =>
        expect(sendUserOperation).toHaveBeenCalledTimes(2),
      );
      // useMutation は最新の結果のみ保持。data があれば成功した mutation。
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it('SA 未準備状態で連続 mutate → 全て同じエラーで rejected', async () => {
      mockHook(useSmartAccount, {
        data: undefined,
        isLoading: true,
        error: null,
      });
      mockHook(useAccount, { chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      const err1 = result.current.error?.message;
      expect(err1).toMatch(/Smart Account/);

      // 2 回目も同じエラー (clients 不在は useSmartAccount mock で固定)
      result.current.reset?.();
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toMatch(/Smart Account/);
    });
  });

  describe('UserOp の receipt 処理', () => {
    it('success=false の receipt → 例外を投げず result.data.success=false で返す', async () => {
      // UserOp は bundler に含まれたが、execution が revert したケース
      mountReady();
      waitForUserOperationReceipt.mockResolvedValueOnce({
        success: false,
        receipt: {
          transactionHash: `0x${'f'.repeat(64)}` as Hex,
          blockNumber: 999n,
        },
      });

      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      // mutation 自体は成功 (resolve した)、ただし success フラグは false
      expect(result.current.data!.success).toBe(false);
      expect(result.current.data!.txHash).toBe(`0x${'f'.repeat(64)}`);
      expect(result.current.data!.blockNumber).toBe(999n);
    });

    it('waitForUserOperationReceipt が reject → mutation エラー (sendUserOperation 後の失敗)', async () => {
      mountReady();
      waitForUserOperationReceipt.mockRejectedValueOnce(
        new Error('UserOperationReceiptTimeoutError'),
      );

      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      // sendUserOperation は呼ばれた (実 broadcast 済)、wait で失敗
      expect(sendUserOperation).toHaveBeenCalledOnce();
      expect(result.current.error?.message).toContain('Timeout');
    });
  });

  describe('calls の構築 (データ整合性)', () => {
    it('複数 extraRecipients の順序保存 + bigint amount 整合性', async () => {
      mountReady();
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      const recipients: Address[] = [
        getAddress('0x1000000000000000000000000000000000000001'),
        getAddress('0x2000000000000000000000000000000000000002'),
        getAddress('0x3000000000000000000000000000000000000003'),
      ];
      const amounts = [11_111n, 22_222n, 33_333n];

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 100_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000n,
        extraRecipients: recipients.map((to, i) => ({ to, amount: amounts[i] })),
      });

      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
      const arg = sendUserOperation.mock.calls[0][0];
      // 1 (merchant) + 3 (extras) + 1 (fee) = 5 calls
      expect(arg.calls).toHaveLength(5);

      // 順序: merchant → extras (順) → fee
      const decoded = arg.calls.map((c: { data: Hex }) =>
        decodeFunctionData({ abi: erc20Abi, data: c.data }),
      );
      const recvs = decoded.map(
        (d: { args: readonly [string, bigint] }) => d.args[0].toLowerCase(),
      );
      const amts = decoded.map(
        (d: { args: readonly [string, bigint] }) => d.args[1],
      );

      expect(recvs[0]).toBe(MERCHANT.toLowerCase());
      expect(recvs[1]).toBe(recipients[0].toLowerCase());
      expect(recvs[2]).toBe(recipients[1].toLowerCase());
      expect(recvs[3]).toBe(recipients[2].toLowerCase());
      expect(recvs[4]).toBe(FEE_RECV.toLowerCase());

      expect(amts[0]).toBe(100_000n);
      expect(amts[1]).toBe(11_111n);
      expect(amts[2]).toBe(22_222n);
      expect(amts[3]).toBe(33_333n);
      expect(amts[4]).toBe(1_000n);

      // 全て同一の token contract に向く
      const tos = arg.calls.map((c: { to: Address }) => c.to.toLowerCase());
      expect(new Set(tos).size).toBe(1);
      expect(tos[0]).toBe(TOKEN.toLowerCase());
    });

    it('巨大な amount (uint256 上限近く) でも bigint で精度欠落なし', async () => {
      mountReady();
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      const huge = 2n ** 200n; // uint256 範囲内、Number では絶対表現不可
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: huge,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });

      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
      const arg = sendUserOperation.mock.calls[0][0];
      const merchantCall = decodeFunctionData({
        abi: erc20Abi,
        data: arg.calls[0].data,
      });
      expect((merchantCall.args as readonly [string, bigint])[1]).toBe(huge);
    });

    it('merchantAmount > 0 + extraRecipients 空 (split なし、通常パス)', async () => {
      mountReady();
      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 50_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 500n,
        extraRecipients: [],
      });

      await waitFor(() => expect(sendUserOperation).toHaveBeenCalledOnce());
      const arg = sendUserOperation.mock.calls[0][0];
      // 1 (merchant) + 0 (empty extras) + 1 (fee) = 2 calls
      expect(arg.calls).toHaveLength(2);
    });
  });

  describe('payment log 発火 (behavioral)', () => {
    const USEROP = `0x${'a'.repeat(64)}` as Hex;
    const TX = `0x${'b'.repeat(64)}` as Hex;
    const CUSTOMER = '0x9999999999999999999999999999999999999999' as Address;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
    });

    it('success: log body に userOpHash / txHash / blockNumber / customer / fee が乗る', async () => {
      mountReady({ chainId: polygon.id });
      mockHook(useAccount, { chainId: polygon.id, address: CUSTOMER });

      const { result } = renderHook(() => useBatchPayment(jpycDep), {
        wrapper: makeWrapper(),
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 99_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 1_000_000n,
      });

      await waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith('/api/log/payment', expect.anything()),
      );
      const init = fetchSpy.mock.calls[0][1];
      expect(init.method).toBe('POST');
      expect(init.keepalive).toBe(true);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        flow: 'batch',
        result: 'success',
        chainId: polygon.id,
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: '99000000',
        customer: CUSTOMER,
        feeReceiver: FEE_RECV,
        feeAmount: '1000000',
        userOpHash: `0x${'a'.repeat(64)}`,
        txHash: `0x${'b'.repeat(64)}`,
        blockNumber: '12345',
      });
      expect(body.errorMessage).toBeUndefined();
    });

    it('receipt.success=false (revert): result=reverted で log', async () => {
      mountReady();
      // 既定 receipt は success:true なので、上書きして reverted を演出
      waitForUserOperationReceipt.mockResolvedValueOnce({
        success: false,
        receipt: { transactionHash: TX, blockNumber: 99n },
      });
      mockHook(useAccount, { chainId: baseSepolia.id, address: CUSTOMER });

      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 50n,
        feeReceiver: FEE_RECV,
        feeAmount: 5n,
      });

      await waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith('/api/log/payment', expect.anything()),
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.result).toBe('reverted');
      expect(body.userOpHash).toBe(USEROP);
      expect(body.txHash).toBe(TX);
      expect(body.blockNumber).toBe('99');
    });

    it('mutationFn 失敗 (sendUserOperation 例外): result=error + errorMessage で log', async () => {
      mountReady();
      sendUserOperation.mockRejectedValueOnce(new Error('user rejected request'));
      mockHook(useAccount, { chainId: baseSepolia.id, address: CUSTOMER });

      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });

      await waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith('/api/log/payment', expect.anything()),
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.result).toBe('error');
      expect(body.errorMessage).toBe('user rejected request');
      // 失敗時は userOpHash / blockNumber は付かない (build 側 contract)
      expect(body.userOpHash).toBeUndefined();
      expect(body.blockNumber).toBeUndefined();
      // 必須 ctx field は残る
      expect(body.flow).toBe('batch');
      expect(body.merchantAmount).toBe('1');
      expect(body.feeAmount).toBe('1');
      expect(body.customer).toBe(CUSTOMER);
    });

    it('customer 欠落 (wallet 未接続) でも log 発火、customer は undefined', async () => {
      mountReady();
      sendUserOperation.mockRejectedValueOnce(new Error('Smart Account 未初期化'));
      mockHook(useAccount, { chainId: undefined, address: undefined });

      const { result } = renderHook(() => useBatchPayment(usdcDep), {
        wrapper: makeWrapper(),
      });
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 1n,
        feeReceiver: FEE_RECV,
        feeAmount: 1n,
      });

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.customer).toBeUndefined();
      // chainId は deployment.chainId にフォールバック
      expect(body.chainId).toBe(usdcDep.chainId);
    });
  });
});
