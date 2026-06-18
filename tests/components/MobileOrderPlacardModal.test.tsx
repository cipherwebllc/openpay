// MobileOrderPlacardModal を実描画で検証: 必須内容 (ブランド/店名/説明/QR/操作文/受取チェーン/URL)
// の表示・任意項目 (ひとこと/アバター) の出し分け・open=false の非描画・操作ボタン・印刷マーカー・
// a11y (初期フォーカス/ESC/背景クリック/Tab トラップ)。labels-as-props なので intl provider は不要。

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileOrderPlacardModal } from '@/components/MobileOrderPlacardModal';

const LABELS = {
  dialogTitle: 'プラカード',
  eyebrow: 'OpenPay モバイルオーダー',
  subtitle: '券売機のようにスマホで注文できます',
  scanNote: 'QR を読み取って注文',
  payNote: 'お支払いは JPYC のみ',
  chainsLabel: '対応ネットワーク',
  print: '印刷',
  copy: 'コピー',
  copied: 'コピーしました',
  close: '閉じる',
};

function setup(
  props: Partial<ComponentProps<typeof MobileOrderPlacardModal>> = {},
) {
  const onClose = vi.fn();
  const onCopy = vi.fn();
  const utils = render(
    <MobileOrderPlacardModal
      open
      onClose={onClose}
      url="https://open-pay.jp/@yamada"
      shopName="山田カフェ"
      chains={['Polygon', 'Kaia']}
      labels={LABELS}
      copied={false}
      onCopy={onCopy}
      {...props}
    />,
  );
  return { ...utils, onClose, onCopy };
}

afterEach(() => {
  document.body.classList.remove('openpay-printing-placard');
  vi.unstubAllGlobals();
});

describe('MobileOrderPlacardModal', () => {
  it('open=false は何も描画しない', () => {
    const { container } = render(
      <MobileOrderPlacardModal
        open={false}
        onClose={vi.fn()}
        url="https://open-pay.jp/@x"
        shopName="X"
        chains={[]}
        labels={LABELS}
        copied={false}
        onCopy={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('必須内容 (ブランド/店名/説明/操作文/受取チェーン/URL/QR) を表示する', () => {
    const { container } = setup();
    expect(screen.getByText('OpenPay モバイルオーダー')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '山田カフェ' })).toBeInTheDocument();
    expect(screen.getByText('券売機のようにスマホで注文できます')).toBeInTheDocument();
    expect(screen.getByText('QR を読み取って注文')).toBeInTheDocument();
    // 支払い手段 (JPYC のみ) を明示。
    expect(screen.getByText('お支払いは JPYC のみ')).toBeInTheDocument();
    // 対応ネットワークは label + 「・」結合で 1 行に。
    expect(screen.getByText('対応ネットワーク：Polygon ・ Kaia')).toBeInTheDocument();
    // URL は本文表示。
    expect(screen.getByText('https://open-pay.jp/@yamada')).toBeInTheDocument();
    // QR は qrcode.react が size=240 の <svg> を描画する (アイコンの svg と区別して特定)。
    expect(container.querySelector('svg[height="240"]')).toBeTruthy();
    // ポスターは印刷対象マーカーを持つ。
    expect(container.querySelector('[data-placard-printing]')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'プラカード' })).toBeInTheDocument();
  });

  it('ひとこと (tagline) は指定時のみ表示する', () => {
    setup({ tagline: '〜こだわり珈琲〜' });
    expect(screen.getByText('〜こだわり珈琲〜')).toBeInTheDocument();
  });

  it('ひとこと未指定なら表示しない', () => {
    setup();
    expect(screen.queryByText('〜こだわり珈琲〜')).not.toBeInTheDocument();
  });

  it('アバターは指定時のみ <img> を描画する', () => {
    const { container } = setup({ avatar: 'https://img.example/a.png' });
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://img.example/a.png');
  });

  it('チェーンが空なら対応ネットワーク行を出さない', () => {
    setup({ chains: [] });
    expect(screen.queryByText(/^対応ネットワーク：/)).not.toBeInTheDocument();
  });

  it('印刷ボタンは body にマーカーを付けて window.print を呼ぶ', () => {
    const printSpy = vi.fn();
    vi.stubGlobal('print', printSpy);
    setup();
    fireEvent.click(screen.getByRole('button', { name: '印刷' }));
    expect(printSpy).toHaveBeenCalledTimes(1);
    // 印刷時はポスター 1 枚を残すための body マーカーが付く (globals.css @media print)。
    expect(document.body.classList.contains('openpay-printing-placard')).toBe(true);
  });

  it('コピー / 閉じる ボタンがコールバックを発火する', () => {
    const { onClose, onCopy } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'コピー' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copied=true は「コピーしました」を出す', () => {
    setup({ copied: true });
    expect(screen.getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'コピー' })).not.toBeInTheDocument();
  });

  it('開いたら閉じるボタンへフォーカスする', () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '閉じる' }));
  });

  it('ESC で onClose する', () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('背景 (オーバーレイ) クリックで onClose する / カード内クリックでは閉じない', () => {
    const { onClose } = setup();
    // カード内 (見出し) クリックは stopPropagation で閉じない。
    fireEvent.click(screen.getByRole('heading', { name: '山田カフェ' }));
    expect(onClose).not.toHaveBeenCalled();
    // オーバーレイ (dialog) クリックは閉じる。
    fireEvent.click(screen.getByRole('dialog', { name: 'プラカード' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab はダイアログ内のボタンを循環する (背後へ抜けない)', () => {
    setup();
    const close = screen.getByRole('button', { name: '閉じる' });
    const copy = screen.getByRole('button', { name: 'コピー' });
    // 末尾 (コピー) で Tab → 先頭 (閉じる) へ。
    copy.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    // 先頭 (閉じる) で Shift+Tab → 末尾 (コピー) へ。
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(copy);
  });
});
