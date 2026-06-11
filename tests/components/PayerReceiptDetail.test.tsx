import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { PayerReceiptDetail } from '@/components/PayerReceiptDetail';

// downloadBlob は DOM (<a download> + ObjectURL) に副作用するため境界 mock し、
// 渡された Blob の実内容 / ファイル名を検査する (実出力検証・コードパスは実物)。
vi.mock('@/lib/download', () => ({
  downloadBlob: vi.fn(),
  triggerDownload: vi.fn(),
}));

import { downloadBlob } from '@/lib/download';
import {
  buildPayerReceipt,
  payerReceiptCopyText,
  payerReceiptCsv,
  payerReceiptToJson,
  type PayerReceipt,
} from '@/lib/payerReceipt';

const NOW = new Date('2026-06-04T01:42:00.000Z');
const TX = `0x${'a'.repeat(64)}`;
const POLYGON_AMOY_ID = 80002;

// jsdom の Blob には .text() が無いため FileReader で実内容を読み出す。
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

function receipt(over: Partial<Parameters<typeof buildPayerReceipt>[0]> = {}): PayerReceipt {
  return buildPayerReceipt(
    {
      txHash: TX,
      chainId: POLYGON_AMOY_ID,
      asset: 'jpyc',
      amount: '4000',
      merchantAddress: '0xMerchantWallet',
      merchantName: 'OpenPay Cafe',
      payerAddress: '0xPayerWallet',
      receiptNo: 'OP-20260604-001',
      lineItems: [
        { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '90', memo: null },
        { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '272', memo: null },
      ],
      subtotalAmount: '4000',
      totalTaxAmount: '362',
      totalAmount: '4000',
      ...over,
    },
    NOW,
  );
}

