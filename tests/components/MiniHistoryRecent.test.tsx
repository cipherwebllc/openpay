import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HistoryEntry } from '@/lib/history';

// useHistory を境界 mock。MiniHistoryRecent の rendering ロジック (slice(0,3) /
// 0 件 empty / 1+ 件 list + view-all link / hydrated guard) を verify する。
const useHistoryMock = vi.fn();
vi.mock('@/hooks/useHistory', () => ({
  useHistory: () => useHistoryMock(),
}));

import { MiniHistoryRecent } from '@/components/MiniHistoryRecent';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
    id: 'mini-' + Math.random(),
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000', // 1 JPYC (18 decimals)
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10000000000000000',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '12345',
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MiniHistoryRecent', () => {
  it('hydrated=false なら描画 skip (CLS placeholder のみ)', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: false });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.queryByText('最近の取引 (最新 3 件)')).toBeNull();
  });

  it('0 件 → empty 文言が出て view-all link は出ない', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: true });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText('最近の取引 (最新 3 件)')).toBeInTheDocument();
    expect(
      screen.getByText(/このブラウザにはまだ取引履歴がありません/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /全件を見る/ })).toBeNull();
  });

  it('1 件 → 行が描画されて view-all link が出る', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'e1' })],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/1 JPYC/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /全件を見る/ });
    expect(link).toHaveAttribute('href', '/ja/history');
  });

  it('4 件 → 最初の 3 件のみ表示 (slice(0,3))', () => {
    const entries = [
      entry({ id: 'e1', merchantAmount: '1000000000000000000' }), // 1
      entry({ id: 'e2', merchantAmount: '2000000000000000000' }), // 2
      entry({ id: 'e3', merchantAmount: '3000000000000000000' }), // 3
      entry({ id: 'e4', merchantAmount: '4000000000000000000' }), // 4
    ];
    useHistoryMock.mockReturnValue({ entries, hydrated: true });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/1 JPYC/)).toBeInTheDocument();
    expect(screen.getByText(/2 JPYC/)).toBeInTheDocument();
    expect(screen.getByText(/3 JPYC/)).toBeInTheDocument();
    expect(screen.queryByText(/4 JPYC/)).toBeNull();
  });

  it('USDC entry: 6 decimals で整形される', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'usdc-1',
          asset: 'usdc',
          chainId: 8453,
          chainSlug: 'base',
          merchantAmount: '12500000', // 12.5 USDC (6 decimals)
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/12\.5 USDC/)).toBeInTheDocument();
  });

  it('txHash 有り + 対応 chain → tx ↗ link が target=_blank で出る', () => {
    // vitest は NETWORK_ENV=testnet なので testnet chain (baseSepolia=84532) を使う
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'tx-1',
          txHash: `0x${'b'.repeat(64)}`,
          chainId: 84532,
          chainSlug: 'base',
          asset: 'usdc',
          merchantAmount: '5000000',
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    const tx = screen.getByRole('link', { name: /tx/ });
    expect(tx).toHaveAttribute('target', '_blank');
    expect(tx).toHaveAttribute('rel', 'noopener noreferrer');
    expect(tx.getAttribute('href')).toContain(`/tx/0x${'b'.repeat(64)}`);
  });

  it('txHash 無し → tx link は描画されない (view-all link だけ残る)', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'no-tx', txHash: null, chainId: 84532 })],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    // "tx" を含む link は 0 (view-all は "全件を見る")
    const txLinks = screen
      .queryAllByRole('link')
      .filter((el) => /\btx\b/.test(el.textContent ?? ''));
    expect(txLinks).toHaveLength(0);
  });

  it('en locale: view-all link href が /en/history、empty 文言が英語', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: true });
    renderWithIntl(<MiniHistoryRecent />, { locale: 'en' });
    expect(screen.getByText(/Recent transactions/)).toBeInTheDocument();
    expect(
      screen.getByText(/No transaction history in this browser yet/),
    ).toBeInTheDocument();
  });
});

