import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { PayerReceiptList } from '@/components/PayerReceiptList';
import {
  appendPayerReceipt,
  buildPayerReceipt,
  PAYER_RECEIPTS_STORAGE_KEY,
} from '@/lib/payerReceipt';

const NOW = new Date('2026-06-04T01:42:00.000Z');
const POLYGON_AMOY_ID = 80002;

function seed(overrides: Partial<Parameters<typeof buildPayerReceipt>[0]> = {}) {
  appendPayerReceipt(
    buildPayerReceipt(
      {
        txHash: `0x${'a'.repeat(64)}`,
        chainId: POLYGON_AMOY_ID,
        asset: 'jpyc',
        amount: '4000',
        merchantAddress: '0xMerchantWallet',
        merchantName: 'OpenPay Cafe',
        payerAddress: '0xPayerWallet',
        receiptNo: 'OP-1',
        lineItems: [
          { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '90', memo: null },
        ],
        totalAmount: '4000',
        ...overrides,
      },
      NOW,
    ),
  );
}

describe('PayerReceiptList', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('空状態: 保存された電子レシートが無い旨 + ヒント + 保存場所の注意を表示', () => {
    render(<PayerReceiptList />);
    expect(screen.getByText('電子レシート / 支払い控え')).toBeTruthy();
    expect(
      screen.getByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeTruthy();
    expect(screen.getByText(/支払いを完了するとここに表示されます/)).toBeTruthy();
    // 保存場所の注意は空でも常時出す。
    expect(screen.getByText(/お使いの端末のブラウザにのみ保存/)).toBeTruthy();
  });

  it('レシートあり: 店舗名 + 合計を summary に表示し、展開すると明細/txHash が出る', () => {
    seed();
    render(<PayerReceiptList />);
    // 店舗名/合計は summary 行 + 展開済 detail の両方に出る (detail は collapsed でも DOM 上に存在)。
    expect(screen.getAllByText('OpenPay Cafe').length).toBeGreaterThan(0);
    expect(screen.getAllByText('4000 JPYC').length).toBeGreaterThan(0);
    // <details> の中身は collapsed でも DOM 上に存在 → 明細/txHash を検証
    expect(screen.getByText('コーヒー')).toBeTruthy();
    expect(screen.getByText(`0x${'a'.repeat(64)}`)).toBeTruthy();
    // 空状態文言は出ない
    expect(
      screen.queryByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeNull();
  });

  it('最新 5 件に制限 (6 件 seed → 5 件のみ詳細描画)', () => {
    for (let i = 0; i < 6; i++) {
      seed({ txHash: `0x${String(i).repeat(64).slice(0, 64)}`, receiptNo: `OP-${i}`, merchantName: `Shop ${i}` });
    }
    render(<PayerReceiptList />);
    // detailTitle は各レシート詳細に 1 つずつ → 5 件のみ
    expect(screen.getAllByText('OpenPay 電子レシート')).toHaveLength(5);
  });

  it('描画後に append (CHANGED_EVENT) → 空状態から一覧へ即時反映', () => {
    render(<PayerReceiptList />);
    expect(
      screen.getByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeTruthy();
    act(() => {
      appendPayerReceipt(
        buildPayerReceipt(
          { asset: 'jpyc', amount: '1000', merchantAddress: '0xM', merchantName: 'Live Shop', txHash: '0xlive' },
          NOW,
        ),
      );
    });
    expect(screen.getAllByText('Live Shop').length).toBeGreaterThan(0);
    expect(
      screen.queryByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeNull();
  });

  it('壊れた LocalStorage でも crash せず空状態 (drop)', () => {
    window.localStorage.setItem(PAYER_RECEIPTS_STORAGE_KEY, '{ this is not json');
    expect(() => render(<PayerReceiptList />)).not.toThrow();
    expect(
      screen.getByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeTruthy();
  });

  it('status ごとに色ドットを出し分け (pending=sky)', () => {
    seed({ txHash: '0xpend', userOpHash: '0xuo', status: 'pending', merchantName: 'Pending Shop' });
    const { container } = render(<PayerReceiptList />);
    expect(container.querySelector('.bg-sky-500')).toBeTruthy();
  });

  it('削除: confirm=true で該当控えを除去し再描画 (実 removePayerReceipt)', () => {
    seed({ txHash: '0xdel', merchantName: 'Del Shop' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PayerReceiptList />);
    expect(screen.getAllByText('Del Shop').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(screen.queryByText('Del Shop')).toBeNull();
    expect(
      screen.getByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeTruthy();
  });

  it('削除: confirm=false なら何もしない', () => {
    seed({ txHash: '0xkeep', merchantName: 'Keep Shop' });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PayerReceiptList />);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(screen.getAllByText('Keep Shop').length).toBeGreaterThan(0);
  });

  it('すべて消去: confirm=true で全控えを消去 (実 clearPayerReceipts)', () => {
    seed({ txHash: '0x1', merchantName: 'Shop 1' });
    seed({ txHash: '0x2', merchantName: 'Shop 2' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PayerReceiptList />);
    fireEvent.click(screen.getByRole('button', { name: 'すべて消去' }));
    expect(
      screen.getByText('このブラウザに保存された電子レシートはまだありません。'),
    ).toBeTruthy();
  });

  it('空のときは「すべて消去」ボタンを出さない', () => {
    render(<PayerReceiptList />);
    expect(screen.queryByRole('button', { name: 'すべて消去' })).toBeNull();
  });
});
