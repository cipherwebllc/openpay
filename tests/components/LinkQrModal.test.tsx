import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LinkQrModal } from '@/components/LinkQrModal';

// QRCodeSVG は SVG を吐くだけなので素のまま使う (重い依存なし)。

describe('LinkQrModal', () => {
  it('open=false は何も描画しない', () => {
    const { container } = render(
      <LinkQrModal open={false} value="https://x/@a" title="@a" closeLabel="閉じる" onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('開くと閉じるボタンへフォーカス・Tab トラップ・ESC で onClose', () => {
    const onClose = vi.fn();
    render(
      <LinkQrModal open value="https://x/@a" title="@a" closeLabel="閉じる" onClose={onClose} />,
    );
    // open は最初から true なので、mount effect 後フォーカスは閉じるボタンへ。
    const close = screen.getByRole('button', { name: '閉じる' });
    expect(document.activeElement).toBe(close);
    // Tab は背後へ抜けず閉じるボタンに留まる。
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    // ESC で onClose。
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('表示中に親が再レンダ (onClose の identity 変化) しても復元先が閉じるボタンに化けない', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // 毎レンダ新しい onClose を渡す親を模す。
    const { rerender } = render(
      <LinkQrModal open value="https://x/@a" title="@a" closeLabel="閉じる" onClose={() => {}} />,
    );
    // フォーカスは閉じるボタンへ移っている。
    const close = screen.getByRole('button', { name: '閉じる' });
    expect(document.activeElement).toBe(close);
    // 表示中の親再レンダ (新 onClose identity)。旧コードは effect 再実行で returnFocusRef を
    // close 自身に上書きしていた → 修正後は再捕捉しない。
    rerender(
      <LinkQrModal open value="https://x/@a" title="@a" closeLabel="閉じる" onClose={() => {}} />,
    );
    // 閉じる → 復元先は元の trigger (close 自身ではない)。
    rerender(
      <LinkQrModal open={false} value="https://x/@a" title="@a" closeLabel="閉じる" onClose={() => {}} />,
    );
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});
