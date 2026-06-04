import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { HISTORY_STORAGE_KEY, loadHistory } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';

const CTX = {
  chainId: 80002,
  chainSlug: 'polygon' as const,
  asset: 'jpyc' as const,
  tokenAddress: '0xToken' as `0x${string}`,
  payMode: 'gasless' as const,
  gasMode: 'customer' as const,
  merchant: '0xMerchant' as `0x${string}`,
  merchantAmount: 1000n,
  customer: '0xCustomer' as `0x${string}`,
  feeReceiver: '0xFee' as `0x${string}`,
  feeAmount: 10n,
  saleAmount: 1000n,
  networkFeeEquivalent: 10n,
  storeName: '',
  note: '',
};

const NO_STANDARD = {
  data: undefined,
  phase: 'idle',
  merchantTxHash: undefined,
  feeTxHash: undefined,
  error: null,
};

const NO_GASLESS = { data: undefined, error: null };

describe('usePaymentHistory', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('gasless success → status=success の batch entry を append', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTx',
            userOpHash: '0xUO',
            blockNumber: 1n,
            success: true,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].flow).toBe('batch');
    expect(loaded[0].status).toBe('success');
    expect(loaded[0].id).toBe('batch-0xTx');
  });

  it('gasless success: saleAmount / networkFeeEquivalent / feeBreakdownVersion を分離記録', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTxS',
            userOpHash: '0xUOS',
            blockNumber: 1n,
            success: true,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const e = loadHistory()[0];
    expect(e.saleAmount).toBe('1000'); // CTX.saleAmount (gross)
    expect(e.networkFeeEquivalent).toBe('10'); // CTX.networkFeeEquivalent (gas 相当)
    expect(e.feeAmount).toBe('10'); // CTX.feeAmount (サービス料・分離後はこれのみ)
    expect(e.feeBreakdownVersion).toBe(1); // native v3 = 分離済
  });

  it('circle gasless: networkFeeEquivalent は null (circlePaymasterNetUsdc 側に検証付きで保持)', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTxC',
            userOpHash: '0xUOC',
            blockNumber: 1n,
            success: true,
            provider: 'circle',
            circlePaymasterAddress: '0xPM',
            circlePaymasterNetUsdc: '9384',
            circleVerification: 'client-reported',
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const e = loadHistory()[0];
    // circle は networkFeeEquivalent を二重計上しない (circlePaymasterNetUsdc を使う)。
    expect(e.networkFeeEquivalent).toBeNull();
    expect(e.circlePaymasterNetUsdc).toBe('9384');
    expect(e.provider).toBe('circle');
  });

  it('gasless reverted (success=false) → status=reverted で記録', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTxR',
            userOpHash: '0xUOR',
            blockNumber: 2n,
            success: false,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded[0].status).toBe('reverted');
  });

  it('gasless error → status=error の entry (txHash=null)', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        { data: undefined, error: new Error('paymaster rejected') },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].txHash).toBeNull();
    expect(loaded[0].errorMessage).toBe('paymaster rejected');
  });

  it('standard success (fee tx あり) → merchant + fee の 2 件が入る', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMTx',
          feeTxHash: '0xFTx',
          blockNumber: 5n,
        },
        phase: 'success',
        merchantTxHash: '0xMTx',
        feeTxHash: '0xFTx',
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => e.flow).sort()).toEqual([
      'standard-fee',
      'standard-merchant',
    ]);
  });

  it('standard success (fee tx なし、極小 fee=0) → merchant のみ 1 件', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMTx2',
          feeTxHash: undefined,
          blockNumber: 6n,
        },
        phase: 'success',
        merchantTxHash: '0xMTx2',
        feeTxHash: undefined,
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].flow).toBe('standard-merchant');
  });

  it('standard merchant-error → status=error の standard-merchant entry', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'merchant-error',
        merchantTxHash: '0xMTxRevert',
        feeTxHash: undefined,
        error: new Error('insufficient gas'),
      }),
    );
    const loaded = loadHistory();
    expect(loaded[0].flow).toBe('standard-merchant');
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].txHash).toBe('0xMTxRevert');
    expect(loaded[0].errorMessage).toBe('insufficient gas');
  });

  it('standard fee-error → status=error の standard-fee entry (merchant 着金済)', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'fee-error',
        merchantTxHash: '0xMTxOk',
        feeTxHash: '0xFTxFail',
        error: new Error('fee tx reverted'),
      }),
    );
    const loaded = loadHistory();
    expect(loaded[0].flow).toBe('standard-fee');
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].txHash).toBe('0xFTxFail');
  });

  it('error.message は 500 文字に truncate される (DoS 対策)', () => {
    const longMsg = 'X'.repeat(2000);
    renderHook(() =>
      usePaymentHistory(
        CTX,
        { data: undefined, error: new Error(longMsg) },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded[0].errorMessage?.length).toBe(500);
  });

  it('hook が複数回 render しても同じ tx hash は重複しない (id dedupe)', () => {
    type GaslessData = {
      txHash: `0x${string}`;
      userOpHash: `0x${string}`;
      blockNumber: bigint;
      success: boolean;
    };
    const data: GaslessData = {
      txHash: '0xSame',
      userOpHash: '0xSameUO',
      blockNumber: 1n,
      success: true,
    };
    const { rerender } = renderHook(
      (gaslessData: GaslessData) =>
        usePaymentHistory(
          CTX,
          { data: gaslessData, error: null },
          NO_STANDARD,
        ),
      { initialProps: data },
    );
    rerender({ ...data });
    expect(loadHistory()).toHaveLength(1);
  });

  it('standard merchant-error: error が null のとき errorMessage は null (phase 名 fallback ではない)', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'merchant-error',
        merchantTxHash: '0xMTx',
        feeTxHash: undefined,
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded[0].errorMessage).toBeNull();
    // status と flow で「standard の merchant 段で失敗」は識別可能
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].flow).toBe('standard-merchant');
  });

  it('standard fee-error: error が null のとき errorMessage は null', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'fee-error',
        merchantTxHash: '0xMTx',
        feeTxHash: '0xFTx',
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded[0].errorMessage).toBeNull();
    expect(loaded[0].flow).toBe('standard-fee');
  });

  // R: codex review #1 (P2) — fee-error 時に merchant 着金が履歴に残らない bug の regression。
  //    useStandardPayment が phase==='success' でのみ data を expose する設計のため、
  //    fee-error 時には独立した merchantTxHash + merchantBlockNumber 経由で
  //    merchant success entry を補完 append する。
  it('standard fee-error: merchantBlockNumber 付き → merchant 成功行 + fee 失敗行の 2 件', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'fee-error',
        merchantTxHash: '0xMTxConfirmed',
        merchantBlockNumber: 99n,
        feeTxHash: '0xFTxFail',
        error: new Error('fee tx reverted'),
      }),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    const merchant = loaded.find((e) => e.flow === 'standard-merchant')!;
    expect(merchant.status).toBe('success');
    expect(merchant.txHash).toBe('0xMTxConfirmed');
    expect(merchant.blockNumber).toBe('99');
    expect(merchant.errorMessage).toBeNull();
    const fee = loaded.find((e) => e.flow === 'standard-fee')!;
    expect(fee.status).toBe('error');
    expect(fee.txHash).toBe('0xFTxFail');
    expect(fee.errorMessage).toBe('fee tx reverted');
  });

  it('standard fee-error: merchantBlockNumber 不在 (sign 直後拒否等) → fee 失敗行のみ', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'fee-error',
        merchantTxHash: '0xMTxNoReceipt',
        merchantBlockNumber: undefined,
        feeTxHash: undefined,
        error: new Error('fee write rejected'),
      }),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].flow).toBe('standard-fee');
  });

  // R: codex review #2 (P2) — submit 時の amount が gas quote refetch / 変数 amount 編集で
  //    drift する race の regression。snapshot を優先するパスを検証。
  it('gasless: variables (submitted amounts) が ctx より優先される (amount drift 防御)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, merchantAmount: 9999n, feeAmount: 9999n }, // 後から drift した live ctx
        {
          data: {
            txHash: '0xTxDrift',
            userOpHash: '0xUODrift',
            blockNumber: 1n,
            success: true,
          },
          error: null,
          variables: { merchantAmount: 1000n, feeAmount: 10n }, // submit 時の固定値
        },
        NO_STANDARD,
      ),
    );
    const [entry] = loadHistory();
    expect(entry.merchantAmount).toBe('1000');
    expect(entry.feeAmount).toBe('10');
  });

  it('gasless error: variables が ctx より優先される (error 行でも snapshot)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, merchantAmount: 9999n, feeAmount: 9999n },
        {
          data: undefined,
          error: new Error('paymaster rejected'),
          variables: { merchantAmount: 500n, feeAmount: 5n },
        },
        NO_STANDARD,
      ),
    );
    const [entry] = loadHistory();
    expect(entry.merchantAmount).toBe('500');
    expect(entry.feeAmount).toBe('5');
  });

  it('standard success: lastSubmittedParams が ctx より優先される (merchant + fee)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, merchantAmount: 9999n, feeAmount: 9999n },
        NO_GASLESS,
        {
          data: {
            merchantTxHash: '0xMtxS',
            feeTxHash: '0xFtxS',
            blockNumber: 10n,
          },
          phase: 'success',
          merchantTxHash: '0xMtxS',
          feeTxHash: '0xFtxS',
          error: null,
          lastSubmittedParams: { merchantAmount: 2000n, feeAmount: 20n },
        },
      ),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    const merchant = loaded.find((e) => e.flow === 'standard-merchant')!;
    const fee = loaded.find((e) => e.flow === 'standard-fee')!;
    expect(merchant.merchantAmount).toBe('2000');
    expect(merchant.feeAmount).toBe('20');
    // standard-fee 行の merchantAmount は feeAmount を映す慣行 (会計 export の互換)
    expect(fee.merchantAmount).toBe('20');
    expect(fee.feeAmount).toBe('20');
  });

  it('standard fee-error: lastSubmittedParams が補完 merchant 行にも適用される', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, merchantAmount: 9999n, feeAmount: 9999n },
        NO_GASLESS,
        {
          data: undefined,
          phase: 'fee-error',
          merchantTxHash: '0xMtxFE',
          merchantBlockNumber: 50n,
          feeTxHash: '0xFtxFE',
          error: new Error('fee reverted'),
          lastSubmittedParams: { merchantAmount: 3000n, feeAmount: 30n },
        },
      ),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    const merchant = loaded.find((e) => e.flow === 'standard-merchant')!;
    expect(merchant.merchantAmount).toBe('3000');
    expect(merchant.feeAmount).toBe('30');
  });

  it('LocalStorage に直接 entry が出る (key=openpay:history:v1)', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTxLs',
            userOpHash: '0xUOLs',
            blockNumber: 1n,
            success: true,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toContain('0xTxLs');
  });
});

