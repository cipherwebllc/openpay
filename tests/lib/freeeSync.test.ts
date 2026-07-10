import { describe, it, expect, vi } from 'vitest';
import {
  runFreeeSync,
  buildFreeeDeal,
  freeeIdempotencyKey,
  freeeIssueDate,
  freeeDescription,
  type FreeeSyncDeps,
  type FreeeMapping,
  type FreeeDealBody,
  type ClaimState,
} from '@/lib/freeeSync';
import type { HistoryEntry } from '@/lib/history';

const MAPPING: FreeeMapping = { companyId: 7, accountItemId: 101, taxCode: 21 };
const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: 'e-' + Math.random().toString(36).slice(2),
    ts: new Date(2026, 5, 15, 9, 0, 0).getTime(),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000000', // 1000 JPYC
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: null,
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
    ...overrides,
  };
}

function deps(overrides: Partial<FreeeSyncDeps> = {}): FreeeSyncDeps {
  return {
    wallet: WALLET,
    usdcJpy: 150,
    mapping: MAPPING,
    claim: vi.fn(async (): Promise<ClaimState> => ({ kind: 'fresh' })),
    createDeal: vi.fn(async () => 9001),
    finalize: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('freee 純粋ヘルパ', () => {
  it('freeeIssueDate: ローカル YYYY-MM-DD', () => {
    expect(freeeIssueDate(new Date(2026, 5, 3, 23, 0, 0).getTime())).toBe('2026-06-03');
  });

  it('freeeIdempotencyKey: txHash 優先・wallet は小文字', () => {
    const e = entry({ txHash: '0xABC', id: 'fallback' });
    expect(freeeIdempotencyKey(WALLET, e)).toBe(
      `freee:synced:${WALLET.toLowerCase()}:0xABC`,
    );
    const noTx = entry({ txHash: null, id: 'fallback-id' });
    expect(freeeIdempotencyKey(WALLET, noTx)).toBe(
      `freee:synced:${WALLET.toLowerCase()}:fallback-id`,
    );
  });

  it('buildFreeeDeal: type=income・整数円 amount・mapping ID・摘要', () => {
    const body = buildFreeeDeal(entry(), 1000, MAPPING);
    expect(body.type).toBe('income');
    expect(body.company_id).toBe(7);
    expect(body.issue_date).toBe('2026-06-15');
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({
      account_item_id: 101,
      tax_code: 21,
      amount: 1000,
    });
    expect(body.details[0].description).toContain('OpenPay');
  });

  it('freeeDescription: anchor 付き USDC は元の円価格を含む', () => {
    const e = entry({
      asset: 'usdc',
      merchantAmount: '6400000',
      anchorAmount: '1000',
      anchorSymbol: 'jpyc',
      txHash: `0x${'b'.repeat(64)}`,
    });
    const d = freeeDescription(e);
    expect(d).toContain('USDC/polygon');
    expect(d).toContain('元:1000 JPYC');
  });
});

describe('runFreeeSync', () => {
  it('店舗負担手数料は saleAmount (gross) で同期し standard-fee leg は除外', async () => {
    const createDeal = vi.fn(async (_body: FreeeDealBody) => 9001);
    const d = deps({ createDeal });
    const r = await runFreeeSync(
      [
        entry({
          id: 'gross-sale',
          merchantAmount: '990000000000000000000',
          saleAmount: '1000000000000000000000',
        }),
        entry({
          id: 'fee-leg',
          flow: 'standard-fee',
          merchantAmount: '10000000000000000000',
          saleAmount: null,
        }),
      ],
      d,
    );
    expect(r.synced).toBe(1);
    expect(r.items.find((i) => i.id === 'fee-leg')?.status).toBe('not-income');
    expect(createDeal).toHaveBeenCalledOnce();
    expect(createDeal.mock.calls[0][0].details[0].amount).toBe(1000);
  });

  it('income 以外 (revert/error/手数料) は not-income で除外', async () => {
    const d = deps();
    const r = await runFreeeSync(
      [
        entry({ id: 'ok' }),
        entry({ id: 'rev', status: 'reverted' }),
        entry({ id: 'fee', flow: 'standard-fee' }),
      ],
      d,
    );
    expect(r.synced).toBe(1);
    expect(r.items.find((i) => i.id === 'rev')?.status).toBe('not-income');
    expect(r.items.find((i) => i.id === 'fee')?.status).toBe('not-income');
    expect(d.createDeal).toHaveBeenCalledOnce();
  });

  it('fresh → createDeal → finalize で synced (dealId 付き)', async () => {
    const d = deps({ createDeal: vi.fn(async () => 555) });
    const r = await runFreeeSync([entry({ id: 'x' })], d);
    expect(r.items[0]).toMatchObject({ id: 'x', status: 'synced', dealId: 555 });
    expect(d.finalize).toHaveBeenCalledWith(expect.any(String), 555);
    expect(d.release).not.toHaveBeenCalled();
  });

  it('done (既に同期済) → skipped・createDeal 呼ばない', async () => {
    const d = deps({
      claim: vi.fn(async (): Promise<ClaimState> => ({ kind: 'done', dealId: 42 })),
    });
    const r = await runFreeeSync([entry({ id: 'dup' })], d);
    expect(r.items[0]).toMatchObject({ id: 'dup', status: 'skipped', dealId: 42 });
    expect(r.skipped).toBe(1);
    expect(d.createDeal).not.toHaveBeenCalled();
  });

  it('in-flight (別送信処理中) → skipped', async () => {
    const d = deps({
      claim: vi.fn(async (): Promise<ClaimState> => ({ kind: 'in-flight' })),
    });
    const r = await runFreeeSync([entry()], d);
    expect(r.items[0].status).toBe('skipped');
    expect(d.createDeal).not.toHaveBeenCalled();
  });

  it('finalize 失敗 → deal 作成済だが error(deal_created_unrecorded)・release しない', async () => {
    const d = deps({
      createDeal: vi.fn(async () => 777),
      finalize: vi.fn(async () => false),
    });
    const r = await runFreeeSync([entry({ id: 'x' })], d);
    expect(r.items[0]).toMatchObject({
      id: 'x',
      status: 'error',
      dealId: 777,
      error: 'deal_created_unrecorded',
    });
    expect(d.release).not.toHaveBeenCalled(); // claim を残し TTL 内の二重作成を防ぐ
    expect(r.errored).toBe(1);
  });

  it('不正な ts (非有限) → invalid_entry で弾く (createDeal 呼ばない)', async () => {
    const d = deps();
    const r = await runFreeeSync([entry({ id: 'badts', ts: NaN })], d);
    expect(r.items[0]).toMatchObject({ id: 'badts', status: 'error', error: 'invalid_entry' });
    expect(d.createDeal).not.toHaveBeenCalled();
  });

  it('createDeal が throw → error + release で claim 解放 (再試行可)', async () => {
    const d = deps({
      createDeal: vi.fn(async () => {
        throw new Error('freee_api_http_500');
      }),
    });
    const r = await runFreeeSync([entry({ id: 'boom' })], d);
    expect(r.errored).toBe(1);
    expect(r.items[0]).toMatchObject({ id: 'boom', status: 'error', error: 'freee_api_http_500' });
    expect(d.release).toHaveBeenCalledOnce();
    expect(d.finalize).not.toHaveBeenCalled();
  });

  it('USDC 無 anchor + レート無 → rate-unavailable (createDeal 呼ばない)', async () => {
    const d = deps({ usdcJpy: undefined });
    const r = await runFreeeSync(
      [entry({ id: 'u', asset: 'usdc', merchantAmount: '6400000', anchorAmount: null })],
      d,
    );
    expect(r.rateUnavailable).toBe(1);
    expect(r.items[0].status).toBe('rate-unavailable');
    expect(d.createDeal).not.toHaveBeenCalled();
  });

  it('不正な merchantAmount → yen 0 → invalid_entry で弾く (0円 garbage deal を作らない)', async () => {
    const createDeal = vi.fn(async () => 1);
    const d = deps({ createDeal });
    const r = await runFreeeSync([entry({ id: 'bad', merchantAmount: 'not-a-number' })], d);
    expect(r.items[0]).toMatchObject({ id: 'bad', status: 'error', error: 'invalid_entry' });
    expect(createDeal).not.toHaveBeenCalled();
  });
});

describe('freeeDescription: v5 記帳補助メタ enrich (摘要)', () => {
  it('商品名 / 管理番号 / メモ を摘要に含める', () => {
    const d = freeeDescription(
      entry({
        productName: 'コーヒー',
        receiptNo: 'R-1',
        memo: 'イベント販売',
        txHash: `0x${'a'.repeat(64)}`,
      }),
    );
    expect(d).toContain('OpenPay');
    expect(d).toContain('コーヒー');
    expect(d).toContain('No:R-1');
    expect(d).toContain('イベント販売');
  });

  it('冪等キーは v5 メタを足しても不変 (再同期で二重計上しない)', () => {
    const a = entry({ txHash: '0xABC', productName: 'X' });
    const b = entry({ txHash: '0xABC', productName: 'Y', memo: 'diff', receiptNo: 'R-9' });
    expect(freeeIdempotencyKey(WALLET, a)).toBe(freeeIdempotencyKey(WALLET, b));
  });

  it('複数商品は摘要に「商品 x数量」を列挙 (1取引1 deal・明細は摘要)', () => {
    const d = freeeDescription(
      entry({
        lineItems: [
          { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
          { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 8, taxCategory: 'taxable_8', memo: null },
        ],
      }),
    );
    expect(d).toContain('コーヒー x2');
    expect(d).toContain('Tシャツ x1');
  });

  it('runFreeeSync (実コア): 複数商品 entry → 1 取引 1 deal・摘要に明細サマリ', async () => {
    const createDeal = vi.fn(async (_body: FreeeDealBody) => 555);
    const d = deps({ createDeal });
    const e = entry({
      id: 'multi',
      lineItems: [
        { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
        { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
      ],
    });
    const r = await runFreeeSync([e], d);
    expect(r.synced).toBe(1);
    expect(createDeal).toHaveBeenCalledOnce(); // 明細を複数 deal に割らず 1 取引 1 deal
    const body = createDeal.mock.calls[0][0];
    expect(body.details[0].description).toContain('コーヒー x2');
    expect(body.details[0].description).toContain('Tシャツ x1');
  });
});
