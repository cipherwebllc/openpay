import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('next/navigation', () => ({ useSearchParams: vi.fn() }));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0xUser1234567890123456789012345678901234', isConnected: true, chainId: 137 })),
  useReadContract: vi.fn(() => ({ data: undefined })),
  useSwitchChain: vi.fn(() => ({ switchChain: vi.fn(), isPending: false })),
  useConnect: vi.fn(() => ({ connectors: [], connect: vi.fn(), isPending: false, error: null })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn(() => ({ data: null, error: null })) }));
vi.mock('@/hooks/useBatchPayment', () => ({
  useBatchPayment: vi.fn(() => ({ data: undefined, error: null, isPending: false, mutate: vi.fn() })),
}));
vi.mock('@/hooks/useStandardPayment', () => ({
  useStandardPayment: vi.fn(() => ({ data: undefined, error: null, isPending: false, phase: null, isFeeError: false, isMerchantError: false, mutate: vi.fn(), retryFee: vi.fn() })),
}));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({
  useJpycEip3009Payment: vi.fn(() => ({ data: undefined, error: null, isPending: false, mutate: vi.fn(), variables: undefined })),
}));
vi.mock('@/lib/jpycGaslessProvider', () => ({
  resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay' as const),
}));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/relay/recoverFee', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/recoverFee')>('@/lib/relay/recoverFee');
  return { ...actual, recoverFeeValue: vi.fn(() => 2n * 10n ** 18n), recoverFeeBps: vi.fn(() => 0) };
});
vi.mock('@/hooks/useGasQuote', () => ({ useGasQuote: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/components/CrossChainHint', () => ({ CrossChainHint: () => null }));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(() => 'sponsorship') };
});
vi.mock('@/hooks/useErc20BalanceAndChain', () => ({
  useErc20BalanceAndChain: vi.fn(() => ({ balance: 10000n * 10n ** 18n, insufficientBalance: false, wrongChain: false })),
}));
vi.mock('@/hooks/usePaymentHistory', () => ({ usePaymentHistory: vi.fn() }));
vi.mock('@/hooks/useRelayGaslessSnapshot', () => ({ useRelayGaslessSnapshot: vi.fn(() => ({ data: undefined, error: null, isPending: false })) }));
vi.mock('@/lib/successChime', () => ({ primeChimeAudio: vi.fn() }));

// B1 Layer B: relayer 健全性プローブ。useRelayHealth は useQuery を使うため、QueryClientProvider
// を張らない本テストでは hook ごとモックして既定 non-degraded を返す (preflight banner 非表示)。
vi.mock('@/hooks/useRelayHealth', () => ({
  useRelayHealth: vi.fn(() => ({ degraded: false })),
}));
import { PaymentForm } from '@/components/PaymentForm';
import { useSearchParams } from 'next/navigation';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue, recoverFeeBps } from '@/lib/relay/recoverFee';

const MOCK_FORWARDER = '0x1234567890123456789012345678901234567890' as `0x${string}`;

function setupSearch(params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  vi.mocked(useSearchParams).mockReturnValue(sp as unknown as ReturnType<typeof useSearchParams>);
}

describe('PaymentForm recover fee disclosure', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'customer',
      mode: 'gasless',
    });
  });

  it('FREE mode: no fee disclosure', () => {
    render(<PaymentForm />);
    expect(screen.queryByText(/決済手数料/)).toBeNull();
  });

  it('RECOVER mode, bps=0: shows gas-only disclosure', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    render(<PaymentForm />);
    // L6: 数字の前後を境界で締める (`: ` 直後 + 後続 `（`) — 「12 JPYC（」「20 JPYC（」が
    // 部分一致で誤って通らないよう、数字の手前を `:\s*`、直後を非数字 (` J`) と `（` で固定。
    expect(
      screen.getByText(/決済手数料:\s*2 JPYC（ガス相当）/),
    ).toBeInTheDocument();
    // 反証フェンス: 末尾の数字違い (12/20) では一致しないことを明示。
    expect(screen.queryByText(/決済手数料:\s*12 JPYC/)).toBeNull();
    expect(screen.queryByText(/決済手数料:\s*20 JPYC/)).toBeNull();
  });

  it('RECOVER mode, bps=100: shows % disclosure', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    vi.mocked(recoverFeeBps).mockReturnValue(100);
    vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n);
    render(<PaymentForm />);
    // L6: `10 JPYC` の前後を締める (`:\s*` + 後続 `（決済額の1%`)。`110`/`100` の bleed を防ぐ。
    expect(
      screen.getByText(/決済手数料:\s*10 JPYC（決済額の1%/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/決済手数料:\s*110 JPYC/)).toBeNull();
  });

  // 確定モデル (2026-06-13): JPYC recover は URL の gas=customer を無視し merchant 固定。
  // 旧 QR (gas=customer) を読んでも開示は merchant 分担行 (店舗負担) になる。
  it('RECOVER mode: URL gas=customer は無視され merchant 分担行 (店舗負担) を表示', () => {
    // setupSearch (beforeEach) が gas=customer を入れているが、recover では merchant に倒れる。
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    render(<PaymentForm />);
    expect(screen.getByText(/手数料は店舗負担/)).toBeInTheDocument();
    expect(screen.queryByText(/手数料はお客様負担/)).toBeNull();
  });

  it('RECOVER mode, URL gas=merchant: そのまま merchant 分担行 (店舗負担) を表示', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'merchant',
      mode: 'gasless',
    });
    render(<PaymentForm />);
    expect(screen.getByText(/手数料は店舗負担/)).toBeInTheDocument();
  });

  it('RECOVER mode, gasMode=merchant, amount<=fee: shows tooSmall warning (F2)', () => {
    // merchant 吸収で金額が手数料 (floor 2 JPYC) 以下 → 負の受取額を出さず受付不可警告。
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1',
      gas: 'merchant',
      mode: 'gasless',
    });
    render(<PaymentForm />);
    // 分担行 (店舗受取) は出さず、手数料以下の受付不可警告を表示。
    expect(
      screen.getByText(/この金額では受け付けられません/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/手数料は店舗負担/)).toBeNull();
  });
});

