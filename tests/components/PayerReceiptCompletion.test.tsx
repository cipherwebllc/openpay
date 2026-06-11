import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { PayerReceiptCompletion } from '@/components/PayerReceiptCompletion';
import { appendPayerReceipt, buildPayerReceipt } from '@/lib/payerReceipt';

// usePayerReceipts の hydrate 後 reconcile を no-op 化 (jsdom に実 RPC 無し)。
vi.mock('@/lib/payerReceiptReconcile', () => ({
  reconcilePendingReceipts: vi.fn(async () => 0),
  fetchReceiptTxStatus: vi.fn(async () => 'unknown' as const),
}));

const NOW = new Date('2026-06-04T01:42:00.000Z');
const POLYGON_AMOY_ID = 80002;

function seed(over: Partial<Parameters<typeof buildPayerReceipt>[0]> = {}) {
  const r = buildPayerReceipt(
    {
      txHash: `0x${'a'.repeat(64)}`,
      userOpHash: `0x${'b'.repeat(64)}`,
      chainId: POLYGON_AMOY_ID,
      asset: 'jpyc',
      amount: '1000',
      merchantAddress: '0xMerchantWallet',
      merchantName: 'OpenPay Cafe',
      ...over,
    },
    NOW,
  );
  appendPayerReceipt(r);
  return r;
}

describe('PayerReceiptCompletion', () => {
  beforeEach(() => window.localStorage.clear());

  it('candidateIds が全て空 → 何も描画しない', () => {
    const { container } = render(
      <PayerReceiptCompletion candidateIds={[undefined, null, '']} />,
    );
    expect(container.textContent).toBe('');
  });

  it('一致する控えが無い → 何も描画しない', () => {
    seed({ txHash: '0xstored' });
    const { container } = render(
      <PayerReceiptCompletion candidateIds={['0xnomatch']} />,
    );
    expect(container.textContent).toBe('');
  });

  it('txHash 一致 → 詳細 + /scan 導線を描画', () => {
    seed({ txHash: '0xMATCH' });
    render(<PayerReceiptCompletion candidateIds={['0xMATCH']} />);
    // 完了見出し + 詳細タイトル
    expect(screen.getByText('支払い控え')).toBeTruthy();
    expect(screen.getByText('OpenPay 電子レシート')).toBeTruthy();
    // /scan リンク
    const link = screen.getByRole('link', { name: /電子レシート/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/scan');
  });

  it('receiptId = userOpHash (txHash 無し pending) でも候補に userOpHash を渡せば一致', () => {
    // txHash 無し → receiptId = userOpHash
    seed({ txHash: null, userOpHash: '0xUOPENDING', status: 'pending' });
    render(
      <PayerReceiptCompletion candidateIds={[undefined, '0xUOPENDING']} />,
    );
    expect(screen.getByText('OpenPay 電子レシート')).toBeTruthy();
  });

  it('null/undefined を含む候補配列でも安全に最初の一致を採用', () => {
    seed({ txHash: '0xLAST' });
    render(
      <PayerReceiptCompletion candidateIds={[null, undefined, '0xLAST', '0xother']} />,
    );
    expect(screen.getByText('OpenPay 電子レシート')).toBeTruthy();
  });
});
