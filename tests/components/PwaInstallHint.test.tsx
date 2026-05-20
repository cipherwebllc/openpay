import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import ja from '@/messages/ja.json';

// PwaInstallHint は usePwaDisplayMode に depend するため matchMedia を都度 stub する。
type Listener = (e: { matches: boolean }) => void;
function setupMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  });
}

function setIOSDocumentTouch() {
  // ipad UA detect 用に ontouchend を document に生やす。
  Object.defineProperty(document, 'ontouchend', {
    value: null,
    configurable: true,
  });
}

function unsetIOSDocumentTouch() {
  delete (document as unknown as Record<string, unknown>).ontouchend;
}

function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="ja" messages={ja}>
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  unsetIOSDocumentTouch();
});

describe('PwaInstallHint', () => {
  it('standalone モードでは何も描画しない', async () => {
    setupMatchMedia(true);
    setUserAgent('Mozilla/5.0 (iPhone)');
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    const { container } = render(withIntl(<PwaInstallHint />));
    expect(container).toBeEmptyDOMElement();
  });

  it('iOS UA → Safari 手順 (3 step) と共有メニュー誘導文を描画', async () => {
    setupMatchMedia(false);
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)');
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    render(withIntl(<PwaInstallHint />));
    expect(screen.getByText(/共有メニュー/)).toBeInTheDocument();
    // step 2 (li 要素のみに完全一致) と title (h-like) の両方が "ホーム画面に追加"
    // を含むので、step 2 だけを取って fence する。
    expect(
      screen.getByText('「ホーム画面に追加」を選択'),
    ).toBeInTheDocument();
    expect(screen.getByText(/アイコンタップだけで/)).toBeInTheDocument();
  });

  it('iPad (Macintosh UA + ontouchend) も iOS 扱い', async () => {
    setupMatchMedia(false);
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    );
    setIOSDocumentTouch();
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    render(withIntl(<PwaInstallHint />));
    expect(screen.getByText(/Safari の共有メニュー/)).toBeInTheDocument();
  });

  it('Android UA → manual hint (deferredPrompt 無いとき)', async () => {
    setupMatchMedia(false);
    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129',
    );
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    render(withIntl(<PwaInstallHint />));
    expect(screen.getByText(/Chrome のメニュー/)).toBeInTheDocument();
    // ボタンは deferredPrompt が無いので出ない
    expect(
      screen.queryByRole('button', { name: 'ホーム画面にインストール' }),
    ).toBeNull();
  });

  it('Android + beforeinstallprompt event → install ボタンが出る、クリックで prompt 呼出 → 受諾で hint 消える', async () => {
    setupMatchMedia(false);
    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129',
    );
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    const { container } = render(withIntl(<PwaInstallHint />));

    const prompt = vi.fn().mockResolvedValue(undefined);
    const userChoice = Promise.resolve({ outcome: 'accepted' as const });
    const ev = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice,
      preventDefault: vi.fn(),
    });
    await act(async () => {
      window.dispatchEvent(ev);
    });

    const btn = await screen.findByRole('button', {
      name: 'ホーム画面にインストール',
    });
    await act(async () => {
      fireEvent.click(btn);
      // userChoice の resolve を flush
      await userChoice;
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('Android + beforeinstallprompt → 拒否で hint は残るが button は消える (prompt は 1 度のみ)', async () => {
    setupMatchMedia(false);
    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129',
    );
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    render(withIntl(<PwaInstallHint />));

    const prompt = vi.fn().mockResolvedValue(undefined);
    const userChoice = Promise.resolve({ outcome: 'dismissed' as const });
    const ev = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice,
      preventDefault: vi.fn(),
    });
    await act(async () => {
      window.dispatchEvent(ev);
    });
    const btn = await screen.findByRole('button', {
      name: 'ホーム画面にインストール',
    });
    await act(async () => {
      fireEvent.click(btn);
      await userChoice;
    });
    // hint 本体 (title) はまだ表示中、button だけ消える
    expect(
      screen.queryByRole('button', { name: 'ホーム画面にインストール' }),
    ).toBeNull();
    expect(screen.getByText(/ホーム画面に追加すると/)).toBeInTheDocument();
  });

  it('appinstalled event → hint が消える (display-mode 反映前の保険)', async () => {
    setupMatchMedia(false);
    setUserAgent('Mozilla/5.0 (Linux; Android 14)');
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    const { container } = render(withIntl(<PwaInstallHint />));
    expect(container.firstChild).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('UA がデスクトップ Chrome → other hint を出す', async () => {
    setupMatchMedia(false);
    setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129',
    );
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    render(withIntl(<PwaInstallHint />));
    expect(screen.getByText(/対応モバイル端末/)).toBeInTheDocument();
  });

  it('× ボタンで手動 dismiss → 完全に非描画', async () => {
    setupMatchMedia(false);
    setUserAgent('Mozilla/5.0 (iPhone)');
    const { PwaInstallHint } = await import('@/components/PwaInstallHint');
    const { container } = render(withIntl(<PwaInstallHint />));
    fireEvent.click(screen.getByRole('button', { name: 'ヒントを閉じる' }));
    expect(container).toBeEmptyDOMElement();
  });
});
