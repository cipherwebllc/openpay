import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MiniHistoryRecent', () => {
  it('hydrated=false なら何も描画しない', () => {
    useHistoryMock.mockReturnValue({ entries: [entry({ id: 'e1' })], hydrated: false });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container).toBeEmptyDOMElement();
  });

  it('0 件 → カードごと出さない (空の状態で会計画面を長くしない)', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: true });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container).toBeEmptyDOMElement();
  });

  it('利用手数料の行だけ → 売上が無いので出さない', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'f1', flow: 'standard-fee' })],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    expect(container).toBeEmptyDOMElement();
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

  it('en locale: 見出しが英語・view-all link href が /en/history', () => {
    useHistoryMock.mockReturnValue({ entries: [entry({ id: 'e1' })], hydrated: true });
    renderWithIntl(<MiniHistoryRecent />, { locale: 'en' });
    expect(screen.getByText(/Recent transactions/)).toBeInTheDocument();
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/en/history')).toBe(true);
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

// D2: 状態は色の点だけでなく文字でも出す (色覚に頼らない・読み上げにも乗る)。点は飾り (aria-hidden)。
// 成功以外は「受け取った」と読める緑の ↓ にしない。
describe('MiniHistoryRecent: 状態の文字ラベル + 色の点', () => {
  it.each([
    ['success', '成功', 'bg-emerald-500'],
    ['reverted', '差し戻し', 'bg-amber-500'],
    ['error', 'エラー', 'bg-red-500'],
    ['pending', '確認待ち', 'bg-sky-500'],
  ] as const)('%s → 文字「%s」を行の中に出し、点 (%s) は読み上げない', (status, label, dotClass) => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: status, status })],
      hydrated: true,
    });
    const { container } = renderWithIntl(<MiniHistoryRecent />);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText(label)).toBeVisible();
    const dot = container.querySelector(`.${dotClass}`);
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).not.toHaveAttribute('aria-label');
  });

  it('成功は緑の ↓・成功以外は灰色の ↓ (受け取ったように見せない)', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({ id: 's', status: 'success', merchantAmount: '1000000000000000000' }),
        entry({ id: 'e', status: 'error', merchantAmount: '2000000000000000000' }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    const [okRow, errorRow] = screen.getAllByRole('listitem');
    expect(okRow.querySelector('svg.text-emerald-600')).not.toBeNull();
    expect(errorRow.querySelector('svg.text-emerald-600')).toBeNull();
    expect(errorRow.querySelector('svg.text-slate-400')).not.toBeNull();
  });

  it('en: 状態の文字も英語 (History の状態ラベルを再利用)', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'p', status: 'pending' })],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />, { locale: 'en' });
    expect(within(screen.getByRole('listitem')).getByText('Pending')).toBeVisible();
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
