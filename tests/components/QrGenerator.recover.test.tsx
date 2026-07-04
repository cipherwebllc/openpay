import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
  // QrGenerator は useIncomingPaymentWatch 経由で着金監視に useReadContract を呼ぶ。
  // この recover テストは QueryClientProvider を張らないため、wagmi 自体をモックして
  // 残高クエリを undefined 固定 (= 監視中) にしておく (着金ヒントは本テストの対象外)。
  useReadContract: vi.fn(() => ({ data: undefined })),
}));
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => 'https://test.local',
}));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: vi.fn(() => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false, isError: false, refetch: vi.fn(),
  })),
}));

// resolveJpycGaslessProvider = eip3009-relay (recover path)
vi.mock('@/lib/jpycGaslessProvider', () => ({
  resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay' as const),
}));

// forwarderConfig: controlled per test
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>(
    '@/lib/relay/forwarderConfig',
  );
  return {
    ...actual,
    jpycForwarderFor: vi.fn(() => null),
    relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
  };
});

// recoverFee: controlled per test
vi.mock('@/lib/relay/recoverFee', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/recoverFee')>(
    '@/lib/relay/recoverFee',
  );
  return {
    ...actual,
    recoverFeeValue: vi.fn((amount: bigint) => 2n * 10n ** 18n),
    recoverFeeBps: vi.fn(() => 0),
  };
});

import { QrGenerator } from '@/components/QrGenerator';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue, recoverFeeBps } from '@/lib/relay/recoverFee';

const MOCK_FORWARDER = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const VALID_RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function fillAmount(user: ReturnType<typeof userEvent.setup>, amount: string) {
  const input = screen.getByPlaceholderText('1000');
  await user.clear(input);
  await user.type(input, amount);
}

async function openStep2(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.queryByRole('button', { name: /受取先/ });
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
    await user.click(toggle);
  }
}

describe('QrGenerator recover fee disclosure', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
  });

  it('FREE mode (forwarder null): no fee disclosure shown', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    expect(screen.queryByText(/決済手数料/)).toBeNull();
  });

  it('RECOVER mode, bps=0: shows "2 JPYC（ガス相当）" disclosure', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    // L6: 数字の前後を境界で締める (`:\s*` 直後 + 後続 `（`) — 「12 JPYC（」等の部分一致を排除。
    expect(
      screen.getByText(/決済手数料:\s*2 JPYC（ガス相当）/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/決済手数料:\s*12 JPYC/)).toBeNull();
    expect(screen.queryByText(/決済手数料:\s*20 JPYC/)).toBeNull();
  });

  it('RECOVER mode, bps=100: shows % form disclosure (merchant 固定)', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    vi.mocked(recoverFeeBps).mockReturnValue(100);
    vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n); // 1% of 1000 = 10
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    // % form: "決済手数料: 10 JPYC（決済額の1%・最低2 JPYC）" (merchant スケジュール)
    // L6: `10 JPYC` の前後を締める (`:\s*` + 後続 `（決済額の1%`)。`110`/`100` の bleed を防ぐ。
    expect(
      screen.getByText(/決済手数料:\s*10 JPYC（決済額の1%/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/決済手数料:\s*110 JPYC/)).toBeNull();
  });

  // 確定モデル (2026-06-13): JPYC recover は店舗負担固定。開示は merchant 分担行を出す。
  it('RECOVER mode: shows merchant split label (店舗負担固定・お客様上乗せ表記なし)', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    // JPYC recover は merchant 固定 → 「手数料は店舗負担」。customer 負担表記は出ない。
    expect(screen.getByText(/手数料は店舗負担/)).toBeInTheDocument();
    expect(screen.queryByText(/手数料はお客様負担/)).toBeNull();
  });
});

// 確定モデル (2026-06-13): JPYC recover は per-QR の負担者トグルを撤去し merchant 固定。
// URL params も gas=merchant に焼き込む。USDC はトグルを従来どおり出す (回帰防止)。
describe('QrGenerator gas-bearer toggle (確定モデル: JPYC recover は merchant 固定)', () => {
  beforeEach(() => {
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
  });

  async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
    const adv = screen.getByText('高度な設定');
    await user.click(adv);
  }

  it('JPYC recover: gas 負担者トグルも固定ヒントも出ない (開示は payModeGaslessDesc が担う)', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    await openAdvanced(user);
    // 負担者トグル (顧客が gas 相当額を上乗せ / 店主が gas 相当額を吸収) は描画されない。
    expect(screen.queryByText('顧客が gas 相当額を上乗せ')).toBeNull();
    expect(screen.queryByText('店主が gas 相当額を吸収')).toBeNull();
    // 固定ヒントは 2026-07 に撤去 (利用料開示は payModeGaslessDesc に一本化)。
    expect(screen.queryByText(/は店舗負担。お客様は表示額のみ/)).toBeNull();
    // 開示そのものは gasless モード説明に残っている。
    expect(screen.getByText(/OpenPay 利用料 1%・最低 2 JPYC/)).toBeInTheDocument();
  });

  it('JPYC recover: 生成 URL に gas=merchant が焼き込まれる', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    // QR を全画面モーダルで開き、URL コピー対象 (payUrl) に gas=merchant が乗ることを確認。
    const showBtn = screen.getAllByRole('button', { name: /QR/ })[0];
    await user.click(showBtn);
    // モーダルの QR value はリンクの href / コピー対象に現れる。gas=merchant を含む。
    const bodyText = document.body.innerHTML;
    expect(bodyText).toMatch(/gas=merchant/);
    expect(bodyText).not.toMatch(/gas=customer/);
  });

  it('USDC (非 JPYC recover): gas 負担者トグルは従来どおり出る (回帰防止)', async () => {
    // USDC は forwarder と無関係にトグルを出す。jpycForwarderFor が non-null でも USDC では
    // isJpycRecover=false (token!=='jpyc') なのでトグルが出る。
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    // token を USDC に切替 (TokenChooser)。
    const usdcBtn = screen.getByRole('button', { name: /USDC/i });
    await user.click(usdcBtn);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    // USDC は placeholder '10.00'。
    const amountInput = screen.getByPlaceholderText('10.00');
    await user.clear(amountInput);
    await user.type(amountInput, '10');
    await openAdvanced(user);
    // USDC は負担者トグルが描画される。
    expect(screen.getByText('顧客が gas 相当額を上乗せ')).toBeInTheDocument();
    expect(screen.getByText('店主が gas 相当額を吸収')).toBeInTheDocument();
  });
});