describe('usePaymentHistory: 顧客向け電子レシート (PayerReceipt) 保存', () => {
  beforeEach(() => window.localStorage.clear());

  it('gasless success → payer receipt も保存 (direction=paid・receiptId=txHash)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, sourceRoute: '/pay', locale: 'ja' },
        {
          data: { txHash: '0xTxR', userOpHash: '0xUOR', blockNumber: 1n, success: true },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].direction).toBe('paid');
    expect(receipts[0].kind).toBe('payment_receipt');
    expect(receipts[0].status).toBe('confirmed');
    expect(receipts[0].receiptId).toBe('0xTxR');
    expect(receipts[0].sourceRoute).toBe('/pay');
    // 店舗側履歴とは別ストア (history 1 件 + receipt 1 件)。
    expect(loadHistory()).toHaveLength(1);
  });

  it('gasless reverted → 控えは作らない (status reverted は除外)', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: { txHash: '0xRev', userOpHash: '0xUO', blockNumber: 1n, success: false },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    expect(loadHistory()).toHaveLength(1); // reverted は履歴には残る
    expect(loadPayerReceipts()).toHaveLength(0); // 控えは作らない
  });

  it('gasless error (throw) → 控えは作らない', () => {
    renderHook(() =>
      usePaymentHistory(CTX, { data: undefined, error: new Error('paymaster reject') }, NO_STANDARD),
    );
    expect(loadPayerReceipts()).toHaveLength(0);
  });

  it('standard-merchant success → payer receipt も保存 (receiptId=merchantTxHash)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, payMode: 'standard', gasMode: null, sourceRoute: '/checkout', locale: 'ja' },
        NO_GASLESS,
        {
          data: { merchantTxHash: '0xMtx', feeTxHash: undefined, blockNumber: 7n },
          phase: 'success',
          merchantTxHash: '0xMtx',
          feeTxHash: undefined,
          error: null,
          lastSubmittedParams: { merchantAmount: 1000n, feeAmount: 0n },
        },
      ),
    );
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receiptId).toBe('0xMtx');
    expect(receipts[0].sourceRoute).toBe('/checkout');
  });

  it('fee-error (merchant 着金確定) → 控えを 1 件保存 (店舗着金分のみ)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, payMode: 'standard', gasMode: null },
        NO_GASLESS,
        {
          data: undefined,
          phase: 'fee-error',
          merchantTxHash: '0xMtxFE2',
          merchantBlockNumber: 50n,
          feeTxHash: '0xFtxFE2',
          error: new Error('fee reverted'),
          lastSubmittedParams: { merchantAmount: 3000n, feeAmount: 30n },
        },
      ),
    );
    // fee 失敗 leg は控えを作らず、merchant 着金確定分のみ 1 件。
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receiptId).toBe('0xMtxFE2');
    expect(receipts[0].status).toBe('confirmed');
  });

  it('gasless pending + txHash → status=pending の控えを保存 (relay broadcast)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...CTX, sourceRoute: '/pay', locale: 'ja' },
        {
          data: { txHash: '0xpend', userOpHash: null, blockNumber: null, success: false, pending: true },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('pending');
    expect(receipts[0].receiptId).toBe('0xpend');
  });

  it('pending かつ txHash 無し (authorizationState 既使用) → 履歴も控えも作らない', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: { txHash: null, userOpHash: null, blockNumber: null, success: false, pending: true },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    expect(loadHistory()).toHaveLength(0);
    expect(loadPayerReceipts()).toHaveLength(0);
  });

  it('再レンダー (同一 txHash の新 data 参照) → receiptId dedupe で控えは 1 件のまま', () => {
    // 毎回新しいオブジェクト参照を返すが txHash は同一。
    const data = () => ({
      txHash: '0xdup' as `0x${string}`,
      userOpHash: '0xuo' as `0x${string}`,
      blockNumber: 1n,
      success: true,
    });
    const { rerender } = renderHook(
      ({ d }: { d: ReturnType<typeof data> }) =>
        usePaymentHistory({ ...CTX, sourceRoute: '/pay' }, { data: d, error: null }, NO_STANDARD),
      { initialProps: { d: data() } },
    );
    expect(loadPayerReceipts()).toHaveLength(1);
    // 別オブジェクト参照で effect が再実行されても receiptId dedupe で増えない。
    rerender({ d: data() });
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(loadHistory()).toHaveLength(1);
  });
});
