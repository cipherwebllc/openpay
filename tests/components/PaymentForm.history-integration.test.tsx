// PaymentForm → usePaymentHistory → appendHistory → LocalStorage の end-to-end 統合。
//
// 方針: SUT (PaymentForm / usePaymentHistory / lib/history / lib/storage / LocalStorage)
// は実コードを実行する。境界 mock は wagmi / payment hook / smartAccount / gasQuote のみ。
// → "決済が成功したとき、本当に LocalStorage に正しい entry が入るか" を実 LocalStorage で確認。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';
import type { ReactNode } from 'react';
import messages from '../../messages/ja.json';

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));
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
vi.mock('@/hooks/useStandardPayment', () => ({ useStandardPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(() => 'sponsorship') };
});
// 内部 logger は副作用が test に出ないように silent 化 (gasless.error などで fire する)
vi.mock('@/lib/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logger')>(
    '@/lib/logger',
  );
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { PaymentForm } from '@/components/PaymentForm';
import {
  HISTORY_STORAGE_KEY,
  loadHistory,
  type HistoryEntry,
} from '@/lib/history';
import { mockHook } from '../_helpers/wagmiMock';

// digit-only addresses to side-step EIP-55 checksum validation (任意 mixed case を
// 与えると isAddress が checksum 不一致で false を返し parsePayParams が弾く)。
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const GASLESS_TX = `0x${'a'.repeat(64)}` as const;
const GASLESS_UO = `0x${'b'.repeat(64)}` as const;
const STD_MERCHANT_TX = `0x${'c'.repeat(64)}` as const;
const STD_FEE_TX = `0x${'d'.repeat(64)}` as const;

function setURL(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReadonlyURLSearchParams,
  );
}

function setAccount(connected: boolean, chainId?: number) {
  mockHook(useAccount, {
    address: connected ? CUSTOMER : undefined,
    isConnected: connected,
    chainId: connected ? chainId : undefined,
    chain: connected
      ? chainId === baseSepolia.id
        ? baseSepolia
        : polygonAmoy
      : undefined,
  });
}

function withIntl(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="ja" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  // 既定: standard hook は idle、gasQuote 不要、SmartAccount ready、balance あり、connected
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useReadContract, {
    data: 10n ** 24n,
    isLoading: false,
    error: null,
  });
  mockHook(useSmartAccount, {
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  });
  mockHook(useBatchPayment, {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  });
  mockHook(useStandardPayment, {
    mutate: vi.fn(),
    retryFee: vi.fn(),
    phase: 'idle',
    isPending: false,
    isSuccess: false,
    isError: false,
    isFeeError: false,
    isMerchantError: false,
    data: undefined,
    error: null,
    merchantTxHash: undefined,
    feeTxHash: undefined,
  });
  mockHook(useGasQuoteUsdc, { data: undefined, isLoading: false, error: null });
  mockHook(useGasQuoteJpyc, { data: undefined, isLoading: false, error: null });
  setAccount(true, polygonAmoy.id);
});

