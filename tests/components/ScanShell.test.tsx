import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';

// next/navigation の router を mock — push 呼出を assert する。
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/ja/scan',
}));

// wagmi: useAccount のみ使う (ConnectButton 経由で useConnect/useDisconnect も
// 必要なため一緒に mock する)。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));
import { useAccount, useConnect, useDisconnect } from 'wagmi';

// useOrigin は jsdom の location.origin を返すため通常は実コードで OK だが、
// hydrate の確実性を上げるため値を pin する。
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => 'https://open-pay.jp',
}));

// qr-scanner mock (decode を ScanShell まで通すための shape)
const ctorCalls: { onDecode: (r: { data: string }) => void }[] = [];
const startMock = vi.fn().mockResolvedValue(undefined);
class MockQrScanner {
  static hasCamera = vi.fn().mockResolvedValue(true);
  constructor(_v: HTMLVideoElement, onDecode: (r: { data: string }) => void) {
    ctorCalls.push({ onDecode });
  }
  start = startMock;
  stop = vi.fn();
  destroy = vi.fn();
}
vi.mock('qr-scanner', () => ({ default: MockQrScanner }));

import { ScanShell } from '@/components/ScanShell';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR_OTHER = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function mockConnected(connected: boolean) {
  if (connected) {
    mockHook(useAccount, {
      isConnected: true,
      address: ADDR,
      chain: { name: 'Base Sepolia' },
    });
  } else {
    mockHook(useAccount, { isConnected: false, address: undefined });
  }
  mockHook(useConnect, {
    connectors: [{ uid: '1', name: 'MetaMask' }],
    connect: vi.fn(),
    isPending: false,
    error: null,
  });
  mockHook(useDisconnect, { disconnect: vi.fn() });
}

beforeEach(() => {
  push.mockReset();
  ctorCalls.length = 0;
  startMock.mockClear().mockResolvedValue(undefined);
  // matchMedia stub — PwaInstallHint が usePwaDisplayMode を呼ぶ
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true, // standalone 扱いにして hint を隠す (テスト focus を ScanShell 本体に絞る)
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

describe('ScanShell: 接続状態表示', () => {
  it('未接続 → connectionPreHint と ConnectButton を表示', () => {
    mockConnected(false);
    renderWithIntl(<ScanShell />);
    expect(screen.getByText(/あらかじめウォレットを接続/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
  });

  it('接続済み → shortAddress + chain 名 + ready hint を表示', () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    expect(screen.getByText(/接続済みです/)).toBeInTheDocument();
    expect(screen.getByText(/Base Sepolia/)).toBeInTheDocument();
    // shortAddress は先頭 6 桁 + ellipsis(U+2026) + 末尾 4 桁
    expect(screen.getByText(/0x52d4…cA81/)).toBeInTheDocument();
  });
});

describe('ScanShell: decode → router.push', () => {
  it('同 origin /pay URL → router.push(/ja/pay?…)', async () => {
    mockConnected(true);
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({
        data: `https://open-pay.jp/pay?to=${ADDR}&token=usdc&amount=10`,
      });
    });
    expect(push).toHaveBeenCalledWith(
      `/ja/pay?to=${ADDR}&token=usdc&amount=10`,
    );
  });

  it('同 origin /tip URL → router.push(/ja/tip/0x...?…)', async () => {
    mockConnected(true);
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({
        data: `https://open-pay.jp/tip/${ADDR}?token=jpyc`,
      });
    });
    expect(push).toHaveBeenCalledWith(`/ja/tip/${ADDR}?token=jpyc`);
  });

  it('同 origin /checkout URL → router.push(/ja/checkout?…)', async () => {
    mockConnected(true);
    const items = encodeURIComponent('Coffee') + ':2:5.00';
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({
        data: `https://open-pay.jp/checkout?to=${ADDR}&token=usdc&items=${items}`,
      });
    });
    expect(push).toHaveBeenCalledWith(
      `/ja/checkout?to=${ADDR}&token=usdc&items=${items}`,
    );
  });
});

describe('ScanShell: decode → 警告系 banner', () => {
  it('外部 origin URL → 警告 banner + 新タブリンク + dismiss ボタン (router.push しない)', async () => {
    mockConnected(true);
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({
        data: `https://attacker.example.com/pay?to=${ADDR_OTHER}`,
      });
    });
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByText('OpenPay 以外の URL が読まれました'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '新しいタブで開く' });
    expect(link).toHaveAttribute(
      'href',
      `https://attacker.example.com/pay?to=${ADDR_OTHER}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // dismiss で banner が消える
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(
      screen.queryByText('OpenPay 以外の URL が読まれました'),
    ).toBeNull();
  });

  it('ethereum: URL → EIP-681 banner を表示 + router.push しない', async () => {
    mockConnected(true);
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({ data: 'ethereum:0xabc@1' });
    });
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByText(/ethereum: URL は現在 OpenPay 内で扱えません/),
    ).toBeInTheDocument();
  });

  it('未知 QR → unknown banner で raw を表示', async () => {
    mockConnected(true);
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({ data: 'RANDOM-STRING-123' });
    });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText('RANDOM-STRING-123')).toBeInTheDocument();
    expect(
      screen.getByText('QR の内容を判別できませんでした'),
    ).toBeInTheDocument();
  });

  it('同 origin だが to 欠落の /pay URL → unknown banner (LARP 防御)', async () => {
    mockConnected(true);
    const user = userEvent.setup();
    renderWithIntl(<ScanShell />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({
        data: 'https://open-pay.jp/pay?token=usdc',
      });
    });
    expect(push).not.toHaveBeenCalled();
    expect(
      screen.getByText('QR の内容を判別できませんでした'),
    ).toBeInTheDocument();
  });
});

describe('ScanShell: 手入力 fallback', () => {
  it('URL 手入力 → 「この URL で進む」で同等経路 (router.push) が動く', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    const input = screen.getByLabelText(
      'OpenPay の URL (https://open-pay.jp/pay?…)',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: `https://open-pay.jp/pay?to=${ADDR}&token=usdc` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'この URL で進む' }));
    expect(push).toHaveBeenCalledWith(`/ja/pay?to=${ADDR}&token=usdc`);
  });
});

describe('ScanShell: en locale でも href が /en/... になる', () => {
  it('useLocale=en → /en/pay へ push', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />, { locale: 'en' });
    const input = screen.getByLabelText(
      /OpenPay URL/,
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: `https://open-pay.jp/pay?to=${ADDR}&token=usdc` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this URL' }));
    expect(push).toHaveBeenCalledWith(`/en/pay?to=${ADDR}&token=usdc`);
  });
});
