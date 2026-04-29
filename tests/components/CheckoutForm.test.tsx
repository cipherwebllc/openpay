import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useConnect: vi.fn(() => ({
    connectors: [],
    connect: vi.fn(),
    isPending: false,
    error: null,
  })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn() }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutParams } from '@/lib/url';
import { mockHook } from '../_helpers/wagmiMock';

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';

function setAccount(opts: { connected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: opts.connected ? CUSTOMER : undefined,
    isConnected: opts.connected,
    chainId: opts.connected ? opts.chainId : undefined,
  });
}

function setBalance(value: bigint | undefined) {
  mockHook(useReadContract, {
    data: value,
    isLoading: false,
    error: null,
  });
}

function setSmartAccount(ready: boolean, error?: Error) {
  mockHook(useSmartAccount, {
    data: ready ? { smartAccountClient: {}, pimlicoClient: {} } : undefined,
    isLoading: !ready && !error,
    error: error ?? null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
}

let mutate: ReturnType<typeof vi.fn>;
function setBatchPayment(
  state: 'idle' | 'pending' | 'success' | 'error',
  errMsg?: string,
) {
  mutate = vi.fn();
  mockHook(useBatchPayment, {
    mutate,
    isPending: state === 'pending',
    isSuccess: state === 'success',
    isError: state === 'error',
    data:
      state === 'success'
        ? {
            userOpHash: `0x${'a'.repeat(64)}`,
            txHash: `0x${'b'.repeat(64)}`,
            blockNumber: 99n,
            success: true,
          }
        : undefined,
    error: state === 'error' ? new Error(errMsg ?? 'AA21 fail') : null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

function setSwitchChain() {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
  });
}

function setGasQuote(state: 'disabled' | 'pending' | 'ready' | 'error', amount?: bigint) {
  const mockState = {
    data: state === 'ready' ? { gasAmount: amount ?? 100_000n } : undefined,
    isLoading: state === 'pending',
    isError: state === 'error',
    error: state === 'error' ? new Error('quote failed') : null,
  };
  mockHook(useGasQuoteUsdc, mockState as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, mockState as Partial<ReturnType<typeof useGasQuoteJpyc>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setSwitchChain();
  setBalance(undefined);
  setSmartAccount(false);
  setBatchPayment('idle');
  setGasQuote('disabled');
  setAccount({ connected: false });
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
});

const USDC_PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'usdc',
  chain: 'base',
  gas: 'customer',
  items: [
    { name: 'Tシャツ', qty: 1, price: '25.00' },
    { name: 'マグ', qty: 2, price: '15.00' },
  ],
  orderId: 'ord-42',
  description: 'Summer sale',
};

const JPYC_PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
};

describe('CheckoutForm — レンダリング', () => {
  it('order_id / description / items / 合計が表示される', () => {
    setAccount({ connected: false });
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/注文 #ord-42/)).toBeInTheDocument();
    expect(screen.getByText('Summer sale')).toBeInTheDocument();
    expect(screen.getByText('Tシャツ')).toBeInTheDocument();
    expect(screen.getByText('マグ')).toBeInTheDocument();
    // line totals: T 25 USDC, マグ 30 USDC, subtotal 55 USDC が画面のどこかに存在する
    // (subtotal もボタン文言にも出るため複数 match の可能性あり、getAllByText で確認)
    expect(screen.getByText('25 USDC')).toBeInTheDocument();
    expect(screen.getByText('30 USDC')).toBeInTheDocument();
    expect(screen.getAllByText(/55 USDC/).length).toBeGreaterThan(0);
  });

  it('order_id 未指定時は generic タイトル', () => {
    const { container } = render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, orderId: undefined, description: undefined }}
      />,
    );
    expect(container.textContent).toContain('OpenPay Checkout');
  });

  it('JPYC params: chain Polygon と通貨表示', () => {
    render(<CheckoutForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/Polygon/)).toBeInTheDocument();
    // JPYC は header と price 行で複数 match。少なくとも 1 つあれば OK。
    expect(screen.getAllByText(/JPYC/).length).toBeGreaterThan(0);
  });
});