describe('PayerReceiptDetail', () => {
  it('明細・合計・店舗/顧客・txHash・免責を表示', () => {
    render(<PayerReceiptDetail receipt={receipt()} />);
    expect(screen.getByText('OpenPay 電子レシート')).toBeTruthy();
    expect(screen.getByText('OP-20260604-001')).toBeTruthy();
    expect(screen.getByText('コーヒー')).toBeTruthy();
    expect(screen.getByText('Tシャツ')).toBeTruthy();
    // 単価/行合計表示
    expect(screen.getByText(/@500 = 1000 JPYC/)).toBeTruthy();
    // txHash 全体
    expect(screen.getByText(TX)).toBeTruthy();
    // 免責 (正式領収書ではない)
    expect(screen.getByText(/正式な領収書/)).toBeTruthy();
  });

  it('合計欄に小計/消費税/合計を出す', () => {
    render(<PayerReceiptDetail receipt={receipt()} />);
    expect(screen.getByText('小計')).toBeTruthy();
    expect(screen.getByText('消費税')).toBeTruthy();
    expect(screen.getByText('合計')).toBeTruthy();
    expect(screen.getByText('362 JPYC')).toBeTruthy();
  });

  it('Explorer リンクは txHash を含む URL', () => {
    render(<PayerReceiptDetail receipt={receipt()} />);
    const link = screen.getByRole('link', {
      name: /エクスプローラー/,
    }) as HTMLAnchorElement;
    expect(link.href).toContain(TX);
  });

  it('印刷 / JSON / CSV のアクションボタンがある', () => {
    render(<PayerReceiptDetail receipt={receipt()} />);
    expect(screen.getByRole('button', { name: '印刷' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'JSON を保存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CSV を保存' })).toBeTruthy();
  });

  it('onRemove 未指定 (完了画面) → 削除ボタンは出ない', () => {
    render(<PayerReceiptDetail receipt={receipt()} />);
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
  });

  it('onRemove 指定 (一覧管理) → 削除ボタンが receiptId で呼ぶ', () => {
    const onRemove = vi.fn();
    const r = receipt();
    render(<PayerReceiptDetail receipt={r} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(onRemove).toHaveBeenCalledWith(r.receiptId);
  });

  it('lineItems 無し (単純送金) → 仮想 1 行で店舗名を商品行に表示', () => {
    const r = buildPayerReceipt(
      { asset: 'usdc', amount: '12.5', merchantAddress: '0xM', merchantName: 'Shop X', txHash: '0xt', chainId: POLYGON_AMOY_ID },
      NOW,
    );
    render(<PayerReceiptDetail receipt={r} />);
    // 仮想 1 行の name = merchantName。明細ブロック内に出る。
    const items = screen.getAllByText('Shop X');
    expect(items.length).toBeGreaterThan(0);
    expect(screen.getByText(/@12.5 = 12.5 USDC/)).toBeTruthy();
  });

  it('pending (txHash 無し) → status バッジは確認待ち・Explorer リンク無し', () => {
    const r = buildPayerReceipt(
      { asset: 'jpyc', amount: '1000', merchantAddress: '0xM', userOpHash: '0xUO', chainId: POLYGON_AMOY_ID, status: 'pending' },
      NOW,
    );
    render(<PayerReceiptDetail receipt={r} />);
    expect(screen.getByText('確認待ち')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /エクスプローラー/ })).toBeNull();
  });

  it('税額 0 → 小計/消費税行を出さず合計のみ', () => {
    const r = buildPayerReceipt(
      { asset: 'jpyc', amount: '500', merchantAddress: '0xM', txHash: '0xt', chainId: POLYGON_AMOY_ID },
      NOW,
    );
    render(<PayerReceiptDetail receipt={r} />);
    expect(screen.queryByText('小計')).toBeNull();
    expect(screen.queryByText('消費税')).toBeNull();
    expect(screen.getByText('合計')).toBeTruthy();
  });

  it('異通貨建て → 元価格 (anchor) 行 + レートを表示', () => {
    const r = buildPayerReceipt(
      {
        asset: 'usdc',
        amount: '6.4',
        totalAmount: '6.4',
        merchantAddress: '0xM',
        txHash: '0xt',
        chainId: POLYGON_AMOY_ID,
        anchorAmount: '1000',
        anchorSymbol: 'JPYC',
        fxRate: '155.5',
      },
      NOW,
    );
    render(<PayerReceiptDetail receipt={r} />);
    expect(screen.getByText('元の価格 (請求建て)')).toBeTruthy();
    // PaymentForm.fxAnchorLine: "{refAmt} {anchorSymbol} ≈ {amount} {symbol}"
    expect(screen.getByText(/1000 JPYC ≈ 6\.4 USDC/)).toBeTruthy();
    expect(screen.getByText(/1 USDC = 155\.5/)).toBeTruthy();
  });

  it('通常決済 (anchor 無し) → 元価格行は出ない', () => {
    const r = buildPayerReceipt(
      { asset: 'jpyc', amount: '1000', merchantAddress: '0xM', txHash: '0xt', chainId: POLYGON_AMOY_ID },
      NOW,
    );
    render(<PayerReceiptDetail receipt={r} />);
    expect(screen.queryByText('元の価格 (請求建て)')).toBeNull();
  });

  it('memo を表示', () => {
    const r = buildPayerReceipt(
      { asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xt', chainId: POLYGON_AMOY_ID, memo: 'イベント物販' },
      NOW,
    );
    render(<PayerReceiptDetail receipt={r} />);
    expect(screen.getByText('イベント物販')).toBeTruthy();
  });

  it('payer wallet: chainId あり → Explorer リンク / chainId 無し → プレーン表示', () => {
    const withChain = render(
      <PayerReceiptDetail
        receipt={buildPayerReceipt(
          { asset: 'jpyc', amount: '1', merchantAddress: '0xM', payerAddress: '0xPAYER', txHash: '0xt', chainId: POLYGON_AMOY_ID },
          NOW,
        )}
      />,
    );
    const payerLink = Array.from(
      withChain.container.querySelectorAll('a'),
    ).find((a) => a.getAttribute('href')?.includes('/address/0xPAYER'));
    expect(payerLink).toBeTruthy();
    withChain.unmount();

    const noChain = render(
      <PayerReceiptDetail
        receipt={buildPayerReceipt(
          { asset: 'jpyc', amount: '1', merchantAddress: '0xM', payerAddress: '0xPAYER', txHash: '0xt' },
          NOW,
        )}
      />,
    );
    const noLink = Array.from(noChain.container.querySelectorAll('a')).find((a) =>
      a.getAttribute('href')?.includes('/address/0xPAYER'),
    );
    expect(noLink).toBeUndefined();
  });
});

