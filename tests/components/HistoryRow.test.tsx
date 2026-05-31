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
});
