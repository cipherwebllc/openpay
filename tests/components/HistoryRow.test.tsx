import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { HistoryRow } from '@/components/HistoryRow';
import type { HistoryEntry } from '@/lib/history';

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER = '0x1234567890abcdef1234567890abcdef12345678';
const TX = `0x${'a'.repeat(64)}`;

// vitest.config: NEXT_PUBLIC_NETWORK_ENV=testnet → supportedChains は sepolia 系。
// chainId は polygonAmoy.id (80002) を使う (testnet env で Explorer URL が解決される)。
const POLYGON_AMOY_ID = 80002;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
    id: 'row-test',
    ts: new Date(2026, 4, 17, 9, 5, 3).getTime(),
    flow: 'batch',
    status: 'success',
    chainId: POLYGON_AMOY_ID,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: MERCHANT,
    merchantAmount: '1000000000000000000000', // 1000 JPYC
    customer: CUSTOMER,
    feeReceiver: '0xFee',
    feeAmount: '10000000000000000000', // 10 JPYC
    txHash: TX,
    userOpHash: '0xUO',
    blockNumber: '12345',
    errorMessage: null,
    storeName: 'Cafe X',
    note: 'order-42',
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

describe('HistoryRow', () => {
  it('success entry: 主要情報 + Explorer link + 削除 button が表示される', () => {
    render(<HistoryRow entry={entry()} onRemove={() => undefined} />);
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText(/バッチ送金/)).toBeInTheDocument();
    expect(screen.getByText(/1000 JPYC/)).toBeInTheDocument();
    expect(screen.getByText('2026-05-17 09:05:03')).toBeInTheDocument();
    expect(screen.getByText('order-42')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Explorer/ }),
    ).toHaveAttribute('href', expect.stringContaining(`/tx/${TX}`));
    expect(
      screen.getByRole('link', { name: /Explorer/ }),
    ).toHaveAttribute('target', '_blank');
    expect(
      screen.getByRole('button', { name: 'この行を削除' }),
    ).toBeInTheDocument();
  });

  it('成功 badge は emerald 色クラス', () => {
    render(<HistoryRow entry={entry({ status: 'success' })} onRemove={() => undefined} />);
    expect(screen.getByText('成功').className).toMatch(/emerald/);
  });

  it('reverted badge は amber 色クラス', () => {
    render(<HistoryRow entry={entry({ status: 'reverted' })} onRemove={() => undefined} />);
    expect(screen.getByText('revert').className).toMatch(/amber/);
  });

  it('error badge は red 色クラス + errorMessage を出す', () => {
    render(
      <HistoryRow
        entry={entry({
          status: 'error',
          errorMessage: 'gas underpriced',
          txHash: null,
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('エラー').className).toMatch(/red/);
    expect(screen.getByText(/gas underpriced/)).toBeInTheDocument();
  });

  it('txHash null → Explorer link は描画しない', () => {
    render(
      <HistoryRow
        entry={entry({ txHash: null, status: 'error' })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.queryByRole('link', { name: /Explorer/ })).toBeNull();
  });

  it('merchant link は address Explorer ページを指す', () => {
    render(<HistoryRow entry={entry()} onRemove={() => undefined} />);
    const links = screen.getAllByRole('link');
    const merchantLink = links.find((l) =>
      l.getAttribute('href')?.includes(`/address/${MERCHANT}`),
    );
    expect(merchantLink).toBeDefined();
  });

  it('USDC entry: 6 decimals で decode + USDC symbol', () => {
    render(
      <HistoryRow
        entry={entry({
          asset: 'usdc',
          merchantAmount: '1000000', // 1 USDC
          feeAmount: '5000', // 0.005 USDC
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText(/1 USDC/)).toBeInTheDocument();
    expect(screen.getByText(/0.005 USDC/)).toBeInTheDocument();
  });

  it('standard mode + gasMode=null → "—" 表示', () => {
    render(
      <HistoryRow
        entry={entry({ payMode: 'standard', gasMode: null })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText(/通常決済 \(ガスあり\) · —/)).toBeInTheDocument();
  });

  it('legacy(内訳不明) gasless で feeAmount>0 は「ネットワーク手数料相当額」表示 (旧 band-aid)', () => {
    // migrated v2 entry: 分離記録が無く feeAmount に gas が混在。feeBreakdownVersion=0 で
    // legacy 判定され、gasless かつ feeAmount>0 を網手数料相当額として表示する。
    render(
      <HistoryRow
        entry={entry({
          payMode: 'gasless',
          feeAmount: '4000000000000000000',
          networkFeeEquivalent: null,
          feeBreakdownVersion: 0,
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('ネットワーク手数料相当額')).toBeInTheDocument();
    expect(screen.queryByText('OpenPay 利用手数料')).toBeNull();
  });

  it('native v3 gasless: 利用手数料 0 は非表示・networkFeeEquivalent を網手数料相当額で表示', () => {
    render(
      <HistoryRow
        entry={entry({
          payMode: 'gasless',
          feeAmount: '0',
          networkFeeEquivalent: '4000000000000000000', // 4 JPYC
          feeBreakdownVersion: 1,
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('ネットワーク手数料相当額')).toBeInTheDocument();
    expect(screen.getByText(/4 JPYC/)).toBeInTheDocument();
    expect(screen.queryByText('OpenPay 利用手数料')).toBeNull();
  });

  it('利用手数料 0 は行ごと非表示 (決済額非連動・0 を明記しない)', () => {
    render(
      <HistoryRow
        entry={entry({ payMode: 'standard', gasMode: null, feeAmount: '0' })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.queryByText('OpenPay 利用手数料')).toBeNull();
    expect(screen.queryByText('ネットワーク手数料相当額')).toBeNull();
  });

  it('売上総額が着金額と異なるとき (gas=merchant) は売上総額を明示', () => {
    render(
      <HistoryRow
        entry={entry({
          payMode: 'gasless',
          gasMode: 'merchant',
          merchantAmount: '996000000000000000000', // 着金 996 JPYC
          saleAmount: '1000000000000000000000', // 売上総額 1000 JPYC
          networkFeeEquivalent: '4000000000000000000',
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('売上総額')).toBeInTheDocument();
    expect(screen.getByText(/1000 JPYC/)).toBeInTheDocument();
  });

  it('削除 button → confirm true で onRemove(id) が呼ばれる', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<HistoryRow entry={entry({ id: 'go' })} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'この行を削除' }));
    expect(onRemove).toHaveBeenCalledWith('go');
  });

  it('削除 button → confirm false で onRemove は呼ばれない', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<HistoryRow entry={entry()} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'この行を削除' }));
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('customer null → customer dt は描画されない', () => {
    render(
      <HistoryRow entry={entry({ customer: null })} onRemove={() => undefined} />,
    );
    expect(screen.queryByText('顧客')).toBeNull();
  });

  it('circle unreconciled: 未照合 badge (amber) を表示', () => {
    render(
      <HistoryRow
        entry={entry({
          provider: 'circle',
          asset: 'usdc',
          circlePaymasterNetUsdc: null,
          circleVerification: 'unreconciled',
        })}
        onRemove={() => undefined}
      />,
    );
    const badge = screen.getByText('未照合');
    expect(badge.className).toMatch(/amber/);
  });

  it('circle client-reported: 自己申告 badge + net USDC 値を表示', () => {
    render(
      <HistoryRow
        entry={entry({
          provider: 'circle',
          asset: 'usdc',
          circlePaymasterNetUsdc: '9384', // 0.009384 USDC
          circleVerification: 'client-reported',
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('自己申告')).toBeInTheDocument();
    expect(screen.getByText(/0.009384 USDC/)).toBeInTheDocument();
  });

  it('circleVerification null → badge は描画されない', () => {
    render(
      <HistoryRow
        entry={entry({
          provider: 'circle',
          asset: 'usdc',
          circlePaymasterNetUsdc: '9384',
          circleVerification: null,
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.queryByText('自己申告')).toBeNull();
    expect(screen.queryByText('未照合')).toBeNull();
  });

  it('anchor (FX換算) 行: 元の円価格 ≈ 受領額 + レートを表示', () => {
    render(
      <HistoryRow
        entry={entry({
          asset: 'usdc',
          merchantAmount: '6400000', // 6.4 USDC 受領
          anchorAmount: '1000',
          anchorSymbol: 'jpyc',
          fxRateUsdcJpy: '156.32',
        })}
        onRemove={() => undefined}
      />,
    );
    expect(
      screen.getByText((t) => t.includes('1000 JPYC') && t.includes('6.4 USDC')),
    ).toBeInTheDocument();
    expect(screen.getByText(/レート.*156\.32/)).toBeInTheDocument();
  });

  it('anchor 無し → anchor 行は描画されない', () => {
    render(
      <HistoryRow
        entry={entry({ anchorAmount: null, anchorSymbol: null })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.queryByText(/≈/)).toBeNull();
  });

  it('v5: 商品名/税率税区分/税額/管理番号/会計メモ/明細 を表示 (JPYC 税額は exact)', () => {
    render(
      <HistoryRow
        entry={entry({
          asset: 'jpyc',
          merchantAmount: '1100000000000000000000', // 1100 JPYC 税込 → 内税 100
          productName: 'コーヒー',
          memo: 'イベント販売',
          taxRate: 10,
          taxCategory: 'taxable_10',
          receiptNo: 'R-20260615-001',
          lineItems: [
            {
              name: 'コーヒー',
              quantity: 2,
              unitPrice: '550',
              amount: '1100',
              taxRate: 10,
              taxCategory: 'taxable_10',
              memo: null,
            },
          ],
        })}
        onRemove={() => undefined}
      />,
    );
    // 商品名は subtitle と明細の双方に出る
    expect(screen.getAllByText(/コーヒー/).length).toBeGreaterThan(0);
    expect(screen.getByText('R-20260615-001')).toBeInTheDocument();
    expect(screen.getByText('イベント販売')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument(); // 明細行の税率
    expect(screen.getByText('100 JPYC')).toBeInTheDocument(); // 税額 (token 単位・内税)
  });

  it('v5: 複数明細は「代表名 + ほかN点」で要約表示', () => {
    render(
      <HistoryRow
        entry={entry({
          asset: 'jpyc',
          merchantAmount: '4000000000000000000000',
          lineItems: [
            { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
            { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
          ],
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('ほか1点')).toBeInTheDocument(); // 代表名(コーヒー) + ほか1点
    // 明細は両行とも展開表示される
    expect(screen.getAllByText(/Tシャツ/).length).toBeGreaterThan(0);
  });

  it('v5: メタ未設定の entry は記帳補助行を出さない (後方互換)', () => {
    render(<HistoryRow entry={entry()} onRemove={() => undefined} />);
    expect(screen.queryByText('管理番号')).toBeNull();
    expect(screen.queryByText('売上明細')).toBeNull();
    expect(screen.queryByText(/約 .* 円/)).toBeNull();
  });

  it('v5: USDC は税額を token 単位で表示 (JPY へ強制変換しない)', () => {
    render(
      <HistoryRow
        entry={entry({
          asset: 'usdc',
          merchantAmount: '6400000', // 6.4 USDC 税込@10% → 内税 0.58 USDC
          anchorAmount: null,
          taxRate: 10,
          taxCategory: 'taxable_10',
        })}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText('0.58 USDC')).toBeInTheDocument(); // token 単位の内税
    expect(screen.queryByText(/円/)).toBeNull(); // JPY へ変換しない
  });
});
