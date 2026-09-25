import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { QrPreviewModal } from '@/components/QrPreviewModal';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const LABELS = {
  title: '決済用 QR コード',
  close: '閉じる',
  eyebrow: 'OpenPay ステーブルコイン決済 QR',
  print: '印刷',
  copy: 'URLをコピー',
  copied: 'コピー済み',
  downloadSvg: 'SVG保存',
  downloadPng: 'PNG保存',
};

function renderModal(overrides: Partial<Parameters<typeof QrPreviewModal>[0]> = {}) {
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
  const utils = render(<QrPreviewModal {...props} />);
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

  it('labels.localGenNote 指定時のみ「端末内生成 (通信不要)」の安心表示を出す (C1)', () => {
    // 既定 LABELS には無いので未指定では出ない
    const { unmount } = renderModal();
    expect(screen.queryByText(/端末内で生成/)).toBeNull();
    unmount();
    // 指定すると QR 近くに圏外現場向けの安心表示が出る
    renderModal({
      labels: {
        ...LABELS,
        localGenNote:
          'この QR は端末内で生成（通信不要）。圏外でも表示・提示できます。',
      },
    });
    expect(
      screen.getByText(/端末内で生成（通信不要）/),
    ).toBeInTheDocument();
  });

  it('× 閉じる で onClose、ESC でも onClose', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(props.onClose).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('B-R11e: onClose の更新で focus を奪わず Escape / close は最新のハンドラを呼ぶ', async () => {
    const user = userEvent.setup();
    render(<label>Outside input<input /></label>);
    const { props, rerender } = renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    const input = screen.getByRole('textbox', { name: 'Outside input' });
    input.focus();
    const onClose = vi.fn();
    rerender(<QrPreviewModal {...props} onClose={onClose} />);
    expect(input).toHaveFocus();
    expect(screen.getByRole('dialog')).toBe(dialog);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: LABELS.close }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(props.onClose).not.toHaveBeenCalled();
    rerender(<QrPreviewModal {...props} onClose={onClose} open={false} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('B-R11e: close / unmount で開く直前の focus を戻し、再表示時は起点を取り直す', async () => {
    const user = userEvent.setup();
    render(<><button>First opener</button><button>Second opener</button></>);
    const first = screen.getByRole('button', { name: 'First opener' });
    const second = screen.getByRole('button', { name: 'Second opener' });
    first.focus();
    const { props, rerender, unmount } = renderModal();
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: LABELS.copy }));
    const onClose = vi.fn();
    rerender(<QrPreviewModal {...props} onClose={onClose} />);
    rerender(<QrPreviewModal {...props} onClose={onClose} open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(first).toHaveFocus();

    second.focus();
    rerender(<QrPreviewModal {...props} onClose={onClose} />);
    expect(screen.getByRole('dialog')).toHaveFocus();
    unmount();
    expect(second).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
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

  it('payModeBadge / print / download ハンドラ省略時はそのボタンを出さない (レジ想定)', () => {
    renderModal({
      payModeBadge: undefined,
      onPrint: undefined,
      onDownloadSvg: undefined,
      onDownloadPng: undefined,
      labels: { ...LABELS, print: undefined, downloadSvg: undefined, downloadPng: undefined },
    });
    expect(screen.queryByText('ガスレス決済')).toBeNull();
    expect(screen.queryByRole('button', { name: '印刷' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'SVG保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PNG保存' })).toBeNull();
    // コピー / 閉じる は残る
    expect(screen.getByRole('button', { name: 'URLをコピー' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /閉じる/ })).toBeInTheDocument();
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

  it('paymentStatus 省略時は着金ヒントを描画しない (既存呼び出し元は無影響)', () => {
    renderModal();
    expect(screen.queryByText(/残高を監視中/)).toBeNull();
    expect(screen.queryByText(/残高の増加を検知/)).toBeNull();
    // status role の line も無い
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('paymentStatus=watching で監視中テキストを status として描画', () => {
    renderModal({
      paymentStatus: {
        state: 'watching',
        text: ja.QrGenerator.paymentWatching,
      },
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(ja.QrGenerator.paymentWatching);
  });

  it('paymentStatus=received は決済成功でなく中立な残高ヒントとして描画', () => {
    renderModal({
      paymentStatus: {
        state: 'received',
        text: ja.QrGenerator.paymentReceived.replace('{amount}', '1000 JPYC'),
      },
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(ja.QrGenerator.paymentReceived.replace('{amount}', '1000 JPYC'));
    expect(status).toHaveClass('text-slate-600');
    expect(status).not.toHaveClass('text-emerald-600', 'font-semibold');
    expect(status.querySelector('.lucide-circle-check')).toBeNull();
  });

  const ASSET_LABELS = {
    ...LABELS,
    step1: 'スマホでスキャン',
    step2: '金額を確認',
    step3: 'お支払い完了',
  };

  it('asset (jpyc) 指定で金額ヒーロー / chain バッジ / 3 ステップ / ロゴを描画し mono chainText・peg pill は出さない', () => {
    renderModal({
      labels: ASSET_LABELS,
      asset: { tokenSymbol: 'jpyc', chainSlug: 'polygon', chainLabel: 'Polygon' },
    });
    // 金額ヒーローがトークン識別を兼ねる (amountText に symbol を含む)。
    // 旧デザインのトークン名だけの独立行と peg pill は廃止 (JPYC で払う顧客には自明で、
    // 金額から視線を逸らすため・user 裁定 2026-07-26)。
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    expect(screen.queryByText('1 JPYC = ¥1')).toBeNull();
    // chain バッジ (ラベル) — mono の "JPYC · Polygon" は出さない
    expect(screen.getByText('Polygon')).toBeInTheDocument();
    expect(screen.queryByText('JPYC · Polygon')).toBeNull();
    // 3 ステップ
    expect(screen.getByText('スマホでスキャン')).toBeInTheDocument();
    expect(screen.getByText('金額を確認')).toBeInTheDocument();
    expect(screen.getByText('お支払い完了')).toBeInTheDocument();
    // フッター OpenPay ロゴ
    expect(screen.getByAltText('OpenPay')).toBeInTheDocument();
  });

  it('asset (usdc) でも金額 / chain バッジを出す (peg pill は全トークンで非表示)', () => {
    renderModal({
      labels: ASSET_LABELS,
      chainText: 'USDC · Base',
      asset: { tokenSymbol: 'usdc', chainSlug: 'base', chainLabel: 'Base' },
    });
    // 金額ヒーローが symbol を含む (BASE_PROPS の amountText)。
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    expect(screen.queryByText('1 JPYC = ¥1')).toBeNull();
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.queryByText('USDC · Base')).toBeNull();
  });

  it('asset 未指定では従来の mono chainText を維持し peg pill / 3 ステップ / ロゴを出さない (レジ非破壊)', () => {
    renderModal();
    expect(screen.getByText('JPYC · Polygon')).toBeInTheDocument();
    expect(screen.queryByText('1 JPYC = ¥1')).toBeNull();
    expect(screen.queryByText('スマホでスキャン')).toBeNull();
    expect(screen.queryByAltText('OpenPay')).toBeNull();
  });
});

describe('QrPreviewModal FX expiry', () => {
  it.each([['ja', ja], ['en', en]])('%s: keeps the live region mounted and updates its text immediately on expiry', (_locale, messages) => {
    const { props, rerender } = renderModal({
      labels: { ...LABELS, convertExpired: messages.QrGenerator.qrModalConvertExpired },
      convertExpired: false,
    });
    const status = screen.getByRole('status');
    const qr = props.qrRef.current!;
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).not.toHaveAttribute('aria-label');
    expect(qr.nextElementSibling).toBe(status);
    expect(qr).not.toHaveClass('opacity-40');
    expect(screen.getByRole('button', { name: LABELS.copy })).toBeEnabled();

    rerender(<QrPreviewModal {...props} convertExpired />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent(messages.QrGenerator.qrModalConvertExpired);
    expect(status).toHaveClass('border-amber-200', 'bg-amber-50', 'text-amber-900');
    expect(props.qrRef.current).toBe(qr);
    expect(qr).toHaveClass('opacity-40');

    rerender(<QrPreviewModal {...props} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toBeEmptyDOMElement();
    expect(qr).not.toHaveClass('opacity-40');
    expect(screen.getByRole('button', { name: LABELS.copy })).toBeEnabled();
  });

  it('disables print, copy, downloads and EIP-681 copy while leaving close available', async () => {
    const user = userEvent.setup();
    const eipCopy = vi.fn();
    const { props, container } = renderModal({
      labels: { ...LABELS, convertExpired: ja.QrGenerator.qrModalConvertExpired },
      convertExpired: true,
      eip681: {
        uri: 'ethereum:0xtoken@137/transfer?address=0xabc&uint256=500',
        copied: false,
        onCopy: eipCopy,
        title: '互換 QR (EIP-681)',
        badge: '上級者向け',
        description: '一部ウォレット向け',
        copy: 'URI をコピー',
        copiedLabel: 'コピー済み',
      },
    });
    await user.click(screen.getByText('互換 QR (EIP-681)'));
    expect(container.querySelector('svg[width="180"]')).toHaveClass('opacity-40');
    for (const name of [LABELS.print, LABELS.copy, LABELS.downloadSvg, LABELS.downloadPng, 'URI をコピー']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      await user.click(button);
    }
    for (const handler of [props.onPrint, props.onCopy, props.onDownloadSvg, props.onDownloadPng, eipCopy]) {
      expect(handler).not.toHaveBeenCalled();
    }
    const close = screen.getByRole('button', { name: LABELS.close });
    expect(close).toBeEnabled();
    await user.click(close);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('keeps focus on expiry, skips newly disabled actions and restores the opener on close / unmount', async () => {
    const user = userEvent.setup();
    render(<button>Open QR</button>);
    const opener = screen.getByRole('button', { name: 'Open QR' });
    opener.focus();
    const { props, rerender, unmount } = renderModal({
      labels: { ...LABELS, convertExpired: ja.QrGenerator.qrModalConvertExpired },
      convertExpired: false,
    });
    const dialog = screen.getByRole('dialog');
    const copy = screen.getByRole('button', { name: LABELS.copy });
    const close = screen.getByRole('button', { name: LABELS.close });
    copy.focus();
    rerender(<QrPreviewModal {...props} convertExpired />);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(copy).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledOnce();
    rerender(<QrPreviewModal {...props} convertExpired open={false} />);
    expect(opener).toHaveFocus();
    rerender(<QrPreviewModal {...props} convertExpired />);
    expect(screen.getByRole('dialog')).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
  });

  it('does not steal external focus on expiry or close', () => {
    render(<label>Outside input<input /></label>);
    const { props, rerender } = renderModal({
      labels: { ...LABELS, convertExpired: ja.QrGenerator.qrModalConvertExpired },
      convertExpired: false,
    });
    const input = screen.getByRole('textbox', { name: 'Outside input' });
    input.focus();
    rerender(<QrPreviewModal {...props} convertExpired />);
    expect(input).toHaveFocus();
    rerender(<QrPreviewModal {...props} convertExpired open={false} />);
    expect(input).toHaveFocus();
  });
});
