import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';

// qr-scanner を境界 mock。useQrScanner test と同じ shape を再利用。
type CtorArgs = {
  video: HTMLVideoElement;
  onDecode: (r: { data: string }) => void;
  options: Record<string, unknown>;
};
const ctorCalls: CtorArgs[] = [];
const startMock = vi.fn<() => Promise<void>>();
const stopMock = vi.fn();
const destroyMock = vi.fn();
const hasCameraMock = vi.fn<() => Promise<boolean>>();

class MockQrScanner {
  static hasCamera = hasCameraMock;
  constructor(
    video: HTMLVideoElement,
    onDecode: (r: { data: string }) => void,
    options: Record<string, unknown>,
  ) {
    ctorCalls.push({ video, onDecode, options });
  }
  start = startMock;
  stop = stopMock;
  destroy = destroyMock;
}
vi.mock('qr-scanner', () => ({ default: MockQrScanner }));

import { QrScannerSurface } from '@/components/QrScannerSurface';

beforeEach(() => {
  ctorCalls.length = 0;
  startMock.mockReset().mockResolvedValue(undefined);
  stopMock.mockReset();
  destroyMock.mockReset();
  hasCameraMock.mockReset().mockResolvedValue(true);
});

describe('QrScannerSurface', () => {
  it('初期 (idle) は「カメラを起動」ボタン + URL 貼付 fallback を畳んで表示', () => {
    renderWithIntl(<QrScannerSurface onScanned={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'カメラを起動' }),
    ).toBeInTheDocument();
    // details は閉じた状態
    const details = screen.getByText('URL を貼り付けて続行').closest('details');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
  });

  it('カメラ起動ボタンクリック → scanning 状態 + qr-scanner ctor が environment 設定で呼ばれる', async () => {
    const user = userEvent.setup();
    renderWithIntl(<QrScannerSurface onScanned={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    expect(ctorCalls[0].options).toMatchObject({
      preferredCamera: 'environment',
      highlightScanRegion: true,
    });
  });

  it('decode 成功 → onScanned に raw data が渡る', async () => {
    const onScanned = vi.fn();
    const user = userEvent.setup();
    renderWithIntl(<QrScannerSurface onScanned={onScanned} />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() => expect(ctorCalls.length).toBe(1));
    act(() => {
      ctorCalls[0].onDecode({ data: 'https://open-pay.jp/pay?to=0x' });
    });
    expect(onScanned).toHaveBeenCalledWith('https://open-pay.jp/pay?to=0x');
  });

  it('permission-denied → 案内テキスト + fallback details が自動 open', async () => {
    startMock.mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError'),
    );
    const user = userEvent.setup();
    renderWithIntl(<QrScannerSurface onScanned={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() =>
      expect(screen.getByText('カメラの許可が必要です')).toBeInTheDocument(),
    );
    const details = screen.getByText('URL を貼り付けて続行').closest('details');
    expect(details!.hasAttribute('open')).toBe(true);
  });

  it('no-camera → 案内テキスト + fallback details が自動 open', async () => {
    hasCameraMock.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    renderWithIntl(<QrScannerSurface onScanned={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() =>
      expect(
        screen.getByText('この端末にカメラが見つかりません'),
      ).toBeInTheDocument(),
    );
  });

  it('未知 DOMException → generic error message を表示 (error.message を fontmono で見せる)', async () => {
    startMock.mockRejectedValueOnce(new DOMException('boom', 'AbortError'));
    const user = userEvent.setup();
    renderWithIntl(<QrScannerSurface onScanned={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'カメラを起動' }));
    await waitFor(() =>
      expect(
        screen.getByText('カメラを起動できませんでした'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('URL 手入力 fallback → 「この URL で進む」で onScanned 呼出 (trim される)', () => {
    const onScanned = vi.fn();
    renderWithIntl(<QrScannerSurface onScanned={onScanned} />);
    const input = screen.getByLabelText(
      'OpenPay の URL (https://open-pay.jp/pay?…)',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: '  https://open-pay.jp/pay?to=0x  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'この URL で進む' }));
    expect(onScanned).toHaveBeenCalledWith('https://open-pay.jp/pay?to=0x');
  });

  it('URL 空のとき「この URL で進む」は disabled', () => {
    renderWithIntl(<QrScannerSurface onScanned={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'この URL で進む' }),
    ).toBeDisabled();
  });

  it('Paste ボタン → clipboard.readText の結果が input に反映', async () => {
    const onScanned = vi.fn();
    // navigator.clipboard を mock
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        readText: vi
          .fn()
          .mockResolvedValue('https://open-pay.jp/pay?to=0xCAFE'),
      },
      configurable: true,
    });
    renderWithIntl(<QrScannerSurface onScanned={onScanned} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'クリップボードから貼り付け' }),
      );
      // microtask 1 周分 (readText の resolve)
      await Promise.resolve();
    });
    const input = screen.getByLabelText(
      'OpenPay の URL (https://open-pay.jp/pay?…)',
    ) as HTMLInputElement;
    expect(input.value).toBe('https://open-pay.jp/pay?to=0xCAFE');
  });
});
