// 注文リンクの「入金を確かめる」の画面: 結果ごとの文と、Explorer のリンク。チェーンを読む部分は lib のテストが見る。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';

const check = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orderLinkVerify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orderLinkVerify')>();
  return { ...actual, checkOrderLinkPayment: check };
});

import { OrderLinkVerify } from '@/components/order-link/OrderLinkVerify';

const RECEIVER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const HASH = `0x${'ab'.repeat(32)}`;

afterEach(() => check.mockReset());

function paste(text: string) {
  fireEvent.change(screen.getByLabelText('お客様から届いた Tx Hash'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
}

describe('OrderLinkVerify', () => {
  it('受取ウォレットが無いか、何も貼っていなければ押せない', () => {
    const { unmount } = render(<OrderLinkVerify chain="polygon" receiver={null} />);
    fireEvent.change(screen.getByLabelText('お客様から届いた Tx Hash'), { target: { value: HASH } });
    expect(screen.getByRole('button', { name: '確かめる' })).toBeDisabled();
    unmount();
    render(<OrderLinkVerify chain="polygon" receiver={RECEIVER} />);
    expect(screen.getByRole('button', { name: '確かめる' })).toBeDisabled();
  });

  it('届いていれば額・ブロック・照らし合わせの注意と Explorer のリンクを出す', async () => {
    check.mockResolvedValue({ status: 'paid', received: '3465', blockNumber: 123n, timestamp: 1_762_000_000 });
    render(<OrderLinkVerify chain="polygon" receiver={RECEIVER} />);
    paste(`ご注文 A-001 のお支払いが済みました。\nTx Hash: ${HASH}`);
    expect(await screen.findByText('受取ウォレットに 3,465 JPYC 届いています')).toBeInTheDocument();
    expect(screen.getByText(/ブロック #123/)).toBeInTheDocument();
    expect(screen.getByText(/額と時刻で注文と照らし合わせてから発送してください/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Explorer で見る' });
    expect(link.getAttribute('href')).toContain(`/tx/${HASH}`);
    // 1 行の欄に貼った文は改行が落ちる。Tx Hash はその中から読み取る (lib/orderLinkVerify の extractTxHash)。
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'polygon', receiver: RECEIVER, text: expect.stringContaining(HASH) }),
    );
  });

  it('届いていない・見つからない・読み取れないときは、それぞれの理由を出す', async () => {
    render(<OrderLinkVerify chain="polygon" receiver={RECEIVER} />);
    check.mockResolvedValueOnce({ status: 'notToReceiver' });
    paste(HASH);
    expect(await screen.findByText(/受取ウォレット \(0x52d4…cA81\) に JPYC は届いていません/)).toBeInTheDocument();

    check.mockResolvedValueOnce({ status: 'notFound' });
    paste(`${HASH} `);
    expect(await screen.findByText(/では見つかりませんでした/)).toBeInTheDocument();

    check.mockResolvedValueOnce({ status: 'invalid' });
    paste('A-001 払いました');
    expect(await screen.findByText(/Tx Hash を読み取れません/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Explorer で見る' })).toBeNull();
  });

  it('貼り直すと前の結果を消す (別の取引の結果を残さない)', async () => {
    check.mockResolvedValue({ status: 'failed' });
    render(<OrderLinkVerify chain="polygon" receiver={RECEIVER} />);
    paste(HASH);
    expect(await screen.findByText(/この取引は失敗しています/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('お客様から届いた Tx Hash'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/この取引は失敗しています/)).toBeNull());
  });
});