describe('PayerReceiptDetail — アクションボタン (実コードパス)', () => {
  beforeEach(() => {
    vi.mocked(downloadBlob).mockClear();
  });
  afterEach(() => {
    document.body.classList.remove('openpay-printing-receipt');
  });

  function r(): PayerReceipt {
    return buildPayerReceipt(
      {
        txHash: TX,
        chainId: POLYGON_AMOY_ID,
        asset: 'jpyc',
        amount: '4000',
        merchantAddress: '0xMerchantWallet',
        merchantName: 'OpenPay Cafe',
        receiptNo: 'OP-1',
        lineItems: [
          { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', taxAmount: '90', memo: null },
        ],
        totalTaxAmount: '90',
      },
      NOW,
    );
  }

  it('コピー: navigator.clipboard.writeText に copyText 全文を渡す', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const receipt = r();
    render(<PayerReceiptDetail receipt={receipt} />);
    fireEvent.click(screen.getByRole('button', { name: 'レシートをコピー' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(payerReceiptCopyText(receipt, 'ja'));
  });

  it('clipboard 非対応環境 → コピーボタン非表示 (graceful degrade)', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<PayerReceiptDetail receipt={r()} />);
    expect(screen.queryByRole('button', { name: 'レシートをコピー' })).toBeNull();
    // 他のアクションは出る
    expect(screen.getByRole('button', { name: '印刷' })).toBeTruthy();
  });

  // 注: 検証範囲は handlePrint の JS 契約 (window.print 呼出 / body class /
  // data-receipt-printing 付与 / afterprint 後始末) のみ。globals.css の @media print
  // による「対象 1 枚だけ残す」視覚的分離は jsdom がレイアウトを評価しないため自動検証
  // 不可 — その効果は手動 (実ブラウザの印刷プレビュー) 確認に依存する。
  it('印刷: window.print を呼び body class / data 属性を立て、afterprint で解除', () => {
    const print = vi.fn();
    window.print = print;
    const { container } = render(<PayerReceiptDetail receipt={r()} />);
    fireEvent.click(screen.getByRole('button', { name: '印刷' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('openpay-printing-receipt')).toBe(true);
    expect(container.querySelector('[data-receipt-printing]')).toBeTruthy();
    // 印刷完了 (afterprint) で後始末
    fireEvent(window, new Event('afterprint'));
    expect(document.body.classList.contains('openpay-printing-receipt')).toBe(false);
    expect(container.querySelector('[data-receipt-printing]')).toBeNull();
  });

  it('afterprint 不発でも次回印刷時に残留マーカーを掃除し対象を 1 件に保つ', () => {
    window.print = vi.fn();
    // 別レシート 2 件を別コンテナに描画。
    const a = render(<PayerReceiptDetail receipt={r()} />);
    const b = render(
      <PayerReceiptDetail
        receipt={buildPayerReceipt(
          { txHash: '0xother', chainId: POLYGON_AMOY_ID, asset: 'jpyc', amount: '1', merchantAddress: '0xM' },
          NOW,
        )}
      />,
    );
    // A を印刷 (afterprint は発火させない = マーカー残留)。
    fireEvent.click(within(a.container).getByRole('button', { name: '印刷' }));
    expect(document.querySelectorAll('[data-receipt-printing]')).toHaveLength(1);
    // B を印刷 → A の残留を掃除し、紙面に出るのは B のみ (1 件)。
    fireEvent.click(within(b.container).getByRole('button', { name: '印刷' }));
    const marked = document.querySelectorAll('[data-receipt-printing]');
    expect(marked).toHaveLength(1);
    expect(b.container.querySelector('[data-receipt-printing]')).toBeTruthy();
    expect(a.container.querySelector('[data-receipt-printing]')).toBeNull();
    fireEvent(window, new Event('afterprint'));
  });

  it('JSON 保存: downloadBlob に JSON 全文 + .json ファイル名を渡す', async () => {
    const receipt = r();
    render(<PayerReceiptDetail receipt={receipt} />);
    fireEvent.click(screen.getByRole('button', { name: 'JSON を保存' }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toMatch(/^openpay-receipt-OP-1\.json$/);
    expect(blob).toBeInstanceOf(Blob);
    expect(await readBlobText(blob as Blob)).toBe(payerReceiptToJson(receipt));
  });

  it('CSV 保存: downloadBlob に CSV 全文 (BOM 付き) + .csv ファイル名を渡す', async () => {
    const receipt = r();
    render(<PayerReceiptDetail receipt={receipt} />);
    fireEvent.click(screen.getByRole('button', { name: 'CSV を保存' }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toMatch(/\.csv$/);
    // FileReader.readAsText は decode 時に先頭 BOM を消費するため、BOM を除いた本体で比較
    // (Blob のバイト列自体は payerReceiptCsv の BOM を保持している)。
    const text = await readBlobText(blob as Blob);
    const stripBom = (s: string) => s.replace(/^﻿/, '');
    expect(stripBom(text)).toBe(stripBom(payerReceiptCsv(receipt)));
    expect(text).toContain('コーヒー');
  });
});

describe('PayerReceiptDetail — 成長ループ CTA', () => {
  function baseReceipt(): PayerReceipt {
    return buildPayerReceipt(
      {
        txHash: TX,
        chainId: POLYGON_AMOY_ID,
        asset: 'jpyc',
        amount: '1000',
        merchantAddress: '0xMerchantWallet',
        merchantName: 'OpenPay Cafe',
      },
      NOW,
    );
  }

  it('onRemove なし (完了画面) → CTA テキストとリンクが描画される', () => {
    render(<PayerReceiptDetail receipt={baseReceipt()} />);
    expect(screen.getByText('このお店は OpenPay で受け取っています。')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'あなたも無料でお店を開く →' })).toBeTruthy();
  });

  it('onRemove なし → CTA リンクの href が /{locale} (例: /ja) を指す', () => {
    render(<PayerReceiptDetail receipt={baseReceipt()} />);
    const link = screen.getByRole('link', { name: 'あなたも無料でお店を開く →' }) as HTMLAnchorElement;
    // renderWithIntl はデフォルト locale=ja でレンダリングする
    expect(link.getAttribute('href')).toBe('/ja');
  });

  it('onRemove あり (管理一覧) → CTA は描画されない (一覧での繰り返し表示を避ける)', () => {
    render(<PayerReceiptDetail receipt={baseReceipt()} onRemove={() => {}} />);
    expect(screen.queryByText('このお店は OpenPay で受け取っています。')).toBeNull();
    expect(screen.queryByRole('link', { name: 'あなたも無料でお店を開く →' })).toBeNull();
  });
});