describe('MiniHistoryRecent: standard-fee (OpenPay 利用手数料 tx) は除外', () => {
  // standard mode は merchant 送金 → OpenPay 利用手数料 の 2 つの entry を
  // append する。`appendHistory` は prepend なので順序は最新が fee 行。
  // mini 表示は「店主が受け取った金額」を伝える surface なので、fee 行は
  // 表示から除外する必要がある (Codex review 2026-05-28 指摘)。

  it('standard-fee + standard-merchant 並びで fee を除外、merchant のみ表示', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        // 最新 (prepend 後の order = [fee, merchant, ...])
        entry({
          id: 'fee-1',
          flow: 'standard-fee',
          merchantAmount: '5000', // 0.005 USDC (手数料)
          asset: 'usdc',
        }),
        entry({
          id: 'merch-1',
          flow: 'standard-merchant',
          merchantAmount: '1000000', // 1 USDC (sale)
          asset: 'usdc',
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    // 売上 1 USDC のみ表示、fee 0.005 USDC は除外
    expect(screen.getByText(/1 USDC/)).toBeInTheDocument();
    expect(screen.queryByText(/0\.005 USDC/)).toBeNull();
  });

  it('standard-fee が 3 件混じっても、merchant 系 3 件まで表示される', () => {
    // 「fee 行が slice の枠を埋める」regression のテスト。asset=usdc を全件に
    // 明示 (entry() helper の default は jpyc/18dec で、override しないと
    // merchantAmount=3000000 が 0.000000000003 JPYC として描画されてしまう)。
    useHistoryMock.mockReturnValue({
      entries: [
        entry({ id: 'fee-3', flow: 'standard-fee', asset: 'usdc', merchantAmount: '5000' }),
        entry({ id: 'merch-3', flow: 'standard-merchant', asset: 'usdc', merchantAmount: '3000000' }),
        entry({ id: 'fee-2', flow: 'standard-fee', asset: 'usdc', merchantAmount: '5000' }),
        entry({ id: 'merch-2', flow: 'standard-merchant', asset: 'usdc', merchantAmount: '2000000' }),
        entry({ id: 'fee-1', flow: 'standard-fee', asset: 'usdc', merchantAmount: '5000' }),
        entry({ id: 'merch-1', flow: 'standard-merchant', asset: 'usdc', merchantAmount: '1000000' }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    // 3 件の merchant 売上が全部表示
    expect(screen.getByText(/3 USDC/)).toBeInTheDocument();
    expect(screen.getByText(/2 USDC/)).toBeInTheDocument();
    expect(screen.getByText(/1 USDC/)).toBeInTheDocument();
    // fee 行 (0.005 USDC) は 1 件も出ない
    expect(screen.queryByText(/0\.005 USDC/)).toBeNull();
  });

  it('batch / direct flow は除外されない (gasless は fee が batch に同梱なので 1 entry)', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({ id: 'batch-1', flow: 'batch', merchantAmount: '500000000000000000000' }),
        entry({ id: 'direct-1', flow: 'direct', merchantAmount: '300000000000000000000' }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/500 JPYC/)).toBeInTheDocument();
    expect(screen.getByText(/300 JPYC/)).toBeInTheDocument();
  });
});

describe('MiniHistoryRecent: status 別ドット色 + a11y label', () => {
  it('success entry → 緑 (bg-emerald-500) + aria-label "成功"', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 's1', status: 'success' })],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container.querySelector('.bg-emerald-500')).not.toBeNull();
    expect(screen.getByLabelText('成功')).toBeInTheDocument();
  });

  it('reverted entry → 琥珀 (bg-amber-500) + aria-label "revert"', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'r1', status: 'reverted' })],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container.querySelector('.bg-amber-500')).not.toBeNull();
    expect(screen.getByLabelText('revert')).toBeInTheDocument();
  });

  it('error entry → 赤 (bg-red-500) + aria-label "エラー"', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'e1', status: 'error' })],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container.querySelector('.bg-red-500')).not.toBeNull();
    expect(screen.getByLabelText('エラー')).toBeInTheDocument();
  });

  it('混在 3 entries (success/reverted/error) → ドット 3 色すべて存在', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({ id: 's', status: 'success' }),
        entry({ id: 'r', status: 'reverted' }),
        entry({ id: 'e', status: 'error' }),
      ],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container.querySelector('.bg-emerald-500')).not.toBeNull();
    expect(container.querySelector('.bg-amber-500')).not.toBeNull();
    expect(container.querySelector('.bg-red-500')).not.toBeNull();
  });
});

describe('MiniHistoryRecent: chain 表示の境界', () => {
  it('chainId が未対応 (testnet で未登録 chain) → chain 名は表記から省かれる', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'unknown-chain',
          chainId: 99999, // supportedChains に無い
        }),
      ],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    // " · ChainName" が出ない (chainName=undefined branch)
    expect(container.textContent ?? '').not.toMatch(/ · [A-Z]/);
  });

  it('chainId 対応 → "datetime · chain名" 形式で chain 名が出る', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'base-sepolia',
          chainId: 84532,
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    // testnet では Base Sepolia
    expect(screen.getByText(/· Base Sepolia/)).toBeInTheDocument();
  });
});

describe('MiniHistoryRecent: amount 整形の境界', () => {
  it('小数を含む JPYC (1.234567...) → formatUnits の文字列をそのまま表示', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'frac',
          asset: 'jpyc',
          merchantAmount: '1234567890000000000', // 1.23456789 JPYC
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/1\.23456789 JPYC/)).toBeInTheDocument();
  });

  it('巨大な金額 (10億 JPYC = 1e9 × 1e18 wei) → 精度欠落なし', () => {
    // 1_000_000_000 JPYC = 1e9 * 1e18 wei = 1e27 wei (>2^53、Number 表現不可)。
    // formatUnits は string 経由なので BigInt 精度を維持する。
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'huge',
          asset: 'jpyc',
          merchantAmount: '1' + '0'.repeat(27), // 1e27
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText('1000000000 JPYC')).toBeInTheDocument();
  });

  it('数値でない merchantAmount (壊れた entry) → raw 文字列を fallback で出す', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'broken',
          merchantAmount: 'NaN-or-garbage',
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText('NaN-or-garbage')).toBeInTheDocument();
  });
});