// CDX-3: 会計サマリ (breakdown) の「ネットワーク手数料見積」行 (= relayGasEquiv) が、実スケジュール
// recoverFeeValue(amountWei, 'merchant') を反映することを確認する。旧実装はフラットなフロア
// (relayGasFeeValue) を表示していたため bps>0 で実 settle 額と乖離していた。
// bps=0 では floor (2 JPYC) になり従来挙動と完全一致 (behavior-neutral today)。
describe('PaymentForm recover 会計サマリ手数料行 = recoverFeeValue (CDX-3)', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'customer', // recover は merchant に倒れる
      mode: 'gasless',
    });
  });

  function gasRowValue(): string | null {
    // 「ネットワーク手数料見積 (店主負担)」の dt の sibling dd を読む。
    const dt = screen.getByText('ネットワーク手数料見積 (店主負担)');
    return dt.parentElement?.querySelector('dd')?.textContent ?? null;
  }

  it('bps=0: 会計サマリ手数料行 = floor 2 JPYC (recoverFeeValue 出力)', () => {
    vi.mocked(recoverFeeBps).mockReturnValue(0);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    render(<PaymentForm />);
    expect(gasRowValue()).toMatch(/2 JPYC/);
    // floor を確認するため recoverFeeValue が amount(1000) と merchant で呼ばれたこと。
    expect(vi.mocked(recoverFeeValue)).toHaveBeenCalledWith(
      1000n * 10n ** 18n,
      'merchant',
    );
  });

  it('bps=100: 会計サマリ手数料行 = recoverFeeValue 出力 (1% = 10 JPYC)・フロア固定でない', () => {
    vi.mocked(recoverFeeBps).mockReturnValue(100);
    vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n); // 1% of 1000
    render(<PaymentForm />);
    // 旧実装 (relayGasFeeValue フロア固定) なら 2 JPYC で乖離。実スケジュールなら 10 JPYC。
    expect(gasRowValue()).toMatch(/10 JPYC/);
    expect(gasRowValue()).not.toMatch(/^2 JPYC$/);
    expect(vi.mocked(recoverFeeValue)).toHaveBeenCalledWith(
      1000n * 10n ** 18n,
      'merchant',
    );
  });
});

describe('PaymentForm sign reassurance panel (P4 recover)', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'customer',
      mode: 'gasless',
    });
  });

  // 確定モデル (2026-06-13): /pay の JPYC recover は merchant 固定 (URL gas=customer を無視)。
  // merchant 吸収ではウォレット表示 = 表示価格 (1000) で、手数料は受取から内枠吸収される。
  it('RECOVER (merchant 固定): 安心パネルはウォレット表示 = 表示額 1000 ちょうど (内訳上乗せ無し)', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    render(<PaymentForm />);
    // merchant モードのバッジ: 動かせるのは 1000 JPYC ちょうど (お支払い + 手数料 の上乗せ表記は出ない)。
    expect(
      screen.getByText(/動かせるのは 1000 JPYC ちょうど/),
    ).toBeInTheDocument();
    // customer 内訳 (お支払い X + 手数料 Y) は merchant では出ない。
    expect(screen.queryByText(/＋ 手数料|\+ 手数料 2）/)).toBeNull();
  });

  it('FREE: 旧 free パネル (内訳なしの金額固定バッジ) のまま・recover 文言は出ない', () => {
    // forwarder=null (testnet 等) は free 経路。recover の内訳バッジは出さない。
    render(<PaymentForm />);
    expect(
      screen.getByText(/動かせるのは 1000 JPYC ちょうど/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/お支払い 1000 \+ 手数料 2/)).toBeNull();
  });
});

// 確定モデル (2026-06-13): /pay の JPYC recover は URL gas=customer を無視し、relay.mutate へ
// gasMode='merchant' を渡す (送信 payload レベルの検証)。
describe('PaymentForm recover: relay.mutate gasMode=merchant (URL gas=customer を無視)', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
    // 旧 QR を模す: URL は gas=customer。
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'customer',
      mode: 'gasless',
    });
  });

  it('Pay 押下 → relay.mutate に gasMode=merchant が渡る (customer ではない)', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const mutate = vi.fn();
    const { useJpycEip3009Payment } = await import(
      '@/hooks/useJpycEip3009Payment'
    );
    vi.mocked(useJpycEip3009Payment).mockReturnValue({
      data: undefined,
      error: null,
      isPending: false,
      mutate,
      variables: undefined,
    } as unknown as ReturnType<typeof useJpycEip3009Payment>);

    const user = userEvent.setup();
    render(<PaymentForm />);
    // 接続済 (wagmi mock) なので Pay ボタンが活性。amount は URL 固定 1000。
    const payBtn = screen.getByRole('button', { name: /1000 JPYC/ });
    await user.click(payBtn);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ gasMode: 'merchant', value: 1000n * 10n ** 18n }),
    );
  });
});
