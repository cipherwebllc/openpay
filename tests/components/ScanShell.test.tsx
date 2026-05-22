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

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));
import { useAccount, useConnect, useDisconnect } from 'wagmi';

// useOrigin は jsdom の window.location.origin (= https://test.local) を実 hook
// で読む経路と意味的に等価な値を default で返す mock を提供。test ごとに値を
// 切替えたい (pre-hydrate race の '' 再現) ため variable 経由 mock を採用 —
// ESM namespace の vi.spyOn は read-only 制約で動かないため。
let scanShellOrigin = 'https://test.local';
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => scanShellOrigin,
}));

// logger は ScanShell が breadcrumb 用に呼ぶ。実 logger は console + Sentry へ
// 副作用するため境界 mock し、kind 別の呼出を直接 assert する。
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
import { logger } from '@/lib/logger';

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

const ORIGIN = 'https://test.local'; // jsdom default URL とアラインさせる
const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR_OTHER = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function mockConnected(
  connected: boolean,
  opts: { chain?: { name: string } | null } = {},
) {
  if (connected) {
    // chain: undefined をテストで明示的に指定したい場合 chain: null を渡す。
    // (JS の default 引数は undefined のみ吸収されるため、no-chain の signal は null)。
    const chain = opts.chain === null ? undefined : opts.chain ?? { name: 'Base Sepolia' };
    mockHook(useAccount, {
      isConnected: true,
      address: ADDR,
      chain,
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
  vi.mocked(logger.info).mockReset();
  vi.mocked(logger.warn).mockReset();
  scanShellOrigin = 'https://test.local';
  // matchMedia stub — PwaInstallHint が usePwaDisplayMode を呼ぶ
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true, // standalone 扱いにして hint を隠す (テスト focus を ScanShell 本体に絞る)
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

async function startCamera() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
  await waitFor(() => expect(ctorCalls.length).toBe(1));
}

function decode(data: string) {
  act(() => {
    ctorCalls[0].onDecode({ data });
  });
}

describe('ScanShell: 接続状態表示', () => {
  it('未接続 → connectionPreHint と ConnectButton を表示', () => {
    mockConnected(false);
    renderWithIntl(<ScanShell />);
    expect(screen.getByText(/あらかじめウォレットを接続/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
  });

  it('接続済み → shortAddress + chain 名 + ready hint + 切断ボタンを表示', () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    expect(screen.getByText(/接続済みです/)).toBeInTheDocument();
    expect(screen.getByText(/Base Sepolia/)).toBeInTheDocument();
    expect(screen.getByText(/0x52d4…cA81/)).toBeInTheDocument();
    // 切断ボタンが badge の隣に出ること (UX: 別 wallet に切替できる)
    expect(screen.getByRole('button', { name: '切断' })).toBeInTheDocument();
  });

  it('接続済みで chain が undefined → chain 名は描画されず address のみ表示', () => {
    // useAccount は wallet 接続直後に chain が立つまで undefined を返し得る (wagmi 仕様)。
    mockConnected(true, { chain: null });
    renderWithIntl(<ScanShell />);
    expect(screen.getByText(/0x52d4…cA81/)).toBeInTheDocument();
    // "/ <chain>" の slash 区切りが描画されないこと
    expect(screen.queryByText(/\/ Base Sepolia/)).toBeNull();
    // chain が立っていなくても切断ボタンは出る (再接続でやり直す動線確保)
    expect(screen.getByRole('button', { name: '切断' })).toBeInTheDocument();
  });

  it('接続済み → 切断ボタン click で useDisconnect.disconnect() が呼ばれる', () => {
    // mockConnected(true) は useDisconnect の disconnect を vi.fn() で設定するため、
    // ここでは事前に取り出した disconnect spy を mockHook 経由で差し替えてから render。
    const disconnectSpy = vi.fn();
    mockConnected(true);
    mockHook(useDisconnect, { disconnect: disconnectSpy });
    renderWithIntl(<ScanShell />);
    fireEvent.click(screen.getByRole('button', { name: '切断' }));
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('en locale: 接続済み → 切断ボタンの label が "Disconnect"', () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});

describe('ScanShell: decode → router.push + logger.info', () => {
  it('同 origin /pay URL → router.push(/ja/pay?…) + logger.info("scan.deeplink", kind:pay)', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode(`${ORIGIN}/pay?to=${ADDR}&token=usdc&amount=10`);
    expect(push).toHaveBeenCalledWith(
      `/ja/pay?to=${ADDR}&token=usdc&amount=10`,
    );
    expect(logger.info).toHaveBeenCalledWith('scan.deeplink', { kind: 'pay' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('同 origin /tip URL → push + logger.info kind:tip', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode(`${ORIGIN}/tip/${ADDR}?token=jpyc`);
    expect(push).toHaveBeenCalledWith(`/ja/tip/${ADDR}?token=jpyc`);
    expect(logger.info).toHaveBeenCalledWith('scan.deeplink', { kind: 'tip' });
  });

  it('同 origin /checkout URL → push + logger.info kind:checkout', async () => {
    mockConnected(true);
    const items = encodeURIComponent('Coffee') + ':2:5.00';
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode(`${ORIGIN}/checkout?to=${ADDR}&token=usdc&items=${items}`);
    expect(push).toHaveBeenCalledWith(
      `/ja/checkout?to=${ADDR}&token=usdc&items=${items}`,
    );
    expect(logger.info).toHaveBeenCalledWith('scan.deeplink', {
      kind: 'checkout',
    });
  });
});

describe('ScanShell: decode → 警告系 banner + logger.warn', () => {
  it('外部 origin URL → 警告 banner + 新タブリンク + logger.warn("scan.external_qr", host:…)', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode(`https://attacker.example.com/pay?to=${ADDR_OTHER}`);
    expect(push).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('scan.external_qr', {
      host: 'attacker.example.com',
    });
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

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(
      screen.queryByText('OpenPay 以外の URL が読まれました'),
    ).toBeNull();
  });

  it('ethereum: URL → EIP-681 banner + logger.warn("scan.eip681_rejected")', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode('ethereum:0xabc@1');
    expect(push).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('scan.eip681_rejected');
    expect(
      screen.getByText(/ethereum: URL は現在 OpenPay 内で扱えません/),
    ).toBeInTheDocument();
  });

  it('未知 QR → unknown banner + logger.warn("scan.unrecognized_qr") + raw 表示', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode('RANDOM-STRING-123');
    expect(push).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('scan.unrecognized_qr');
    expect(screen.getByText('RANDOM-STRING-123')).toBeInTheDocument();
    expect(
      screen.getByText('QR の内容を判別できませんでした'),
    ).toBeInTheDocument();
  });

  it('同 origin だが to 欠落の /pay → unknown banner (LARP 防御)', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode(`${ORIGIN}/pay?token=usdc`);
    expect(push).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('scan.unrecognized_qr');
    expect(
      screen.getByText('QR の内容を判別できませんでした'),
    ).toBeInTheDocument();
  });
});

describe('ScanShell: origin pre-hydrate (空) ガード', () => {
  it('useOrigin が空文字 → 早期 return + logger.warn("scan.before_hydrate") 観測点を残す', async () => {
    scanShellOrigin = '';
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    const raw = `${ORIGIN}/pay?to=${ADDR}&token=usdc&amount=10`;
    decode(raw);
    expect(push).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    // silent drop でなく warn が出ること (Sentry breadcrumb 確保)
    expect(logger.warn).toHaveBeenCalledWith('scan.before_hydrate', {
      rawLength: raw.length,
    });
  });
});

describe('ScanShell: 連続 scan のシナリオ', () => {
  it('external → 閉じる → /pay (success) の連続でも state が正しく入替わる', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();

    // 1: 外部 origin
    decode(`https://attacker.example.com/pay?to=${ADDR_OTHER}`);
    expect(
      screen.getByText('OpenPay 以外の URL が読まれました'),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    // dismiss → banner 消える
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(
      screen.queryByText('OpenPay 以外の URL が読まれました'),
    ).toBeNull();

    // 2: 同 origin の正常 /pay (decode は同 callback を再利用、stopOnDecode で
    // scanner は idle に戻るが onDecode 参照自体は ScanShell 側の closure に残っている)
    decode(`${ORIGIN}/pay?to=${ADDR}&token=usdc&amount=7`);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(`/ja/pay?to=${ADDR}&token=usdc&amount=7`);
    expect(logger.info).toHaveBeenCalledWith('scan.deeplink', { kind: 'pay' });
    expect(logger.warn).toHaveBeenCalledTimes(1); // 1 回目の external のみ
  });

  it('unknown → unknown の連続 — banner が更新され、raw が新しい値になる', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();

    decode('FIRST-INVALID');
    expect(screen.getByText('FIRST-INVALID')).toBeInTheDocument();

    decode('SECOND-INVALID');
    expect(screen.queryByText('FIRST-INVALID')).toBeNull();
    expect(screen.getByText('SECOND-INVALID')).toBeInTheDocument();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('eip681 → 閉じる で banner 消える', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    await startCamera();
    decode('ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1');
    expect(
      screen.getByText(/ethereum: URL は現在 OpenPay 内で扱えません/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(
      screen.queryByText(/ethereum: URL は現在 OpenPay 内で扱えません/),
    ).toBeNull();
  });
});

describe('ScanShell: 手入力 fallback', () => {
  it('URL 手入力 → 「この URL で進む」で同等経路 (router.push)', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    const input = screen.getByLabelText(
      'OpenPay の URL (https://open-pay.jp/pay?…)',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: `${ORIGIN}/pay?to=${ADDR}&token=usdc` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'この URL で進む' }));
    expect(push).toHaveBeenCalledWith(`/ja/pay?to=${ADDR}&token=usdc`);
    expect(logger.info).toHaveBeenCalledWith('scan.deeplink', { kind: 'pay' });
  });

  it('手入力 fallback でも origin 空ならガード (router.push 無し + warn 観測)', async () => {
    scanShellOrigin = '';
    mockConnected(true);
    renderWithIntl(<ScanShell />);
    const input = screen.getByLabelText(
      'OpenPay の URL (https://open-pay.jp/pay?…)',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: `${ORIGIN}/pay?to=${ADDR}&token=usdc` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'この URL で進む' }));
    expect(push).not.toHaveBeenCalled();
  });
});

describe('ScanShell: en locale でも href が /en/... になる', () => {
  it('useLocale=en → /en/pay へ push', async () => {
    mockConnected(true);
    renderWithIntl(<ScanShell />, { locale: 'en' });
    const input = screen.getByLabelText(/OpenPay URL/) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: `${ORIGIN}/pay?to=${ADDR}&token=usdc` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this URL' }));
    expect(push).toHaveBeenCalledWith(`/en/pay?to=${ADDR}&token=usdc`);
  });
});
