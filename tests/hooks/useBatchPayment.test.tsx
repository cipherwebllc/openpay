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
import { baseSepolia } from 'viem/chains';
import type { ReactNode } from 'react';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { GasCongestedError } from '@/lib/gasCeiling';

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

function mountReady(opts?: { maxFeePerGas?: bigint; chainId?: number }) {
  // testnet (Base Sepolia, 既定 ceiling 1000 gwei) を使い、観測値はその下を既定。
  const maxFeePerGas = opts?.maxFeePerGas ?? 50n * GWEI;
  const chainId = opts?.chainId ?? baseSepolia.id;

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

  vi.mocked(useSmartAccount).mockReturnValue({
    data: {
      smartAccountClient: { sendUserOperation },
      pimlicoClient: { waitForUserOperationReceipt, getUserOperationGasPrice },
    },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useSmartAccount>);

  vi.mocked(useAccount).mockReturnValue({
    chainId,
  } as unknown as ReturnType<typeof useAccount>);
}

describe('useBatchPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('店主送金 + 手数料を 1 つの UserOp の calls[2] にバッチ化', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(), {
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
    const { result } = renderHook(() => useBatchPayment(), {
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

  it('feeAmount = 0 → 必ずエラー (sponsorship 濫用防止のため fee 必須)', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 50_000_000n,
      feeReceiver: FEE_RECV,
      feeAmount: 0n,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/feeAmount|sponsorship/);
    expect(sendUserOperation).not.toHaveBeenCalled();
  });

  it('両方 0 → エラーで sendUserOperation は呼ばれない', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 0n,
      feeReceiver: FEE_RECV,
      feeAmount: 0n,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/feeAmount|sponsorship/);
    expect(sendUserOperation).not.toHaveBeenCalled();
  });

  it('Smart Account 未準備 → エラー', async () => {
    vi.mocked(useSmartAccount).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof useSmartAccount>);
    vi.mocked(useAccount).mockReturnValue({
      chainId: baseSepolia.id,
    } as unknown as ReturnType<typeof useAccount>);
    const { result } = renderHook(() => useBatchPayment(), {
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

  it('成功時に userOpHash と txHash を返却', async () => {
    mountReady();
    const { result } = renderHook(() => useBatchPayment(), {
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
    const { result } = renderHook(() => useBatchPayment(), {
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
    const { result } = renderHook(() => useBatchPayment(), {
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
    const { result } = renderHook(() => useBatchPayment(), {
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
    it('上限以下 → 通常通り送信される', async () => {
      // testnet (Base Sepolia) ceiling = 1000 gwei、観測 50 gwei は安全圏
      mountReady({ maxFeePerGas: 50n * GWEI, chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(), {
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

    it('上限超過 → GasCongestedError、sendUserOperation は呼ばれない', async () => {
      // testnet ceiling 1000 gwei を上回る 1500 gwei を返す
      mountReady({ maxFeePerGas: 1500n * GWEI, chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(), {
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
      vi.mocked(useAccount).mockReturnValue({
        chainId: undefined,
      } as unknown as ReturnType<typeof useAccount>);
      const { result } = renderHook(() => useBatchPayment(), {
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

    it('feeAmount=0 ガードは gas price チェックより先に発火', async () => {
      // sponsorship 防御 (feeAmount=0) のエラーパス: gas price 取得は不要なはず
      mountReady({ maxFeePerGas: 50n * GWEI, chainId: baseSepolia.id });
      const { result } = renderHook(() => useBatchPayment(), {
        wrapper: makeWrapper(),
      });

      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 50_000_000n,
        feeReceiver: FEE_RECV,
        feeAmount: 0n,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toMatch(/feeAmount|sponsorship/);
      expect(getUserOperationGasPrice).not.toHaveBeenCalled();
    });
  });
});