describe('PaymentForm → usePaymentHistory → LocalStorage 統合', () => {
  it('gasless 成功: 実 LocalStorage に flow=batch / status=success の entry が入る', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: GASLESS_UO,
        txHash: GASLESS_TX,
        blockNumber: 42n,
        success: true,
      },
      error: null,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });
    const [entry] = loadHistory();
    expect(entry.flow).toBe('batch');
    expect(entry.status).toBe('success');
    expect(entry.payMode).toBe('gasless');
    expect(entry.asset).toBe('jpyc');
    expect(entry.chainId).toBe(polygonAmoy.id);
    expect(entry.chainSlug).toBe('polygon');
    expect(entry.merchant).toBe(MERCHANT);
    expect(entry.customer).toBe(CUSTOMER);
    expect(entry.txHash).toBe(GASLESS_TX);
    expect(entry.userOpHash).toBe(GASLESS_UO);
    expect(entry.blockNumber).toBe('42');
    expect(entry.id).toBe(`batch-${GASLESS_TX}`);
    // bigint string で記録 (raw wei)。
    // amount=1000 JPYC → fee 1.0% = 10 JPYC、merchantReceives = 990 JPYC
    expect(entry.merchantAmount).toBe('990000000000000000000');
    expect(entry.feeAmount).toBe('10000000000000000000');
  });

  it('gasless reverted: status=reverted で記録 (success=false)', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: GASLESS_UO,
        txHash: GASLESS_TX,
        blockNumber: 42n,
        success: false,
      },
      error: null,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });
    expect(loadHistory()[0].status).toBe('reverted');
  });

  it('gasless エラー: status=error / txHash=null / errorMessage truncate', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    const longMsg = 'paymaster rejected — ' + 'X'.repeat(2000);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: true,
      data: undefined,
      error: new Error(longMsg),
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });
    const entry = loadHistory()[0];
    expect(entry.status).toBe('error');
    expect(entry.txHash).toBeNull();
    expect(entry.userOpHash).toBeNull();
    expect(entry.errorMessage?.length).toBe(500);
    expect(entry.errorMessage?.startsWith('paymaster rejected —')).toBe(true);
  });

  it('standard 成功 (fee あり): 実 LocalStorage に merchant + fee の 2 entry が入る', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000&mode=standard`);
    mockHook(useStandardPayment, {
      mutate: vi.fn(),
      retryFee: vi.fn(),
      phase: 'success',
      isPending: false,
      isSuccess: true,
      isError: false,
      isFeeError: false,
      isMerchantError: false,
      data: {
        merchantTxHash: STD_MERCHANT_TX,
        feeTxHash: STD_FEE_TX,
        blockNumber: 77n,
      },
      error: null,
      merchantTxHash: STD_MERCHANT_TX,
      feeTxHash: STD_FEE_TX,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(2);
    });
    const loaded = loadHistory();
    // 新しい順 (appendHistory が先頭に挿入) で fee → merchant
    const flows = loaded.map((e) => e.flow).sort();
    expect(flows).toEqual(['standard-fee', 'standard-merchant']);
    const merchantEntry = loaded.find((e) => e.flow === 'standard-merchant')!;
    const feeEntry = loaded.find((e) => e.flow === 'standard-fee')!;
    expect(merchantEntry.txHash).toBe(STD_MERCHANT_TX);
    expect(merchantEntry.payMode).toBe('standard');
    expect(merchantEntry.gasMode).toBeNull();
    expect(feeEntry.txHash).toBe(STD_FEE_TX);
    expect(feeEntry.merchant).toBe(merchantEntry.feeReceiver);
  });

  it('standard 成功 (fee=0、極小額): merchant 1 entry のみ', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000&mode=standard`);
    mockHook(useStandardPayment, {
      mutate: vi.fn(),
      retryFee: vi.fn(),
      phase: 'success',
      isPending: false,
      isSuccess: true,
      isError: false,
      isFeeError: false,
      isMerchantError: false,
      data: {
        merchantTxHash: STD_MERCHANT_TX,
        feeTxHash: undefined,
        blockNumber: 77n,
      },
      error: null,
      merchantTxHash: STD_MERCHANT_TX,
      feeTxHash: undefined,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });
    expect(loadHistory()[0].flow).toBe('standard-merchant');
  });

  it('standard merchant-error: error entry に merchantTxHash 持たせる', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000&mode=standard`);
    mockHook(useStandardPayment, {
      mutate: vi.fn(),
      retryFee: vi.fn(),
      phase: 'merchant-error',
      isPending: false,
      isSuccess: false,
      isError: true,
      isFeeError: false,
      isMerchantError: true,
      data: undefined,
      error: new Error('user rejected request'),
      merchantTxHash: STD_MERCHANT_TX,
      feeTxHash: undefined,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });
    const entry = loadHistory()[0];
    expect(entry.flow).toBe('standard-merchant');
    expect(entry.status).toBe('error');
    expect(entry.txHash).toBe(STD_MERCHANT_TX);
    expect(entry.errorMessage).toBe('user rejected request');
  });

  // R: 修正前は fee-error 時に merchant success が落ちて会計の控えから漏れていた。
  //    現在は useStandardPayment が merchantBlockNumber を独立 expose し、
  //    usePaymentHistory が phase==='fee-error' 検知時に merchant 行も補完 append する。
  it('standard fee-error: merchant 着金 + fee 失敗 の 2 entry が記録される', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000&mode=standard`);
    mockHook(useStandardPayment, {
      mutate: vi.fn(),
      retryFee: vi.fn(),
      phase: 'fee-error',
      isPending: false,
      isSuccess: false,
      isError: true,
      isFeeError: true,
      isMerchantError: false,
      data: undefined,
      error: new Error('fee tx reverted'),
      merchantTxHash: STD_MERCHANT_TX,
      feeTxHash: STD_FEE_TX,
      merchantBlockNumber: 77n,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(2);
    });
    const loaded = loadHistory();
    const merchant = loaded.find((e) => e.flow === 'standard-merchant')!;
    expect(merchant.status).toBe('success');
    expect(merchant.txHash).toBe(STD_MERCHANT_TX);
    expect(merchant.blockNumber).toBe('77');
    const fee = loaded.find((e) => e.flow === 'standard-fee')!;
    expect(fee.status).toBe('error');
    expect(fee.txHash).toBe(STD_FEE_TX);
    expect(fee.errorMessage).toBe('fee tx reverted');
  });

  it('standard fee-error: merchantBlockNumber 未確定 (例: sign 直後の例外) → fee 失敗行のみ', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000&mode=standard`);
    mockHook(useStandardPayment, {
      mutate: vi.fn(),
      retryFee: vi.fn(),
      phase: 'fee-error',
      isPending: false,
      isSuccess: false,
      isError: true,
      isFeeError: true,
      isMerchantError: false,
      data: undefined,
      error: new Error('fee write rejected'),
      merchantTxHash: undefined,
      feeTxHash: undefined,
      merchantBlockNumber: undefined,
    });

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });
    expect(loadHistory()[0].flow).toBe('standard-fee');
  });

  it('LocalStorage 生 raw を覗いて schema 互換性を確認 (loadHistory ラウンドトリップ)', async () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: GASLESS_UO,
        txHash: GASLESS_TX,
        blockNumber: 100n,
        success: true,
      },
      error: null,
    });
    setAccount(true, baseSepolia.id);

    render(withIntl(<PaymentForm />));

    await waitFor(() => {
      expect(loadHistory()).toHaveLength(1);
    });

    // 生 raw を parse してフィールド数 / 型を直接検査 (schema 検証が緩いと意味があるテスト)
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const obj = parsed[0] as Record<string, unknown>;
    // 必須 field がすべて存在し、bigint 系は string、nullable は null か string
    expect(typeof obj.id).toBe('string');
    expect(typeof obj.ts).toBe('number');
    expect(typeof obj.merchantAmount).toBe('string');
    expect(typeof obj.feeAmount).toBe('string');
    expect(typeof obj.blockNumber).toBe('string');
    expect(obj.asset).toBe('usdc');
    expect(obj.chainSlug).toBe('base');
    expect(obj.note).toBe('');
  });

  it('連続レンダリングで tx hash 同一 → entry が増えない (id dedupe 実証)', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: GASLESS_UO,
        txHash: GASLESS_TX,
        blockNumber: 42n,
        success: true,
      },
      error: null,
    });

    const { rerender } = render(withIntl(<PaymentForm />));
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    rerender(withIntl(<PaymentForm />));
    rerender(withIntl(<PaymentForm />));
    // 3 render しても LocalStorage は 1 件のまま
    expect(loadHistory()).toHaveLength(1);
  });
});

describe('PaymentForm: bare /pay 訪問は LocalStorage を 1 行も触らない', () => {
  it('query 完全空でレンダリング → loadHistory は空のまま', () => {
    setURL('');
    render(withIntl(<PaymentForm />));
    expect(loadHistory()).toHaveLength(0);
    expect(window.localStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull();
  });

  it('URL 半壊 (to なし) でレンダリング → loadHistory は空のまま', () => {
    setURL('token=jpyc');
    render(withIntl(<PaymentForm />));
    expect(loadHistory()).toHaveLength(0);
  });
});

describe('PaymentForm: 複数決済の累積 (実 LocalStorage シーケンス)', () => {
  function setGaslessSuccess(txHash: `0x${string}`, blockNumber: bigint) {
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: (txHash.slice(0, 2) +
          txHash.slice(2).replace(/./g, 'f')) as `0x${string}`,
        txHash,
        blockNumber,
        success: true,
      },
      error: null,
    });
  }

  it('3 件連続で異なる tx hash の決済 → 3 件累積し、新しい順に格納', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);

    const tx1 = `0x${'1'.repeat(64)}` as const;
    setGaslessSuccess(tx1, 1n);
    const { unmount } = render(withIntl(<PaymentForm />));
    await waitFor(() => expect(loadHistory()).toHaveLength(1));
    unmount();

    const tx2 = `0x${'2'.repeat(64)}` as const;
    setGaslessSuccess(tx2, 2n);
    const r2 = render(withIntl(<PaymentForm />));
    await waitFor(() => expect(loadHistory()).toHaveLength(2));
    r2.unmount();

    const tx3 = `0x${'3'.repeat(64)}` as const;
    setGaslessSuccess(tx3, 3n);
    render(withIntl(<PaymentForm />));
    await waitFor(() => expect(loadHistory()).toHaveLength(3));

    const loaded = loadHistory();
    // appendHistory は newest-at-front
    expect(loaded.map((e: HistoryEntry) => e.txHash)).toEqual([tx3, tx2, tx1]);
  });
});
