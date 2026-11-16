import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { HISTORY_STORAGE_KEY, loadHistory } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';

// 他店への支払い (払った人 ≠ 受取先)。履歴の行 (「受取」) は書かず、「支払い」の控えだけを残す。
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
// 受取先 = 自分 (払った人と受取先が同じアドレス。表記の大文字小文字は違う)。履歴の行も書く。
const SELF = { ...CTX, customer: '0xMERCHANT' as `0x${string}` };

const NO_STANDARD = {
  data: undefined,
  phase: 'idle',
  merchantTxHash: undefined,
  feeTxHash: undefined,
  error: null,
};

const NO_GASLESS = { data: undefined, error: null };

// 行の値の検査。会計は「受取先 = 自分」(SELF) = 払った側のブラウザが履歴の行を書く、ただ 1 つの場合。
describe('usePaymentHistory: 受取先 = 自分 のとき、履歴の行を書く', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('gasless success → status=success の batch entry を append', () => {
    renderHook(() =>
      usePaymentHistory(
        SELF,
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
        SELF,
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
    expect(e.saleAmount).toBe('1000'); // SELF.saleAmount (gross)
    expect(e.networkFeeEquivalent).toBe('10'); // SELF.networkFeeEquivalent (gas 相当)
    expect(e.feeAmount).toBe('10'); // SELF.feeAmount (サービス料・分離後はこれのみ)
    expect(e.feeBreakdownVersion).toBe(1); // native v3 = 分離済
  });

  it('circle gasless: networkFeeEquivalent は null (circlePaymasterNetUsdc 側に検証付きで保持)', () => {
    renderHook(() =>
      usePaymentHistory(
        SELF,
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
        SELF,
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
        SELF,
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
      usePaymentHistory(SELF, NO_GASLESS, {
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

  // 第 7 回レビュー A9: 手数料 leg の block は手数料 tx 自身のもの (店舗送金の block を流用しない)。
  it('standard success: 手数料 leg の blockNumber は手数料 receipt の block・店舗 leg は店舗の block', () => {
    renderHook(() =>
      usePaymentHistory(SELF, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMTxA9',
          feeTxHash: '0xFTxA9',
          blockNumber: 100n,
          feeBlockNumber: 101n,
        },
        phase: 'success',
        merchantTxHash: '0xMTxA9',
        feeTxHash: '0xFTxA9',
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded.find((e) => e.flow === 'standard-merchant')?.blockNumber).toBe('100');
    expect(loaded.find((e) => e.flow === 'standard-fee')?.blockNumber).toBe('101');
  });

  it('standard success: 手数料の block が取れていなければ、手数料 leg の blockNumber は空 (店舗の block を入れない)', () => {
    renderHook(() =>
      usePaymentHistory(SELF, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMTxA9b',
          feeTxHash: '0xFTxA9b',
          blockNumber: 100n,
        },
        phase: 'success',
        merchantTxHash: '0xMTxA9b',
        feeTxHash: '0xFTxA9b',
        error: null,
      }),
    );
    const fee = loadHistory().find((e) => e.flow === 'standard-fee');
    expect(fee?.txHash).toBe('0xFTxA9b');
    expect(fee?.blockNumber).toBeNull();
  });

  it('standard success (fee tx なし、極小 fee=0) → merchant のみ 1 件', () => {
    renderHook(() =>
      usePaymentHistory(SELF, NO_GASLESS, {
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
      usePaymentHistory(SELF, NO_GASLESS, {
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
      usePaymentHistory(SELF, NO_GASLESS, {
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

  it('fee-awaiting の reload 復元は merchant 成功だけを保持し、hash 無し fee-error 行を増やさない', () => {
    renderHook(() =>
      usePaymentHistory(SELF, NO_GASLESS, {
        data: undefined,
        phase: 'fee-error',
        merchantTxHash: '0xMTxRestored',
        feeTxHash: undefined,
        merchantBlockNumber: 42n,
        error: null,
        restoredFromStorage: true,
      }),
    );

    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      flow: 'standard-merchant',
      status: 'success',
      txHash: '0xMTxRestored',
      blockNumber: '42',
    });
  });

  it('error.message は 500 文字に truncate される (DoS 対策)', () => {
    const longMsg = 'X'.repeat(2000);
    renderHook(() =>
      usePaymentHistory(
        SELF,
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
          SELF,
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
      usePaymentHistory(SELF, NO_GASLESS, {
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
      usePaymentHistory(SELF, NO_GASLESS, {
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
      usePaymentHistory(SELF, NO_GASLESS, {
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
      usePaymentHistory(SELF, NO_GASLESS, {
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
        { ...SELF, merchantAmount: 9999n, feeAmount: 9999n }, // 後から drift した live ctx
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
        { ...SELF, merchantAmount: 9999n, feeAmount: 9999n },
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

  it('standard success: saleAmount 未送信の旧 snapshot は merchant + fee で復元', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...SELF, merchantAmount: 9999n, feeAmount: 9999n },
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
    expect(merchant.saleAmount).toBe('2020');
    // standard-fee 行の merchantAmount は feeAmount を映す慣行 (会計 export の互換)
    expect(fee.merchantAmount).toBe('20');
    expect(fee.feeAmount).toBe('20');
  });

  it('顧客上乗せ standard は saleAmount (商品小計) を優先し手数料を gross に足さない', () => {
    renderHook(() =>
      usePaymentHistory(SELF, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMtxGross',
          feeTxHash: '0xFtxGross',
          blockNumber: 11n,
        },
        phase: 'success',
        merchantTxHash: '0xMtxGross',
        feeTxHash: '0xFtxGross',
        error: null,
        lastSubmittedParams: {
          merchantAmount: 2000n,
          feeAmount: 20n,
          saleAmount: 2000n,
        },
      }),
    );
    const merchant = loadHistory().find(
      (e) => e.flow === 'standard-merchant',
    )!;
    expect(merchant.merchantAmount).toBe('2000');
    expect(merchant.feeAmount).toBe('20');
    expect(merchant.saleAmount).toBe('2000');
  });

  it('standard fee-error: lastSubmittedParams が補完 merchant 行にも適用される', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...SELF, merchantAmount: 9999n, feeAmount: 9999n },
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
        SELF,
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
    // 他店への支払い: 控えだけ (履歴の「受取」の行は書かない)。
    expect(loadHistory()).toHaveLength(0);
  });

  it('受取先 = 自分 の gasless success → 履歴 1 行 + 控え 1 件 (別ストア・控えの中身は払った人の欄のほかは他店への支払いと同じ)', () => {
    const data = { txHash: '0xTxR' as const, userOpHash: '0xUOR' as const, blockNumber: 1n, success: true };
    renderHook(() =>
      usePaymentHistory({ ...CTX, sourceRoute: '/pay', locale: 'ja' }, { data, error: null }, NO_STANDARD),
    );
    const [other] = loadPayerReceipts();
    window.localStorage.clear();
    renderHook(() =>
      usePaymentHistory({ ...SELF, sourceRoute: '/pay', locale: 'ja' }, { data, error: null }, NO_STANDARD),
    );
    expect(loadHistory()).toHaveLength(1);
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].payerAddress).toBe('0xMERCHANT');
    expect(other.payerAddress).toBe('0xCustomer');
    // 時刻 (書いた瞬間の端末の時計) と払った人のほかは、欄ごとに同じ。
    const rest = (r: (typeof receipts)[number]) => ({ ...r, payerAddress: '', createdAt: '', paidAt: '' });
    expect(rest(receipts[0])).toEqual(rest(other));
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
    expect(loadHistory()).toHaveLength(0); // 他店への支払い: reverted は履歴にも残らない
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

  it('pending かつ txHash 無し (authorizationState 既使用) → 受取先 = 自分 でも、履歴も控えも作らない', () => {
    renderHook(() =>
      usePaymentHistory(
        SELF,
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

  it('再レンダー (同一 txHash の新 data 参照・受取先 = 自分) → receiptId dedupe で控えは 1 件・履歴も 1 行のまま', () => {
    // 毎回新しいオブジェクト参照を返すが txHash は同一。
    const data = () => ({
      txHash: '0xdup' as `0x${string}`,
      userOpHash: '0xuo' as `0x${string}`,
      blockNumber: 1n,
      success: true,
    });
    const { rerender } = renderHook(
      ({ d }: { d: ReturnType<typeof data> }) =>
        usePaymentHistory({ ...SELF, sourceRoute: '/pay' }, { data: d, error: null }, NO_STANDARD),
      { initialProps: { d: data() } },
    );
    expect(loadPayerReceipts()).toHaveLength(1);
    // 別オブジェクト参照で effect が再実行されても receiptId dedupe で増えない。
    rerender({ d: data() });
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(loadHistory()).toHaveLength(1);
  });
});

// 第 10 回レビュー A-1 の Codex 第 2 回 MUST 2: 別の Pimlico の intent の確定 (reload の後や別の画面で「同じ送信内容を再確認」した
// 支払い・useBatchPayment の settledOtherIntent) を、今の画面の店・注文・明細と組み合わせて記録しない。
describe('usePaymentHistory: 別の intent の確定 (settledOtherIntent)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // 今の画面 = 店 B・注文 B (店名・明細・注文 ID・インボイス・メモ・商品名・税・FX の anchor つき)。
  const SCREEN_B = {
    ...CTX,
    merchant: '0xMerchantB' as `0x${string}`,
    merchantAmount: 2000n,
    saleAmount: 2000n,
    storeName: 'Shop B',
    receiptMerchantName: 'Shop B',
    note: 'note B',
    productName: 'Product B',
    memo: 'memo B',
    taxRate: 10,
    taxCategory: 'taxable_10' as const,
    receiptNo: 'R-B',
    orderId: 'order-B',
    invoiceNo: 'T1234567890123',
    anchorAmount: '20',
    anchorSymbol: 'usdc' as const,
    fxRateUsdcJpy: '150',
    lineItems: [
      { name: 'Item B', quantity: 1, unitPrice: '20', amount: '20', taxRate: 10, taxCategory: 'taxable_10' as const, memo: null },
    ],
    sourceRoute: '/checkout',
    locale: 'ja',
  };
  // 実際に確定した支払い = 店 A への 10 (保存した intent の params)。
  const INTENT_A = {
    merchant: '0xMerchantA' as `0x${string}`,
    merchantAmount: 1000n,
    feeReceiver: '0xFeeA' as `0x${string}`,
    feeAmount: 0n,
    saleAmount: 1000n,
    networkFeeEquivalent: 3n,
  };
  const SETTLED = {
    txHash: '0xTxA' as `0x${string}`,
    userOpHash: '0xUOA' as `0x${string}`,
    blockNumber: 5n,
    success: true,
  };

  // 履歴の行を書くかは、その intent の受取先が払った人かで決める (今の画面の受取先では決めない)。
  // 自分宛ての画面 (払った人 = 店 B の受取先。表記の大文字小文字は違う)。
  const SELF_SCREEN_B = { ...SCREEN_B, customer: '0xMERCHANTB' as `0x${string}` };
  // 払った人 (SCREEN_B.customer = 0xCustomer) 自身が受取先の intent。
  const INTENT_SELF = { ...INTENT_A, merchant: '0xCUSTOMER' as `0x${string}` };

  it('自分宛ての画面で、他店への別の intent が確定 → 履歴の行は書かない。控えは intent 自体の受取先・金額で書き、今の画面の店名・注文・明細・インボイスは付けない', () => {
    renderHook(() =>
      usePaymentHistory(
        SELF_SCREEN_B,
        {
          data: SETTLED,
          error: null,
          variables: INTENT_A,
          settledOtherIntent: true,
          recoveredIntent: INTENT_A,
        },
        NO_STANDARD,
      ),
    );
    expect(loadHistory()).toHaveLength(0);

    const [receipt] = loadPayerReceipts();
    expect(receipt.merchantAddress).toBe('0xMerchantA');
    expect(receipt.orderId).toBeUndefined();
    expect(receipt.merchantName).toBeUndefined();
    expect(receipt.merchantInvoiceNo).toBeUndefined();
    expect(receipt.receiptNo).toBeUndefined();
    expect((receipt.lineItems ?? []).map((item) => item.name)).not.toContain('Item B');
    expect(receipt.sourceRoute).toBe('/checkout');
  });

  it('他店宛ての画面で、自分宛ての別の intent が確定 → intent 自体の受取先・金額で履歴と控えを書き、今の画面の店名・注文・明細・メモ・税・インボイス・anchor は付けない', () => {
    renderHook(() =>
      usePaymentHistory(
        SCREEN_B,
        {
          data: SETTLED,
          error: null,
          variables: INTENT_SELF,
          settledOtherIntent: true,
          recoveredIntent: INTENT_SELF,
        },
        NO_STANDARD,
      ),
    );
    const [entry] = loadHistory();
    expect(entry).toMatchObject({
      merchant: '0xCUSTOMER',
      customer: '0xCustomer',
      merchantAmount: '1000',
      feeReceiver: '0xFeeA',
      saleAmount: '1000',
      networkFeeEquivalent: '3',
      txHash: '0xTxA',
      storeName: '',
      note: '',
      gasMode: null,
      chainId: CTX.chainId,
      tokenAddress: CTX.tokenAddress,
    });
    expect(entry.productName ?? null).toBeNull();
    expect(entry.memo ?? null).toBeNull();
    expect(entry.taxRate ?? null).toBeNull();
    expect(entry.receiptNo ?? null).toBeNull();
    expect(entry.lineItems ?? null).toBeNull();
    expect(entry.anchorAmount ?? null).toBeNull();

    const [receipt] = loadPayerReceipts();
    expect(receipt.merchantAddress).toBe('0xCUSTOMER');
    expect(receipt.orderId).toBeUndefined();
    expect(receipt.merchantName).toBeUndefined();
    expect(receipt.merchantInvoiceNo).toBeUndefined();
    expect(receipt.receiptNo).toBeUndefined();
    expect((receipt.lineItems ?? []).map((item) => item.name)).not.toContain('Item B');
    expect(receipt.sourceRoute).toBe('/checkout');
  });

  it('帰属を確かめられない (recoveredIntent が null) → 自分宛ての画面でも、履歴も控えも書かない', () => {
    renderHook(() =>
      usePaymentHistory(
        SELF_SCREEN_B,
        {
          data: SETTLED,
          error: null,
          variables: INTENT_A,
          settledOtherIntent: true,
          recoveredIntent: null,
        },
        NO_STANDARD,
      ),
    );
    expect(loadHistory()).toHaveLength(0);
    expect(loadPayerReceipts()).toHaveLength(0);
  });

  it('画面から送った支払いの確定 (settledOtherIntent=false・自分宛ての画面) は今までどおり画面の文脈で書く', () => {
    renderHook(() =>
      usePaymentHistory(
        SELF_SCREEN_B,
        { data: SETTLED, error: null, settledOtherIntent: false, recoveredIntent: null },
        NO_STANDARD,
      ),
    );
    const [entry] = loadHistory();
    expect(entry.merchant).toBe('0xMerchantB');
    expect(entry.storeName).toBe('Shop B');
    expect(loadPayerReceipts()[0].orderId).toBe('order-B');
  });
});

// 履歴の行 (「受取」) を払った側のブラウザが書くのは、受取先が自分のときだけ。他店への支払い (CTX) は、どの状態でも行を
// 書かない。「支払い」の控えは今までどおり (成功・pending・店舗着金の確定で 1 件)。
describe('usePaymentHistory: 他店への支払い (受取先 ≠ 自分) は履歴の行を書かない', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  type Gasless = Parameters<typeof usePaymentHistory>[1];
  type Standard = Parameters<typeof usePaymentHistory>[2];
  const settled = (over: Partial<NonNullable<Gasless['data']>> = {}): Gasless => ({
    data: { txHash: '0xTx', userOpHash: '0xUO', blockNumber: 1n, success: true, ...over },
    error: null,
  });
  const standard = (over: Partial<Standard>): Standard => ({ ...NO_STANDARD, ...over });
  const STD_CTX = { payMode: 'standard' as const, gasMode: null };

  // [状態, gasless, standard, 控えの [receiptId, status], 受取先 = 自分 のときの行の [flow, status] (並べ替え済み)]
  const CASES: [string, Gasless, Standard, [string, string][], [string, string][]][] = [
    ['gasless 成功', settled(), NO_STANDARD, [['0xTx', 'confirmed']], [['batch', 'success']]],
    [
      'gasless pending (relay・hash あり)',
      settled({ userOpHash: null, blockNumber: null, success: false, pending: true }),
      NO_STANDARD,
      [['0xTx', 'pending']],
      [['batch', 'pending']],
    ],
    ['gasless reverted', settled({ success: false }), NO_STANDARD, [], [['batch', 'reverted']]],
    ['gasless error', { data: undefined, error: new Error('paymaster rejected') }, NO_STANDARD, [], [['batch', 'error']]],
    [
      'standard 成功 (fee tx あり)',
      NO_GASLESS,
      standard({ data: { merchantTxHash: '0xM', feeTxHash: '0xF', blockNumber: 5n }, phase: 'success' }),
      [['0xM', 'confirmed']],
      [['standard-fee', 'success'], ['standard-merchant', 'success']],
    ],
    [
      'standard 成功 (fee tx なし)',
      NO_GASLESS,
      standard({ data: { merchantTxHash: '0xM', feeTxHash: undefined, blockNumber: 5n }, phase: 'success' }),
      [['0xM', 'confirmed']],
      [['standard-merchant', 'success']],
    ],
    [
      'standard merchant-error',
      NO_GASLESS,
      standard({ phase: 'merchant-error', merchantTxHash: '0xM', error: new Error('insufficient gas') }),
      [],
      [['standard-merchant', 'error']],
    ],
    [
      'standard fee-error (merchant 着金確定 = merchant の行の補完 + fee の失敗)',
      NO_GASLESS,
      standard({ phase: 'fee-error', merchantTxHash: '0xM', merchantBlockNumber: 9n, feeTxHash: '0xF', error: new Error('fee reverted') }),
      [['0xM', 'confirmed']],
      [['standard-fee', 'error'], ['standard-merchant', 'success']],
    ],
    [
      'standard fee-error (merchant の block 未確定)',
      NO_GASLESS,
      standard({ phase: 'fee-error', merchantTxHash: '0xM', error: new Error('fee write rejected') }),
      [],
      [['standard-fee', 'error']],
    ],
    [
      'standard fee-error の reload 復元 (merchant の行の補完だけ)',
      NO_GASLESS,
      standard({ phase: 'fee-error', merchantTxHash: '0xM', merchantBlockNumber: 9n, restoredFromStorage: true }),
      [['0xM', 'confirmed']],
      [['standard-merchant', 'success']],
    ],
  ];
  const receiptsNow = () => loadPayerReceipts().map((r) => [r.receiptId, r.status]);
  const rowsNow = () => loadHistory().map((e) => [e.flow, e.status]).sort();

  it.each(CASES)('%s: 履歴の行は 0・控えは今までどおり (受取先 = 自分 なら行を書く)', (_name, gasless, std, receipts, selfRows) => {
    const ctxOf = (base: typeof CTX) => (std === NO_STANDARD ? base : { ...base, ...STD_CTX });
    // 他店への支払い。
    const other = renderHook(() => usePaymentHistory(ctxOf(CTX), gasless, std));
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull();
    expect(receiptsNow()).toEqual(receipts);
    for (const r of loadPayerReceipts()) expect(r).toMatchObject({ payerAddress: '0xCustomer', merchantAddress: '0xMerchant' });
    other.unmount();

    // 対照: 同じ状態で、受取先 = 自分 (表記の大文字小文字は違う) なら行を書く。控えの件数は同じ。
    window.localStorage.clear();
    renderHook(() => usePaymentHistory(ctxOf(SELF), gasless, std));
    expect(rowsNow()).toEqual(selfRows);
    expect(receiptsNow()).toEqual(receipts);
  });

  it.each([
    ['同じ表記', '0xMerchant'],
    ['小文字', '0xmerchant'],
    ['大文字', '0XMERCHANT'],
  ])('受取先 = 自分 の判定は大文字小文字を無視する (払った人が %s)', (_label, customer) => {
    renderHook(() => usePaymentHistory({ ...CTX, customer: customer as `0x${string}` }, settled(), NO_STANDARD));
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    // 行の欄は渡した表記のまま (判定のために書き換えない)。
    expect(rows[0]).toMatchObject({ merchant: '0xMerchant', customer });
  });

  it.each([
    ['1 文字多い', '0xMerchant0'],
    ['1 文字少ない', '0xMerchan'],
    ['未接続 (払った人が分からない)', undefined],
  ])('払った人が受取先と %s → 自分ではない (行を書かない・控えは書く)', (_label, customer) => {
    renderHook(() => usePaymentHistory({ ...CTX, customer: customer as `0x${string}` | undefined }, settled(), NO_STANDARD));
    expect(loadHistory()).toEqual([]);
    expect(receiptsNow()).toEqual([['0xTx', 'confirmed']]);
  });

  // 手数料の leg (standard-fee) の行は merchant 欄が feeReceiver になる。書くかどうかは、その支払いの売上の受取先で決める
  // (売上の行と同じ結果)。払った人 = feeReceiver でも、売上の受取先が他人なら、どちらの行も書かない。
  it.each<[string, Standard]>([
    ['成功', standard({ data: { merchantTxHash: '0xM', feeTxHash: '0xF', blockNumber: 5n }, phase: 'success' })],
    ['fee-error', standard({ phase: 'fee-error', merchantTxHash: '0xM', merchantBlockNumber: 9n, feeTxHash: '0xF', error: new Error('fee reverted') })],
  ])('通常決済 (%s): 払った人が利用料の受取先 (feeReceiver) でも、売上の受取先が他人なら fee の行も書かない', (_label, std) => {
    renderHook(() => usePaymentHistory({ ...CTX, ...STD_CTX, customer: '0xFEE' as `0x${string}` }, NO_GASLESS, std));
    expect(loadHistory()).toEqual([]);
    expect(receiptsNow()).toEqual([['0xM', 'confirmed']]);
  });

  it('通常決済: 受取先 = 自分 なら、売上の行と fee の行の両方 (fee の行の merchant 欄は feeReceiver のまま)', () => {
    renderHook(() =>
      usePaymentHistory(
        { ...SELF, ...STD_CTX },
        NO_GASLESS,
        standard({ data: { merchantTxHash: '0xM', feeTxHash: '0xF', blockNumber: 5n }, phase: 'success' }),
      ),
    );
    const rows = loadHistory();
    expect(rows.map((e) => [e.flow, e.merchant]).sort()).toEqual([
      ['standard-fee', '0xFee'],
      ['standard-merchant', '0xMerchant'],
    ]);
  });

  // 失敗の行は txHash が無く id で重複を落とせないので、その失敗 (Error) が届いたときの会計で 1 回だけ決める。
  it('gasless error: 他店への支払いの失敗は、後から会計が受取先 = 自分 に変わっても行を書き足さない', () => {
    const error = new Error('paymaster rejected');
    const { rerender } = renderHook(
      ({ ctx }: { ctx: typeof CTX }) => usePaymentHistory(ctx, { data: undefined, error }, NO_STANDARD),
      { initialProps: { ctx: CTX } },
    );
    expect(loadHistory()).toEqual([]);
    rerender({ ctx: SELF });
    expect(loadHistory()).toEqual([]);
  });
});