describe('CheckoutForm — 接続フロー', () => {
  it('未接続: 「ウォレットを接続」ボタン', () => {
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /ウォレットを接続/ }),
    ).toBeDisabled();
  });

  it('wrong chain: switch ボタン表示', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(false);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByRole('button', { name: /へ切り替え/ })).toBeInTheDocument();
  });

  it('SA 初期化中: ボタン disabled で初期化中文言', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(false);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /Smart Account 初期化中/ }),
    ).toBeDisabled();
  });

  it('gas quote pending: ボタン disabled で見積中', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('pending');
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('準備完了: 支払いボタン enabled で合計が表示される', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n); // 0.1 USDC
    render(<CheckoutForm params={USDC_PARAMS} />);
    // 55 + 0.1 = 55.1 USDC
    expect(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    ).toBeEnabled();
  });

  it('残高不足: ボタン disabled + 警告', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(10_000_000n); // 10 USDC < 55 USDC
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    ).toBeDisabled();
  });
});

describe('CheckoutForm — 送信', () => {
  it('支払いボタン → useBatchPayment.mutate に正しい breakdown', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);

    await user.click(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    );

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    // total 55 USDC, fee 1% = 0.55 USDC, sponsorship なので feeAmount += gas (0.1)
    // merchantAmount = 55 - 0.55 = 54.45 USDC = 54_450_000
    expect(call.merchantAmount).toBe(54_450_000n);
    // testnet 環境では sponsorship に倒れるので feeAmount = 0.55 + 0.1 = 0.65 USDC
    expect(call.feeAmount).toBe(550_000n + 100_000n);
  });

  it('ERC20 mode (USDC mainnet 相当): feeAmount に gas を含めない', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation((dep) =>
      dep.symbol === 'usdc' ? 'erc20' : 'sponsorship',
    );
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);

    await user.click(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    );

    const call = mutate.mock.calls[0][0];
    expect(call.merchantAmount).toBe(54_450_000n);
    // erc20 paymaster: feeAmount は fee のみ (gas は paymaster が直接顧客から徴収)
    expect(call.feeAmount).toBe(550_000n);
  });

  it('gas=merchant: customer は subtotal だけ払い、gas は merchant から控除', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm params={{ ...USDC_PARAMS, gas: 'merchant' }} />,
    );
    // customer = subtotal = 55 USDC (gas は乗らない)
    expect(
      screen.getByRole('button', { name: /^55 USDC を支払う$/ }),
    ).toBeEnabled();
  });

  it('合計 < fee の merchant underflow → 送信 block + エラー文言', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(1_000_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    // フロア手数料 0.05 USDC > 合計 0.04 USDC で merchant=0 になる
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          items: [{ name: 'Cheap', qty: 1, price: '0.04' }],
        }}
      />,
    );
    expect(screen.getByText(/手数料を引くと店主受取が 0/)).toBeInTheDocument();
  });
});

