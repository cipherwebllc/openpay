// 注文リンクの「入金を確かめる」の画面: 結果ごとの文と、Explorer のリンク。チェーンを読む部分は lib のテストが見る。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertTriangle, CheckCircle2, ShieldAlert, type LucideIcon } from 'lucide-react';
import type { Address } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';

const check = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orderLinkVerify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orderLinkVerify')>();
  return { ...actual, checkOrderLinkPaymentOnChains: check };
});

import { OrderLinkVerify } from '@/components/order-link/OrderLinkVerify';

const RECEIVER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
// 受け付けるチェーンを全部探した結果 (lib/orderLinkVerify の checkOrderLinkPaymentOnChains) の形にする。
const found = (result: Record<string, unknown>, chain: string | null = 'polygon', unreachable: string[] = []) => ({
  chain: result.status === 'notFound' || result.status === 'error' || result.status === 'invalid' ? null : chain,
  result,
  unreachable,
});
const HASH = `0x${'ab'.repeat(32)}`;

afterEach(() => {
  check.mockReset();
  localStorage.clear();
});

function paste(text: string) {
  fireEvent.change(screen.getByLabelText('お客様から届いた文か Tx Hash'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
}

function edit(text: string) {
  fireEvent.change(screen.getByLabelText('お客様から届いた文か Tx Hash'), { target: { value: text } });
}

// 応答を後から返す (RPC が走っている間に入力が変わる場面を作る)。
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function resolveWith<T>(pending: { resolve: (value: T) => void }, value: T) {
  await act(async () => {
    pending.resolve(value);
  });
}

const paidResult = (received: string, confirmation: string) => ({
  status: 'paid',
  received,
  blockNumber: 123n,
  timestamp: 1_762_000_000,
  payer: confirmation === 'unsigned' ? null : ('0x4444444444444444444444444444444444444444' as Address),
  confirmation,
});

// lucide の版でアイコンの class 名が変わっても追えるよう、アイコンそのものを描いて class を取る。
function iconClass(Icon: LucideIcon) {
  const match = renderToStaticMarkup(createElement(Icon)).match(/\blucide-[a-z0-9-]+/);
  if (!match) throw new Error('lucide icon class not found');
  return match[0];
}

const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const OTHER_RECEIVER = '0x1111111111111111111111111111111111111111' as Address;
const CHECKED_KEY = 'openpay:order-link-checked:v1';

describe('OrderLinkVerify', () => {
  it('受取ウォレットが無いか、何も貼っていなければ押せない', () => {
    const { unmount } = render(<OrderLinkVerify chains={["polygon"]} receiver={null} />);
    fireEvent.change(screen.getByLabelText('お客様から届いた文か Tx Hash'), { target: { value: HASH } });
    expect(screen.getByRole('button', { name: '確かめる' })).toBeDisabled();
    unmount();
    render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    expect(screen.getByRole('button', { name: '確かめる' })).toBeDisabled();
  });

  it('届いていれば額・ブロック・照らし合わせの注意と Explorer のリンクを出す', async () => {
    check.mockResolvedValue(found({
      status: 'paid',
      received: '3465',
      blockNumber: 123n,
      timestamp: 1_762_000_000,
      payer: null,
      confirmation: 'unsigned',
    }));
    render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    paste(`ご注文 A-001 のお支払いが済みました。\nTx Hash: ${HASH}`);
    expect(await screen.findByText('受取ウォレットに 3,465 JPYC 届いています')).toBeInTheDocument();
    // 署名の無い文は、払った本人からか分からないと伝える
    expect(screen.getByText(/確認の署名がありません/)).toBeInTheDocument();
    expect(screen.getByText(/ブロック #123/)).toBeInTheDocument();
    expect(screen.getByText(/額と時刻で注文と照らし合わせてから発送してください/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Explorer で見る' });
    expect(link.getAttribute('href')).toContain(`/tx/${HASH}`);
    // 1 行の欄に貼った文は改行が落ちる。Tx Hash はその中から読み取る (lib/orderLinkVerify の extractTxHash)。
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ chains: ['polygon'], receiver: RECEIVER, text: expect.stringContaining(HASH) }),
    );
  });

  it('払ったウォレットの署名なら払った人の短いアドレスを、他人の署名なら発送を止める案内を出す', async () => {
    const payer = '0x4444444444444444444444444444444444444444' as Address;
    const paid = { status: 'paid', received: '3465', blockNumber: 123n, timestamp: 1_762_000_000, payer };
    const { unmount } = render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    check.mockResolvedValueOnce(found({ ...paid, confirmation: 'verified' }));
    paste(HASH);
    expect(await screen.findByText('払ったウォレット (0x4444…4444) の確認の署名があります')).toBeInTheDocument();
    unmount();
    localStorage.clear();
    render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    check.mockResolvedValueOnce(found({ ...paid, confirmation: 'mismatch' }));
    paste(HASH);
    expect(await screen.findByText(/この支払いをしたウォレットの署名ではありません/)).toBeInTheDocument();
    expect(screen.queryByText(/の確認の署名があります/)).toBeNull();
  });

  it('届いていない・見つからない・読み取れないときは、それぞれの理由を出す', async () => {
    render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    check.mockResolvedValueOnce(found({ status: 'notToReceiver' }));
    paste(HASH);
    expect(await screen.findByText(/受取ウォレット \(0x52d4…cA81\) に JPYC は届いていません/)).toBeInTheDocument();

    check.mockResolvedValueOnce(found({ status: 'notFound' }));
    paste(`${HASH} `);
    expect(await screen.findByText(/では見つかりませんでした/)).toBeInTheDocument();

    check.mockResolvedValueOnce(found({ status: 'invalid' }));
    paste('A-001 払いました');
    expect(await screen.findByText(/Tx Hash を読み取れません/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Explorer で見る' })).toBeNull();
  });

  it('同じ Tx Hash を 2 回目に確かめると、使い回しへの注意を出す (この端末で前に確かめた時刻つき)', async () => {
    check.mockResolvedValue(found({
      status: 'paid',
      received: '3465',
      blockNumber: 123n,
      timestamp: 1_762_000_000,
      payer: null,
      confirmation: 'unsigned',
    }));
    render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    paste(HASH);
    expect(await screen.findByText('受取ウォレットに 3,465 JPYC 届いています')).toBeInTheDocument();
    expect(screen.queryByText(/にも確かめています/)).toBeNull();
    paste(`Tx Hash: ${HASH}`);
    expect(await screen.findByText(/にも確かめています。同じ支払いで 2 つの注文を発送しないよう/)).toBeInTheDocument();
  });

  it('受取チェーンが複数なら、見つかったチェーンを出し、問い合わせできなかったチェーンは「確かめられない」と伝える', async () => {
    const { unmount } = render(<OrderLinkVerify chains={['polygon', 'kaia']} receiver={RECEIVER} />);
    check.mockResolvedValueOnce(
      found(
        { status: 'paid', received: '3465', blockNumber: 123n, timestamp: 1_762_000_000, payer: null, confirmation: 'unsigned' },
        'kaia',
      ),
    );
    paste(HASH);
    expect(await screen.findByText(/で払われています/)).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ chains: ['polygon', 'kaia'] }));
    unmount();
    localStorage.clear();
    render(<OrderLinkVerify chains={['polygon', 'kaia']} receiver={RECEIVER} />);
    check.mockResolvedValueOnce(found({ status: 'error' }, null, ['kaia']));
    paste(HASH);
    expect(await screen.findByText(/に問い合わせできませんでした/)).toBeInTheDocument();
  });

  it('貼り直すと前の結果を消す (別の取引の結果を残さない)', async () => {
    check.mockResolvedValue(found({ status: 'failed' }));
    render(<OrderLinkVerify chains={["polygon"]} receiver={RECEIVER} />);
    paste(HASH);
    expect(await screen.findByText(/この取引は失敗しています/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('お客様から届いた文か Tx Hash'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/この取引は失敗しています/)).toBeNull());
  });
});

// 第 9 回レビュー G-2: 確かめている間に入力が変わったら、遅れて届いた応答を今の欄の結果として出さない
// (客 A の支払い済みの Tx Hash の応答が、客 B の未払いの Tx Hash に書き換えた欄の下に「届いています」と出ると、B に発送してしまう)。
describe('OrderLinkVerify: 確かめている間に入力が変わったとき', () => {
  type Found = ReturnType<typeof found>;
  const PAID_3465 = '受取ウォレットに 3,465 JPYC 届いています';

  it('欄を別の Tx Hash に書き換えたら、前の応答の「届いています」を出さず、この端末の記録にも残さない', async () => {
    const first = deferred<Found>();
    check.mockReturnValueOnce(first.promise);
    render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    expect(screen.getByRole('button', { name: '確かめています…' })).toBeDisabled();
    edit(OTHER_HASH);
    // 前の応答を待たずに、書き換えた Tx Hash をすぐ確かめられる
    expect(screen.getByRole('button', { name: '確かめる' })).toBeEnabled();
    await resolveWith(first, found(paidResult('3465', 'verified')));
    expect(screen.queryByText(/JPYC 届いています/)).toBeNull();
    expect(screen.queryByText(/の確認の署名があります/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Explorer で見る' })).toBeNull();
    expect(localStorage.getItem(CHECKED_KEY)).toBeNull();
  });

  it('書き換えて元の Tx Hash に戻し、もう一度確かめたら、前に押した分の応答は捨てて新しい応答だけを出す', async () => {
    const first = deferred<Found>();
    const second = deferred<Found>();
    check.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    edit(OTHER_HASH);
    paste(HASH);
    expect(check).toHaveBeenCalledTimes(2);
    // 欄は同じ Tx Hash でも、1 回目の応答は前に押した分なので出さない (通し番号で捨てる)
    await resolveWith(first, found(paidResult('3465', 'verified')));
    expect(screen.queryByText(/JPYC 届いています/)).toBeNull();
    expect(screen.getByRole('button', { name: '確かめています…' })).toBeDisabled();
    await resolveWith(second, found(paidResult('1000', 'verified')));
    expect(screen.getByText('受取ウォレットに 1,000 JPYC 届いています')).toBeInTheDocument();
    // 捨てた 1 回目は記録していないので、使い回しの注意も出ない
    expect(screen.queryByText(/にも確かめています/)).toBeNull();
  });

  it('受取ウォレットが変わったら前の応答は出さない (名前の解決中を挟んで同じアドレスに戻っても出さない)', async () => {
    const first = deferred<Found>();
    const second = deferred<Found>();
    check.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    rerender(<OrderLinkVerify chains={['polygon']} receiver={OTHER_RECEIVER} />);
    expect(screen.getByRole('button', { name: '確かめる' })).toBeEnabled();
    await resolveWith(first, found(paidResult('3465', 'verified')));
    expect(screen.queryByText(/JPYC 届いています/)).toBeNull();

    rerender(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    rerender(<OrderLinkVerify chains={['polygon']} receiver={null} />);
    rerender(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    await resolveWith(second, found(paidResult('3465', 'verified')));
    expect(screen.queryByText(/JPYC 届いています/)).toBeNull();
    expect(localStorage.getItem(CHECKED_KEY)).toBeNull();
  });

  it('受取チェーンが変わったら前の応答は出さない。同じ内容の配列で描き直しただけなら出す', async () => {
    const first = deferred<Found>();
    const second = deferred<Found>();
    const third = deferred<Found>();
    check
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { rerender } = render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    rerender(<OrderLinkVerify chains={['polygon', 'kaia']} receiver={RECEIVER} />);
    await resolveWith(first, found(paidResult('3465', 'verified')));
    expect(screen.queryByText(/JPYC 届いています/)).toBeNull();

    // 行って戻っても、間に走っていた応答は出さない
    fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    rerender(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    rerender(<OrderLinkVerify chains={['polygon', 'kaia']} receiver={RECEIVER} />);
    await resolveWith(second, found(paidResult('3465', 'verified'), 'kaia'));
    expect(screen.queryByText(/JPYC 届いています/)).toBeNull();

    // 設定の読み込み直しなどで同じ内容の新しい配列が来ても、確かめている途中の応答は捨てない
    fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    rerender(<OrderLinkVerify chains={['polygon', 'kaia']} receiver={RECEIVER} />);
    await resolveWith(third, found(paidResult('3465', 'verified'), 'kaia'));
    expect(screen.getByText(PAID_3465)).toBeInTheDocument();
  });

  it('確かめている間に欄が消えたら (別のタブへ移る等)、後から届いた応答をこの端末の記録に残さない', async () => {
    const first = deferred<Found>();
    check.mockReturnValueOnce(first.promise).mockResolvedValueOnce(found(paidResult('3465', 'verified')));
    const { unmount } = render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    unmount();
    await resolveWith(first, found(paidResult('3465', 'verified')));
    expect(localStorage.getItem(CHECKED_KEY)).toBeNull();
    // 戻って同じ取引を確かめても、見せていない結果を「前にも確かめた」にしない
    render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    expect(await screen.findByText(PAID_3465)).toBeInTheDocument();
    expect(screen.queryByText(/にも確かめています/)).toBeNull();
  });

  it('出ている結果は、受取ウォレットかチェーンが変わったら消す', async () => {
    check.mockResolvedValue(found(paidResult('3465', 'verified')));
    const { rerender } = render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    expect(await screen.findByText(PAID_3465)).toBeInTheDocument();
    rerender(<OrderLinkVerify chains={['polygon']} receiver={OTHER_RECEIVER} />);
    expect(screen.queryByText(PAID_3465)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    expect(await screen.findByText(PAID_3465)).toBeInTheDocument();
    rerender(<OrderLinkVerify chains={['polygon', 'kaia']} receiver={OTHER_RECEIVER} />);
    expect(screen.queryByText(PAID_3465)).toBeNull();
  });
});

// 第 9 回レビュー E-5: 緑のカードとチェックは、払ったウォレットの確認の署名が確かめられた支払いだけに出す。
// 他人の Tx Hash を署名なしで貼られても、大きな緑のチェックの下の小さな注意だけにしない。
describe('OrderLinkVerify: 届いた支払いのカードの色', () => {
  async function paidCard(confirmation: string) {
    check.mockResolvedValue(found(paidResult('3465', confirmation)));
    const { container } = render(<OrderLinkVerify chains={['polygon']} receiver={RECEIVER} />);
    paste(HASH);
    const headline = await screen.findByText('受取ウォレットに 3,465 JPYC 届いています');
    const card = headline.closest('.rounded-xl') as HTMLElement;
    const region = container.querySelector('[aria-live="polite"]') as HTMLElement;
    return { card, region, icon: card.firstElementChild?.getAttribute('class') ?? '' };
  }

  it.each([
    ['mismatch', 'bg-rose-50', ShieldAlert],
    ['unverifiable', 'bg-rose-50', ShieldAlert],
    ['unsigned', 'bg-amber-50', AlertTriangle],
  ] as const)('確認の署名が %s なら、緑のカードとチェックを出さず警告の色とアイコンにする', async (confirmation, bg, Icon) => {
    const { card, region, icon } = await paidCard(confirmation);
    expect(card.className).toContain(bg);
    expect(region.innerHTML).not.toMatch(/emerald/);
    expect(region.querySelector(`svg.${iconClass(CheckCircle2)}`)).toBeNull();
    expect(icon).toContain(iconClass(Icon));
  });

  it('払ったウォレットの署名が確かめられたら、これまでどおり緑のカードとチェックを出す', async () => {
    const { card, icon } = await paidCard('verified');
    expect(card.className).toContain('bg-emerald-50');
    expect(icon).toContain(iconClass(CheckCircle2));
  });
});
