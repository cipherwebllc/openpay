import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { QrPreviewModal } from '@/components/QrPreviewModal';

const LABELS = {
  title: '決済用 QR コード',
  close: '閉じる',
  eyebrow: 'OpenPay 決済 QR',
  print: '印刷',
  copy: 'URLをコピー',
  copied: 'コピー済み',
  downloadSvg: 'SVG保存',
  downloadPng: 'PNG保存',
};

function renderModal(overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    labels: LABELS,
    qrValue: 'https://test.local/pay?to=0xabc&amount=500',
    qrRef: createRef<HTMLDivElement>(),
    storeName: 'Kanda Coffee',
    amountText: '500 JPYC',
    payModeBadge: { text: 'ガスレス決済', tone: 'gasless' as const },
    note: 'スタッフに画面提示',
    chainText: 'JPYC · Polygon',
    receiverShort: '0xabc…def',
    copied: false,
    onCopy: vi.fn(),
    onPrint: vi.fn(),
    onDownloadSvg: vi.fn(),
    onDownloadPng: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <QrPreviewModal {...(props as Parameters<typeof QrPreviewModal>[0])} />,
  );
  return { ...utils, props };
}

describe('QrPreviewModal', () => {
  it('open=false では何も描画しない', () => {
    const { container } = renderModal({ open: false });
    expect(container.firstChild).toBeNull();
  });

  it('ポスター調プレビュー (店舗名/金額/バッジ/補足文/chain/アドレス) + QR を描画', () => {
    const { container } = renderModal();
    expect(screen.getByText('Kanda Coffee')).toBeInTheDocument();
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    expect(screen.getByText('ガスレス決済')).toBeInTheDocument();
    expect(screen.getByText('スタッフに画面提示')).toBeInTheDocument();
    expect(screen.getByText('JPYC · Polygon')).toBeInTheDocument();
    expect(screen.getByText('0xabc…def')).toBeInTheDocument();
    // QR (svg) が描画される
    expect(container.querySelector('svg')).not.toBeNull();
    // dialog semantics
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('× 閉じる で onClose、ESC でも onClose', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(props.onClose).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('印刷/コピー/SVG/PNG ボタンが各ハンドラを呼ぶ', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();
    await user.click(screen.getByRole('button', { name: '印刷' }));
    expect(props.onPrint).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'URLをコピー' }));
    expect(props.onCopy).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'SVG保存' }));
    expect(props.onDownloadSvg).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'PNG保存' }));
    expect(props.onDownloadPng).toHaveBeenCalledOnce();
  });

  it('copied=true でコピー済みラベルを出す', () => {
    renderModal({ copied: true });
    expect(
      screen.getByRole('button', { name: 'コピー済み' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'URLをコピー' })).toBeNull();
  });

  it('payModeBadge / download ハンドラ省略時は出さない', () => {
    renderModal({
      payModeBadge: undefined,
      onDownloadSvg: undefined,
      onDownloadPng: undefined,
      labels: { ...LABELS, downloadSvg: undefined, downloadPng: undefined },
    });
    expect(screen.queryByText('ガスレス決済')).toBeNull();
    expect(screen.queryByRole('button', { name: 'SVG保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PNG保存' })).toBeNull();
    // 印刷 / コピーは残る
    expect(screen.getByRole('button', { name: '印刷' })).toBeInTheDocument();
  });

  it('eip681 を渡すと fallback details を描画しコピーを委譲', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    renderModal({
      eip681: {
        uri: 'ethereum:0xtoken@137/transfer?address=0xabc&uint256=500',
        copied: false,
        onCopy,
        title: '互換 QR (EIP-681)',
        badge: '上級者向け',
        description: '一部ウォレット向け',
        copy: 'URI をコピー',
        copiedLabel: 'コピー済み',
      },
    });
    expect(screen.getByText('互換 QR (EIP-681)')).toBeInTheDocument();
    expect(
      screen.getByText(/^ethereum:0xtoken@137/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'URI をコピー' }));
    expect(onCopy).toHaveBeenCalledOnce();
  });
});
