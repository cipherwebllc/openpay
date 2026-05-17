import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

  it('explorerBase なし → tx/address どちらのリンクも非表示', () => {
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

  it('a11y: role="dialog" + aria-modal + aria-live=assertive', () => {
    render(
      <SuccessOverlay
        amountDisplay="100 USDC"
        txHash={TX_HASH}
        blockNumber={1n}
        onDismiss={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-live')).toBe('assertive');
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
