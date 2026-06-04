import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { LedgerPaidRow } from '@/components/LedgerPaidRow';
import {
  appendPayerReceipt,
  buildPayerReceipt,
  loadPayerReceipts,
} from '@/lib/payerReceipt';

function makeReceipt() {
  return buildPayerReceipt(
    {
      asset: 'jpyc',
      amount: '500',
      merchantAddress: '0xShopAddr',
      merchantName: 'Coffee Stand',
      txHash: `0x${'b'.repeat(64)}`,
      status: 'confirmed',
    },
    new Date('2026-06-01T00:00:00.000Z'),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('LedgerPaidRow', () => {
  it('支払い (out) バッジ + 店舗名 + 控え詳細を描画', () => {
    render(<LedgerPaidRow receipt={makeReceipt()} />);
    expect(screen.getByText('支払い')).toBeInTheDocument();
    expect(screen.getAllByText('Coffee Stand').length).toBeGreaterThan(0);
    // PayerReceiptDetail を内包 (控え見出し)。
    expect(screen.getByText('OpenPay 電子レシート')).toBeInTheDocument();
  });

  it('削除 → confirm true で removePayerReceipt (store から消える)', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const r = makeReceipt();
    appendPayerReceipt(r);
    expect(loadPayerReceipts()).toHaveLength(1);

    render(<LedgerPaidRow receipt={r} />);
    await user.click(screen.getByRole('button', { name: '削除' }));
    expect(loadPayerReceipts()).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('削除 → confirm false なら削除しない', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const r = makeReceipt();
    appendPayerReceipt(r);

    render(<LedgerPaidRow receipt={r} />);
    await user.click(screen.getByRole('button', { name: '削除' }));
    expect(loadPayerReceipts()).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
