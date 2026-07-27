import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { QrPreviewModal } from '@/components/QrPreviewModal';

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
    expect(screen.queryByText(/着金を監視中/)).toBeNull();
    expect(screen.queryByText(/着金を確認しました/)).toBeNull();
    // status role の line も無い
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('paymentStatus=watching で監視中テキストを status として描画', () => {
    renderModal({
      paymentStatus: {
        state: 'watching',
        text: '着金を監視中…（この画面で確認できます）',
      },
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('着金を監視中…（この画面で確認できます）');
  });

  it('paymentStatus=received で着金確認テキストを status として描画', () => {
    renderModal({
      paymentStatus: {
        state: 'received',
        text: '着金を確認しました ✓（+1000 JPYC 受信）',
      },
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('着金を確認しました ✓（+1000 JPYC 受信）');
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
