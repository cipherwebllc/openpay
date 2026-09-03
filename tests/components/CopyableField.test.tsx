import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { CopyableField } from '@/components/CopyableField';

const TX_HASH = `0x${'a'.repeat(64)}`;

describe('CopyableField', () => {
  // userEvent.setup() が初回呼出で navigator.clipboard polyfill を install するため、
  // setup() 後に writeText を spy on する。beforeEach で user 生成 + spy をまとめる。
  let user: ReturnType<typeof userEvent.setup>;
  // vi.spyOn の generic 推論を素直に通すため、戻り値の MockInstance 型を直接指定。
  // navigator.clipboard.writeText の signature は (data: string) => Promise<void>。
  let writeText: import('vitest').MockInstance<
    (data: string) => Promise<void>
  >;

  beforeEach(() => {
    user = userEvent.setup();
    writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeText.mockRestore();
  });

  it('value を表示し、displayValue 指定時はそちらを優先する', () => {
    render(<CopyableField value={TX_HASH} label="Tx Hash" />);
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();

    const { unmount } = render(
      <CopyableField value={TX_HASH} displayValue="0xaaaa…aaaa" label="Tx Hash" />,
    );
    expect(screen.getByText('0xaaaa…aaaa')).toBeInTheDocument();
    unmount();
  });

  it('クリック → navigator.clipboard.writeText に value が渡る', async () => {
    render(<CopyableField value={TX_HASH} label="Tx Hash" />);
    const btn = screen.getByRole('button', { name: /Tx Hash をコピー/ });
    await user.click(btn);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(TX_HASH);
  });

  it('クリック後 1.5 秒間「✓ コピー済み」フィードバック表示、後に「コピー」へ戻る', async () => {
    // 通常 timer を fake にすると userEvent v14 がブロックされるため、ここでは
    // 実時間 setTimeout を使う (1500ms 待機)。CI では vitest の testTimeout
    // (5s) 内で完結するので問題なし。
    render(<CopyableField value={TX_HASH} label="Tx Hash" />);
    await user.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(screen.getByText(/✓ コピー済み/)).toBeInTheDocument(),
    );

    await waitFor(
      () => {
        expect(screen.queryByText(/✓ コピー済み/)).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('keyboard (Enter) でもコピー発火', async () => {
    render(<CopyableField value={TX_HASH} label="Tx Hash" />);
    const btn = screen.getByRole('button');
    btn.focus();
    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledOnce();
  });

  // 掟 8: 可視テキストを含まない aria-label 単独付与は禁止 (WCAG 2.5.3)。
  // a11y 名は「可視のハッシュ + sr-only の説明」から導出する。
  it('aria-label を使わず、可視テキスト + sr-only で a11y 名を作る (a11y)', () => {
    render(<CopyableField value={TX_HASH} label="UserOp Hash" />);
    const btn = screen.getByRole('button');
    expect(btn.hasAttribute('aria-label')).toBe(false);
    // 可視のハッシュが a11y 名に含まれる (label-content-name-mismatch を起こさない)。
    expect(btn.textContent).toContain(TX_HASH);
    expect(btn.textContent).toContain('UserOp Hash をコピー');
    const srOnly = screen.getByText('UserOp Hash をコピー');
    expect(srOnly.className).toContain('sr-only');
  });

  it('clipboard 不在の span でも aria-label でなく sr-only ラベルを使う', () => {
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => undefined,
    });
    try {
      const { container } = render(
        <CopyableField value={TX_HASH} label="Tx Hash" />,
      );
      expect(container.querySelector('[aria-label]')).toBeNull();
      const srOnly = screen.getByText('Tx Hash:');
      expect(srOnly.className).toContain('sr-only');
    } finally {
      if (desc) {
        Object.defineProperty(navigator, 'clipboard', desc);
      } else {
        // @ts-expect-error: navigator.clipboard は通常 readonly だがテスト用
        delete navigator.clipboard;
      }
    }
  });

  it('navigator.clipboard 不在の環境では button ではなく span として描画 (graceful degrade)', () => {
    // navigator は jsdom の global なので clipboard を一時的に getter で undefined 化
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => undefined,
    });
    try {
      render(<CopyableField value={TX_HASH} label="Tx Hash" />);
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    } finally {
      // 元の prototype getter を復元
      if (desc) {
        Object.defineProperty(navigator, 'clipboard', desc);
      } else {
        // own property として上書きしてしまった場合は削除
        // @ts-expect-error: navigator.clipboard は通常 readonly だがテスト用
        delete navigator.clipboard;
      }
    }
  });
});
