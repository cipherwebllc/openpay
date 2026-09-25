import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { SuccessOverlay } from '@/components/SuccessOverlay';

const TX_HASH = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'b'.repeat(64)}`;
const MERCHANT_ADDR = `0x${'c'.repeat(40)}`;

describe('SuccessOverlay', () => {
  it('タイトル / 金額 / 完了時刻 / tx詳細 / dismiss ボタンが表示される', () => {
    render(
      <SuccessOverlay
        amountDisplay="1,500 JPYC"
        txHash={TX_HASH}
        userOpHash={USER_OP_HASH}
        blockNumber={12345n}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('決済完了')).toBeInTheDocument();
    expect(screen.getByText('1,500 JPYC')).toBeInTheDocument();
    // tx hash 短縮表示 (CopyableField は jsdom 既定では navigator.clipboard
    // 不在で span 描画、polyfill 装填済なら button 描画。どちらでも text は同じ)
    // slice(0, 10) → '0x' + 8 chars、slice(-6) → 末尾 6 chars
    expect(document.body.textContent).toContain('0xaaaaaaaa…aaaaaa');
    expect(document.body.textContent).toContain('0xbbbbbbbb…bbbbbb');
    expect(screen.getByText('12345')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument();
  });

  it('現在時刻が HH:MM:SS 形式で描画される (ゼロ詰め)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    // 各セル 2 桁ゼロ詰め (例: 09:05:30)
    expect(screen.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('時刻が 1 秒ごとに更新される (毎秒 tick)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    // 開始時刻を固定 (2026-04-29 12:00:00 ローカル)
    vi.setSystemTime(new Date(2026, 3, 29, 12, 0, 0));
    const { act } = await import('@testing-library/react');
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText('12:00:00')).toBeInTheDocument();
    // 1 秒進めると setInterval が発火して new Date() が新しい時刻を返す
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('12:00:01')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('「閉じる」ボタン → onDismiss が呼ばれる', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('ESC キーで onDismiss が呼ばれる (a11y)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={onDismiss}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('B-R11f: onDismiss の更新で内部の focus を奪わず、Escape / close は最新のハンドラを呼ぶ', async () => {
    const user = userEvent.setup();
    const previousDismiss = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={previousDismiss} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    const history = screen.getByRole('link', { name: /このブラウザの履歴を見る/ });
    history.focus();
    rerender(<SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={onDismiss} />);
    expect(history).toHaveFocus();
    expect(screen.getByRole('dialog')).toBe(dialog);

    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(previousDismiss).not.toHaveBeenCalled();
  });

  it('B-R11f: Tab / Shift+Tab が overlay 内を循環し、外からの Tab も引き戻す', async () => {
    const user = userEvent.setup();
    render(<>
      <SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={() => undefined} />
      <button>Outside</button>
    </>);
    const first = screen.getByRole('button', { name: '完了音をオフにする' });
    const copy = screen.getByRole('button', { name: /Tx Hash をコピー/ });
    const last = screen.getByRole('button', { name: '閉じる' });
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(copy).toHaveFocus();
    await user.tab({ shift: true });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    screen.getByRole('button', { name: 'Outside' }).focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('B-R11f: IME 中は Escape / Tab を処理しない (%j)', (ime) => {
    const onDismiss = vi.fn();
    render(<SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={onDismiss} />);
    const close = screen.getByRole('button', { name: '閉じる' });
    close.focus();
    expect(fireEvent.keyDown(close, { key: 'Tab', ...ime })).toBe(true);
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape', ...ime });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('B-R11f: StrictMode の mount で focus し、unmount で起点に戻して listener を解除する', async () => {
    const user = userEvent.setup();
    render(<button>Opener</button>);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    const onDismiss = vi.fn();
    const { unmount } = render(
      <SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={onDismiss} />,
      { reactStrictMode: true },
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: '閉じる' }).focus();
    unmount();
    expect(opener).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('B-R11f: 外へ移した focus は再描画 / unmount でも奪わない', () => {
    render(<><button>Opener</button><input aria-label="Outside" /></>);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    const { rerender, unmount } = render(
      <SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={() => undefined} />,
    );
    const outside = screen.getByRole('textbox', { name: 'Outside' });
    outside.focus();
    rerender(<SuccessOverlay amountDisplay="100 USDC" txHash={TX_HASH} onDismiss={() => undefined} />);
    expect(outside).toHaveFocus();
    unmount();
    expect(outside).toHaveFocus();
  });

  it('explorerBase 指定時は Tx Explorer リンクが描画される', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        explorerBase="https://basescan.org"
        onDismiss={() => undefined}
      />,
    );
    const link = screen.getByRole('link', { name: /Tx を Explorer で確認/ });
    expect(link).toHaveAttribute('href', `https://basescan.org/tx/${TX_HASH}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('explorerBase + merchantAddress 指定時は店舗アドレス Explorer リンクも描画される', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        explorerBase="https://basescan.org"
        merchantAddress={MERCHANT_ADDR}
        onDismiss={() => undefined}
      />,
    );
    const link = screen.getByRole('link', {
      name: /店舗ウォレットの履歴を見る/,
    });
    expect(link).toHaveAttribute(
      'href',
      `https://basescan.org/address/${MERCHANT_ADDR}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('merchantAddress なし → address リンクは描画しない (tx リンクのみ)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        explorerBase="https://basescan.org"
        onDismiss={() => undefined}
      />,
    );
    expect(screen.queryByRole('link', { name: /店舗ウォレット/ })).toBeNull();
    expect(
      screen.getByRole('link', { name: /Tx を Explorer で確認/ }),
    ).toBeInTheDocument();
  });

  it('explorerBase なし → tx/address explorer リンクは非表示 (履歴 link は残る)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        merchantAddress={MERCHANT_ADDR}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.queryByRole('link', { name: /Explorer/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /店舗ウォレット/ })).toBeNull();
    // viewLocalHistoryLink は explorerBase に依らず常時表示
    expect(
      screen.getByRole('link', { name: /このブラウザの履歴を見る/ }),
    ).toBeInTheDocument();
  });

  it('viewLocalHistoryLink は常に表示され /history を指す', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    const link = screen.getByRole('link', {
      name: /このブラウザの履歴を見る/,
    });
    expect(link).toHaveAttribute('href', '/history');
  });

  it('NonCustodialNotice (short) が常に描画される (ノンカストディ宣言)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    expect(
      screen.getByText('履歴はブロックチェーン上にあります'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/正確な入金状況は店舗ウォレットまたは Explorer/),
    ).toBeInTheDocument();
  });

  it('userOpHash なし → UserOp 行は描画しない', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.queryByText('UserOp Hash')).toBeNull();
  });

  it('orderNo 指定 → 受付番号ラベル + コードを表示 (受け渡し照合用)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        orderNo="7K3Q"
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText('受付番号')).toBeInTheDocument();
    expect(screen.getByText('7K3Q')).toBeInTheDocument();
  });

  it('orderNo なし → 受付番号は描画しない (QR/チップ等の単発決済)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.queryByText('受付番号')).toBeNull();
  });

  it('a11y: dialog の名前は可視見出しから導出し、読み上げ対象に時計を含めない', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '決済完了' });
    const heading = screen.getByRole('heading', { name: '決済完了' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
    expect(dialog).not.toHaveAttribute('aria-live');
    expect(heading).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText(/^\d{2}:\d{2}:\d{2}$/).closest('[aria-live]')).toBeNull();
    expect(dialog.getAttribute('tabIndex')).toBe('-1');
  });

  // CopyableField の writeText 経路は CopyableField.test 側で検証済。ここでは
  // SuccessOverlay 内で CopyableField が tx hash を渡されていることだけ確認。
  it('CopyableField クリックで navigator.clipboard.writeText に txHash が渡る (整合確認)', async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    // tx hash の copy ボタンをクリック
    const copyBtn = screen.getByRole('button', { name: /Tx Hash をコピー/ });
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith(TX_HASH);
    writeText.mockRestore();
  });
});

describe('SuccessOverlay: 完了音トグル (PayPay 風チャイム)', () => {
  const SOUND_KEY = 'openpay:success-sound';

  beforeEach(() => {
    // 既定 ON 状態から始める (前テストの永続値を持ち越さない)。
    try {
      window.localStorage.removeItem(SOUND_KEY);
    } catch {
      /* noop */
    }
  });

  it('ja: 既定で音ON → 「完了音をオフにする」トグルを表示', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        onDismiss={() => undefined}
      />,
    );
    expect(
      screen.getByRole('button', { name: '完了音をオフにする' }),
    ).toBeInTheDocument();
  });

  it('クリックで OFF へ切替 → ラベルが「完了音をオンにする」+ localStorage に永続', async () => {
    const user = userEvent.setup();
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        onDismiss={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: '完了音をオフにする' }));
    expect(
      screen.getByRole('button', { name: '完了音をオンにする' }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(SOUND_KEY)).toBe('0');
  });

  it('永続値 OFF を初期反映 (mount 後に OFF ラベル)', () => {
    window.localStorage.setItem(SOUND_KEY, '0');
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        onDismiss={() => undefined}
      />,
    );
    expect(
      screen.getByRole('button', { name: '完了音をオンにする' }),
    ).toBeInTheDocument();
  });

  it('en: トグルの aria-label が英訳 (Mute completion sound)', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        onDismiss={() => undefined}
      />,
      { locale: 'en' },
    );
    expect(
      screen.getByRole('button', { name: 'Mute completion sound' }),
    ).toBeInTheDocument();
  });
});