describe('CheckoutForm — 成功時の挙動', () => {
  it('成功 panel に txHash / userOpHash / orderId 表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    expect(screen.getByText(`0x${'a'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText(`0x${'b'.repeat(64)}`)).toBeInTheDocument();
    // orderId
    expect(screen.getByText('ord-42')).toBeInTheDocument();
  });

  it('success_url 指定時: 「今すぐ確認ページへ」ボタンが表示される', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, successUrl: 'https://shop.example.com/thanks' }}
      />,
    );
    expect(
      screen.getByRole('button', { name: /今すぐ確認ページへ/ }),
    ).toBeInTheDocument();
  });

  it('success_url 未指定時: ホームに戻るボタン', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={{ ...USDC_PARAMS, successUrl: undefined }} />);
    expect(
      screen.getByRole('button', { name: /OpenPay ホームへ戻る/ }),
    ).toBeInTheDocument();
  });

  it('success_url 指定 + 「今すぐ」クリック → window.location.assign に query 付き URL', async () => {
    const user = userEvent.setup();
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, successUrl: 'https://shop.example.com/thanks' }}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /今すぐ確認ページへ/ }),
    );
    expect(assignSpy).toHaveBeenCalledOnce();
    const url = new URL(assignSpy.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      'https://shop.example.com/thanks',
    );
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'b'.repeat(64)}`);
    expect(url.searchParams.get('user_op_hash')).toBe(`0x${'a'.repeat(64)}`);
    expect(url.searchParams.get('order_id')).toBe('ord-42');
    expect(url.searchParams.get('chain')).toBe('base');
    expect(url.searchParams.get('token')).toBe('usdc');
  });

  it('webhook 指定 → POST が発火 (Tip と互換シェイプ + items)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://shop.example.com/hook');
    expect(opts.method).toBe('POST');
    const payload = JSON.parse(opts.body);
    expect(payload.type).toBe('openpay.checkout.success');
    expect(payload.merchant).toBe(MERCHANT);
    expect(payload.token).toBe('usdc');
    expect(payload.chain).toBe('base');
    expect(payload.items).toEqual(USDC_PARAMS.items);
    expect(payload.orderId).toBe('ord-42');
    expect(payload.txHash).toBe(`0x${'b'.repeat(64)}`);
    vi.unstubAllGlobals();
  });

  it('[regression] 異なる userOpHash (新規送金) では webhook が再発火する (ref が永久 lock しない)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);

    // 1 回目の決済成功 (userOpHash = aaaa...)
    const firstHash = `0x${'a'.repeat(64)}`;
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: firstHash,
        txHash: `0x${'b'.repeat(64)}`,
        blockNumber: 99n,
        success: true,
      },
      error: null,
    } as Partial<ReturnType<typeof useBatchPayment>>);

    const { rerender } = render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const firstPayload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(firstPayload.userOpHash).toBe(firstHash);

    // 2 回目の決済成功 (userOpHash = cccc... に変化、同じ component 内で再 mutate)
    const secondHash = `0x${'c'.repeat(64)}`;
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: secondHash,
        txHash: `0x${'d'.repeat(64)}`,
        blockNumber: 100n,
        success: true,
      },
      error: null,
    } as Partial<ReturnType<typeof useBatchPayment>>);
    rerender(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );

    // 新しい userOpHash で webhook が再発火する (ref が永久 lock していない)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const secondPayload = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(secondPayload.userOpHash).toBe(secondHash);
    vi.unstubAllGlobals();
  });

  it('[regression] 同一 userOpHash で再 render が起きても webhook は 1 回しか POST されない (gasQuote refetch 耐性)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    // 初回 gasAmount = 100_000n
    setGasQuote('ready', 100_000n);
    const { rerender } = render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // gasQuote の refetchInterval を模擬: gasAmount を 200_000n に変えて再 render。
    // breakdown が変わるが webhook は再発火してはならない (同一 userOpHash)。
    setGasQuote('ready', 200_000n);
    rerender(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );
    setGasQuote('ready', 300_000n);
    rerender(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );

    // breakdown が 2 回変わっても webhook fetch は最初の 1 回のみ
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('[regression] 同一 userOpHash で再 render が起きても redirect カウントダウンは再起動しない', async () => {
    vi.useFakeTimers();
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    const { rerender } = render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    expect(screen.getByText(/3 秒後に確認ページへ移動します/)).toBeInTheDocument();
    // 1 秒進める → 2 秒 (act + 1 tick)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // gasQuote refetch を模擬し再 render — 同一 userOpHash なのでカウントダウンは継続のはず
    setGasQuote('ready', 200_000n);
    rerender(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );

    // 残り 2 秒進めて assign 発火を観測 (もしカウントダウンが 3 にリセットされていたら +1 秒不足で発火しない)
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(assignSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('webhook 失敗 (CORS 等) → UI には影響しない (logger.warn のみ)', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error('CORS blocked'));
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // 成功 UI は影響を受けない
    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('cancel_url 指定 → 「中止して戻る」リンクを描画', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          cancelUrl: 'https://shop.example.com/cart',
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /注文を中止して戻る/ });
    expect(link).toHaveAttribute('href', 'https://shop.example.com/cart');
  });

  it('cancel_url なし → リンクは描画しない', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={{ ...USDC_PARAMS, cancelUrl: undefined }} />);
    expect(screen.queryByText(/注文を中止して戻る/)).toBeNull();
  });

  it('customer_email 指定 → ヒント表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, customerEmail: 'alice@example.com' }}
      />,
    );
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
  });
});

describe('CheckoutForm — チェーン切替 状態 + isSwitching', () => {
  it('isSwitching=true の間は「チェーン切替中…」表示でボタン disabled', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(false);
    mockHook(useSwitchChain, {
      switchChain: vi.fn(),
      isPending: true,
    });
    render(<CheckoutForm params={USDC_PARAMS} />);
    const btn = screen.getByRole('button', { name: /チェーン切替中…/ });
    expect(btn).toBeDisabled();
  });

  it('switch ボタン click で switchChain({ chainId: requiredChain.id }) が呼ばれる', async () => {
    const user = userEvent.setup();
    const switchChain = vi.fn();
    mockHook(useSwitchChain, { switchChain, isPending: false });
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(false);
    render(<CheckoutForm params={USDC_PARAMS} />);
    await user.click(screen.getByRole('button', { name: /へ切り替え/ }));
    expect(switchChain).toHaveBeenCalledWith({ chainId: baseSepolia.id });
  });
});

describe('CheckoutForm — 自動 redirect カウントダウン (fake timers)', () => {
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  it('成功 → 3 秒タイマーで countdown → 0 で window.location.assign 発火', async () => {
    vi.useFakeTimers();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    // 成功 panel が出ている (success_url 指定あり → カウントダウン start)
    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    expect(screen.getByText(/3 秒後に確認ページへ移動します/)).toBeInTheDocument();

    // タイマーを 1 秒ずつ刻んで進める。各 tick で setRedirectIn が状態更新 →
    // 再 render → 次の setTimeout がスケジュールされる連鎖を実行する。
    // 一括で 4 秒進めると React の state 更新と timer の interleaving が
    // バンドラ依存になるため、明示的に 1 秒刻みで act + 進める。
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    expect(assignSpy).toHaveBeenCalledOnce();
    const url = new URL(assignSpy.mock.calls[0][0]);
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'b'.repeat(64)}`);
    vi.useRealTimers();
  });

  it('success_url 未指定時はカウントダウン state が走らない (タイマーが空回りしない)', async () => {
    vi.useFakeTimers();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm params={{ ...USDC_PARAMS, successUrl: undefined }} />,
    );
    // カウントダウンメッセージは出ない
    expect(screen.queryByText(/秒後に確認ページへ移動します/)).toBeNull();
    // タイマー進めても assign は呼ばれない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(assignSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('成功前 (gasless.data なし) はカウントダウン未起動', async () => {
    vi.useFakeTimers();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('idle'); // 未送信
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    expect(screen.queryByText(/秒後に確認ページへ移動します/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(assignSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('CheckoutForm — エラー表示', () => {
  it('GasCongestedError → i18n された案内文', async () => {
    const { GasCongestedError } = await import('@/lib/gasCeiling');
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: true,
      data: undefined,
      error: new GasCongestedError(baseSepolia.id, 1n, 5n),
    } as Partial<ReturnType<typeof useBatchPayment>>);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/ネットワークが混雑/)).toBeInTheDocument();
    expect(screen.queryByText(/gas_congested/)).toBeNull();
  });

  it('gasQuote.error → friendly メッセージ + ボタン disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('error');
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByText(/ガス代見積の取得に失敗しました/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('useSmartAccount.error → メッセージそのまま (技術詳細だが UI 上にも出す)', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(false, new Error('SA init failed'));
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText('SA init failed')).toBeInTheDocument();
  });
});
