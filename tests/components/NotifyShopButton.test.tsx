// 「お店に知らせる」: 遠隔の注文の支払いの後、お客様自身の LINE やメールでお店に送る文を、このブラウザの中で作って
// 共有かコピーで渡す (OpenPay のサーバーには送らない)。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { isRemoteOrderCheckout, notifyShopMessage, NotifyShopButton } from '@/components/NotifyShopButton';

const TX = `0x${'a'.repeat(64)}`;
const EXPLORER = `https://polygonscan.com/tx/${TX}`;

function stubShare(share: ReturnType<typeof vi.fn> | undefined) {
  if (share) Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  else Reflect.deleteProperty(navigator, 'share');
}
function stubClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  if (writeText) Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  else Reflect.deleteProperty(navigator, 'clipboard');
}

afterEach(() => {
  stubShare(undefined);
  stubClipboard(undefined);
  vi.restoreAllMocks();
});

function renderButton() {
  render(<NotifyShopButton orderNo="A-001" amountDisplay="3,500 JPYC" txHash={TX} explorerTxUrl={EXPLORER} tone="panel" />);
}

const EXPECTED = ['ご注文 A-001 のお支払いが済みました。', '支払金額: 3,500 JPYC', `Tx Hash: ${TX}`, EXPLORER].join('\n');

describe('isRemoteOrderCheckout', () => {
  it('受付番号のある注文リンクや外部の /checkout リンクだけ (店頭のモバイル注文・お店の端末・番号なしは除く)', () => {
    expect(isRemoteOrderCheckout({ orderId: 'A-001' })).toBe(true);
    expect(isRemoteOrderCheckout({})).toBe(false);
    expect(isRemoteOrderCheckout({ orderId: 'M-1', storeHandle: 'cafe' })).toBe(false);
    expect(isRemoteOrderCheckout({ orderId: 'M-1', feeKind: 'storefront' })).toBe(false);
    expect(isRemoteOrderCheckout({ orderId: 'A-001', submit: 'store' })).toBe(false);
  });
});

describe('notifyShopMessage', () => {
  it('受付番号の一文・金額・Tx Hash・Explorer のリンクを行に分ける (リンクが無ければ省く)', () => {
    expect(
      notifyShopMessage({ intro: 'a', amountLine: 'b', txHash: TX, explorerTxUrl: EXPLORER }),
    ).toBe(`a\nb\nTx Hash: ${TX}\n${EXPLORER}`);
    expect(notifyShopMessage({ intro: 'a', amountLine: 'b', txHash: TX })).toBe(`a\nb\nTx Hash: ${TX}`);
  });
});

describe('NotifyShopButton', () => {
  it('共有できる端末では、受付番号・金額・Tx Hash・Explorer のリンクの入った文で共有を開く', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubShare(share);
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ text: EXPECTED }));
    expect(await screen.findByRole('status')).toHaveTextContent('共有しました');
    // 共有が使えなかったときのために、コピーも残す。
    expect(screen.getByRole('button', { name: '文をコピー' })).toBeInTheDocument();
  });

  it('共有を取り消しても何も出さず、コピーは押せる', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubShare(share);
    stubClipboard(writeText);
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '文をコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXPECTED));
  });

  it('共有できない端末 (PC) では、押すと文をコピーする', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderButton();
    expect(screen.queryByRole('button', { name: '文をコピー' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXPECTED));
    expect(await screen.findByRole('status')).toHaveTextContent('コピーしました');
  });

  it('コピーもできないときは、文を選んで写せる欄を見出しつきで出す', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    const box = await screen.findByLabelText('お店に送る文 (選んでコピーしてください)');
    expect(box).toHaveValue(EXPECTED);
  });
});
