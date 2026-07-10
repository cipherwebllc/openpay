import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { HandleShareButton } from '@/components/HandleShareButton';

const useOriginMock = vi.fn(() => 'https://open-pay.test');

vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => useOriginMock(),
}));

describe('HandleShareButton', () => {
  const writeText = vi.fn<(value: string) => Promise<void>>();

  beforeEach(() => {
    useOriginMock.mockReturnValue('https://open-pay.test');
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('origin 確定前は共有ボタンを disabled にする', () => {
    useOriginMock.mockReturnValue('');
    renderWithIntl(<HandleShareButton handle="alice" />);
    expect(screen.getByRole('button', { name: '共有' })).toBeDisabled();
  });

  it('URL をコピーし、コピー済みフィードバックを表示する', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderWithIntl(<HandleShareButton handle="alice" />);

    await user.click(screen.getByRole('button', { name: '共有' }));
    await user.click(screen.getByRole('button', { name: 'URL をコピー' }));

    expect(writeText).toHaveBeenCalledWith('https://open-pay.test/@alice');
    expect(screen.getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
  });

  it('QR を表示し、X には name を含む共有 URL を渡す', async () => {
    const user = userEvent.setup();
    renderWithIntl(<HandleShareButton handle="alice" name="Alice" />, { locale: 'en' });

    await user.click(screen.getByRole('button', { name: 'Share' }));
    const x = screen.getByRole('link', { name: 'Share on X' });
    const href = x.getAttribute('href') ?? '';
    expect(href).toContain('twitter.com/intent/tweet');
    expect(href).toContain(encodeURIComponent('Share Alice (@alice)'));
    expect(href).toContain(encodeURIComponent('https://open-pay.test/@alice'));

    await user.click(screen.getByRole('button', { name: 'Show QR code' }));
    expect(screen.getByRole('dialog', { name: '@alice QR code' })).toBeInTheDocument();
    expect(screen.getByText('https://open-pay.test/@alice')).toBeInTheDocument();
  });

  it('navigator.share 非対応ではその他の共有を出さない', async () => {
    const user = userEvent.setup();
    renderWithIntl(<HandleShareButton handle="alice" />);

    await user.click(screen.getByRole('button', { name: '共有' }));
    expect(screen.queryByRole('button', { name: 'その他の共有…' })).not.toBeInTheDocument();
  });

  it('native share の AbortError はユーザー取消として握りつぶす', async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    renderWithIntl(<HandleShareButton handle="alice" />);

    await user.click(screen.getByRole('button', { name: '共有' }));
    await user.click(screen.getByRole('button', { name: 'その他の共有…' }));

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        title: '@alice をシェア',
        text: '@alice をシェア',
        url: 'https://open-pay.test/@alice',
      }),
    );
    expect(screen.getByRole('button', { name: 'その他の共有…' })).toBeInTheDocument();
  });

  it('night は明色系のボタンとポップオーバーを使う', async () => {
    const user = userEvent.setup();
    renderWithIntl(<HandleShareButton handle="alice" dark />);
    const trigger = screen.getByRole('button', { name: '共有' });
    expect(trigger.className).toContain('border-white/20');

    await user.click(trigger);
    expect(screen.getByText('URL をコピー').parentElement?.className).toContain(
      'bg-slate-900',
    );
  });
});
