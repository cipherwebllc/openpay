// 「注文を送る / お店に知らせる」: 遠隔の注文の支払いの後、お客様自身の LINE やメールでお店に送る文を、このブラウザの中で
// 作って渡す (OpenPay のサーバーには送らない)。送る前に払ったウォレットで決まった文に署名してもらい (お金は動かない)、
// お店が「文を送った人が払った人か」を確かめられるようにする。署名できなかったときだけ署名せずに送れる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const signMessageAsync = vi.hoisted(() => vi.fn());
// wagmi の署名中 (isPending)。署名の要求が返らないときのテスト (D-6) だけ true にする。
const signState = vi.hoisted(() => ({ pending: false }));
const account = vi.hoisted(() => ({ address: undefined as string | undefined }));
const publicClient = vi.hoisted(() => ({ value: undefined as { verifyMessage: ReturnType<typeof vi.fn> } | undefined }));
vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync, isPending: signState.pending }),
  useAccount: () => ({ address: account.address }),
  usePublicClient: () => publicClient.value,
}));

import { renderWithIntl as render } from '../_helpers/i18n';
import {
  isRemoteOrderCheckout,
  notifyShopMessage,
  NotifyShopButton,
  type NotifyShopData,
} from '@/components/NotifyShopButton';
import en from '@/messages/en.json';
import ja from '@/messages/ja.json';
import { orderConfirmationMessage } from '@/lib/orderConfirmation';
import { lineMessageUrl } from '@/lib/shopContact';

const SHOP = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const SIG = `0x${'12'.repeat(65)}`;
let txSeq = 0;
// 署名はタブ (とページの記憶) に Tx Hash ごとに残るので、テストごとに別の Tx Hash を使う。
const nextTx = () => `0x${(++txSeq).toString(16).padStart(64, '0')}`;

function stubShare(share: ReturnType<typeof vi.fn> | undefined) {
  if (share) Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  else Reflect.deleteProperty(navigator, 'share');
}
function stubClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  if (writeText) Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  else Reflect.deleteProperty(navigator, 'clipboard');
}

beforeEach(() => {
  signMessageAsync.mockReset();
  signMessageAsync.mockResolvedValue(SIG);
  account.address = undefined;
  publicClient.value = undefined;
  signState.pending = false;
});
afterEach(() => {
  vi.useRealTimers();
  stubShare(undefined);
  stubClipboard(undefined);
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function data(patch: Partial<NotifyShopData> = {}): NotifyShopData {
  const txHash = patch.txHash ?? nextTx();
  return {
    orderNo: 'A-001',
    askShipping: false,
    items: [{ name: 'マグカップ', qty: 1 }],
    amountDisplay: '3,500 JPYC',
    explorerTxUrl: `https://polygonscan.com/tx/${txHash}`,
    chain: 'polygon',
    shop: SHOP,
    confirm: true,
    ...patch,
    txHash,
  };
}

describe('isRemoteOrderCheckout', () => {
  it('受付番号のある注文リンクと何度でも使える注文リンクだけ (店頭のモバイル注文・お店の端末・どちらも無いものは除く)', () => {
    expect(isRemoteOrderCheckout({ orderId: 'A-001' })).toBe(true);
    expect(isRemoteOrderCheckout({ ship: 'ask' })).toBe(true);
    expect(isRemoteOrderCheckout({})).toBe(false);
    expect(isRemoteOrderCheckout({ orderId: 'M-1', storeHandle: 'cafe' })).toBe(false);
    expect(isRemoteOrderCheckout({ ship: 'ask', storeHandle: 'cafe' })).toBe(false);
    expect(isRemoteOrderCheckout({ orderId: 'M-1', feeKind: 'storefront' })).toBe(false);
    expect(isRemoteOrderCheckout({ ship: 'ask', feeKind: 'preorder' })).toBe(false);
    expect(isRemoteOrderCheckout({ orderId: 'A-001', submit: 'store' })).toBe(false);
    expect(isRemoteOrderCheckout({ ship: 'ask', submit: 'store' })).toBe(false);
  });
});

describe('notifyShopMessage', () => {
  it('受付番号の一文・金額・Tx Hash・Explorer のリンクを行に分ける (リンクが無ければ省く)', () => {
    expect(notifyShopMessage({ intro: 'a', amountLine: 'b', txHash: '0x1', explorerTxUrl: 'u' })).toBe('a\nb\nTx Hash: 0x1\nu');
    expect(notifyShopMessage({ intro: 'a', amountLine: 'b', txHash: '0x1' })).toBe('a\nb\nTx Hash: 0x1');
  });

  it('お届け先を聞くときは空欄を頭に置き、署名は最後に置く (途中で切れても本文が残る)', () => {
    expect(
      notifyShopMessage({
        intro: 'i',
        fields: ['お名前：', 'お届け先：'],
        itemsLine: '商品: x',
        amountLine: 'b',
        txHash: '0x1',
        explorerTxUrl: 'u',
        signatureLine: '確認の署名: 0xs',
      }),
    ).toBe('i\nお名前：\nお届け先：\n\n商品: x\nb\nTx Hash: 0x1\nu\n確認の署名: 0xs');
  });
});

describe('NotifyShopButton (番号つきの注文)', () => {
  it('押すと払ったウォレットで決まった文に署名し、次に署名の入った文で共有を開く', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubShare(share);
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const d = data();
    render(<NotifyShopButton {...d} tone="panel" />);
    // 署名する前は「署名せずに送る」を出さない (払えたウォレットは署名もできる)
    expect(screen.queryByRole('button', { name: '署名せずに送る' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    await waitFor(() =>
      expect(signMessageAsync).toHaveBeenCalledWith({
        message: orderConfirmationMessage({ chain: 'polygon', shop: SHOP, txHash: d.txHash }),
      }),
    );
    expect(await screen.findByText('確認の署名ができました。お店に送ってください。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    const expected = [
      'ご注文 A-001 のお支払いが済みました。',
      '支払金額: 3,500 JPYC',
      `Tx Hash: ${d.txHash}`,
      d.explorerTxUrl,
      `確認の署名: ${SIG}`,
    ].join('\n');
    await waitFor(() => expect(share).toHaveBeenCalledWith({ text: expected }));
    expect(await screen.findByRole('status')).toHaveTextContent('共有しました');
  });

  it('署名を断ったら、もう一度押すか署名せずに送れる (署名の行の無い文になる)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    signMessageAsync.mockRejectedValueOnce(new Error('User rejected the request.'));
    const d = data();
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    expect(await screen.findByRole('status')).toHaveTextContent('署名できませんでした');
    fireEvent.click(screen.getByRole('button', { name: '署名せずに送る' }));
    expect(screen.getByText('署名なしで送ります。お店の確認に時間がかかることがあります。')).toBeInTheDocument();
    // 共有できない端末 (PC) では、主ボタンが文のコピーになる
    fireEvent.click(screen.getByRole('button', { name: '文をコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).not.toContain('確認の署名');
    expect(writeText.mock.calls[0][0]).toContain(`Tx Hash: ${d.txHash}`);
  });

  it('読み直した画面では、このタブに残した署名を使い、もう一度は求めない', async () => {
    const d = data();
    window.sessionStorage.setItem(`openpay:order-confirmation:v2:polygon:${SHOP.toLowerCase()}:${d.txHash}`, SIG);
    render(<NotifyShopButton {...d} tone="panel" />);
    expect(await screen.findByText('確認の署名ができました。お店に送ってください。')).toBeInTheDocument();
    expect(signMessageAsync).not.toHaveBeenCalled();
  });

  it('払ったウォレットで署名してもらい、別のウォレットに切り替えていたら署名させずに案内する', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const d = data({ payer: payer.address });
    signMessageAsync.mockImplementation(async ({ message }: { message: string }) => payer.signMessage({ message }));
    account.address = '0x9999999999999999999999999999999999999999';
    const { unmount } = render(<NotifyShopButton {...d} tone="panel" />);
    expect(screen.getByRole('button', { name: 'お店に知らせる' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/支払いに使ったウォレット \(0x.{4}….{4}\) に切り替えると署名できます/);
    expect(screen.getByRole('button', { name: '署名せずに送る' })).toBeInTheDocument();
    unmount();
    account.address = payer.address;
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    await waitFor(() =>
      expect(signMessageAsync).toHaveBeenCalledWith({
        message: orderConfirmationMessage({ chain: 'polygon', shop: SHOP, txHash: d.txHash }),
        account: payer.address,
      }),
    );
    expect(await screen.findByText('確認の署名ができました。お店に送ってください。')).toBeInTheDocument();
  });

  it('払ったウォレットと違う署名が返ってきたら残さず、署名できなかったと伝える', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const d = data({ payer: payer.address });
    account.address = payer.address;
    publicClient.value = { verifyMessage: vi.fn(async () => false) };
    signMessageAsync.mockImplementation(async ({ message }: { message: string }) => other.signMessage({ message }));
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    expect(await screen.findByRole('status')).toHaveTextContent('署名できませんでした');
    expect(screen.queryByText('確認の署名ができました。お店に送ってください。')).toBeNull();
  });

  it('払ったのがコントラクトのウォレットなら、持ち主の署名を ERC-1271 で確かめて残す', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const contractWallet = '0x6666666666666666666666666666666666666666' as Address;
    const d = data({ payer: contractWallet });
    account.address = contractWallet;
    publicClient.value = { verifyMessage: vi.fn(async () => true) };
    signMessageAsync.mockImplementation(async ({ message }: { message: string }) => owner.signMessage({ message }));
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    expect(await screen.findByText('確認の署名ができました。お店に送ってください。')).toBeInTheDocument();
    expect(publicClient.value.verifyMessage).toHaveBeenCalledWith(expect.objectContaining({ address: contractWallet }));
  });

  it('ウォレットが短縮形 (EIP-2098) の署名を返しても、払ったウォレットの署名として残す', async () => {
    const { parseSignature, serializeCompactSignature, signatureToCompactSignature } = await import('viem');
    const payer = privateKeyToAccount(generatePrivateKey());
    const d = data({ payer: payer.address });
    account.address = payer.address;
    publicClient.value = { verifyMessage: vi.fn(async () => false) };
    signMessageAsync.mockImplementation(async ({ message }: { message: string }) =>
      serializeCompactSignature(signatureToCompactSignature(parseSignature(await payer.signMessage({ message })))),
    );
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    expect(await screen.findByText('確認の署名ができました。お店に送ってください。')).toBeInTheDocument();
  });

  it('お店が確かめられない支払い (JPYC 以外) では署名を求めず、そのまま送れる', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const d = data({ confirm: false });
    render(<NotifyShopButton {...d} tone="panel" />);
    expect(screen.queryByText(/確認の署名/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '文をコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).not.toContain('確認の署名');
    expect(signMessageAsync).not.toHaveBeenCalled();
  });

  it('コピーもできないときは、文を選んで写せる欄を見出しつきで出す', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const d = data();
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    fireEvent.click(await screen.findByRole('button', { name: '文をコピー' }));
    const box = await screen.findByLabelText('お店に送る文 (選んでコピーしてください)');
    expect((box as HTMLTextAreaElement).value).toContain(`確認の署名: ${SIG}`);
  });
});

describe('NotifyShopButton (何度でも使えるリンク・お届け先を聞く)', () => {
  it('送り先の LINE 公式アカウントを見せ、署名の後は文の入ったトークを開くリンクにする', async () => {
    const d = data({
      orderNo: undefined,
      askShipping: true,
      storeName: 'OpenPay 工房',
      items: [{ name: 'マグカップ', qty: 2 }, { name: '送料', qty: 1 }],
      contact: { kind: 'line', id: '@openpay' },
    });
    render(<NotifyShopButton {...d} tone="overlay" />);
    expect(screen.getByText('送り先: LINE @openpay')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '注文を送る' }));
    const link = await screen.findByRole('link', { name: 'LINE で送る' });
    const text = [
      'OpenPay 工房 に注文します。',
      'お名前：',
      'お届け先（デジタルアドレスか住所）：',
      '',
      '商品: マグカップ × 2 / 送料 × 1',
      '支払金額: 3,500 JPYC',
      `Tx Hash: ${d.txHash}`,
      d.explorerTxUrl,
      `確認の署名: ${SIG}`,
    ].join('\n');
    expect(link).toHaveAttribute('href', lineMessageUrl('@openpay', text));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('お名前とお届け先を書き足してから送ってください。OpenPay には届きません。')).toBeInTheDocument();
  });

  it('送り先がメールなら、件名に頭の一文を入れたメールを開くリンクにする (店名が無ければ「注文します。」)', async () => {
    const d = data({ orderNo: undefined, askShipping: true, contact: { kind: 'mail', address: 'shop@example.com' } });
    render(<NotifyShopButton {...d} tone="panel" />);
    fireEvent.click(screen.getByRole('button', { name: '注文を送る' }));
    const link = await screen.findByRole('link', { name: 'メールで送る' });
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith(`mailto:shop@example.com?subject=${encodeURIComponent('注文します。')}&body=`)).toBe(true);
    expect(decodeURIComponent(href.split('&body=')[1])).toContain('お名前：\r\nお届け先（デジタルアドレスか住所）：');
  });
});

// 第 9 回レビュー D-6: signMessageAsync には時間切れが無い。署名の要求がウォレットに届かない (WalletConnect 等) と
// resolve も reject もせず「署名しています…」のまま主ボタンが押せない。20 秒待ったら署名せずに送る道も出す。
// 時間は実装の定数から取らずにここに書く (実装の値を変えたら、このテストも見直す)。
const SLOW_MS = 20_000;

describe('NotifyShopButton (署名の要求が返らない)', () => {
  type Pending = { resolve: (signature: string) => void; reject: (error: Error) => void };
  // 主ボタンを押して署名の要求を出し、返さないまま待つ。wagmi は要求を出すと isPending を true にして描き直す。
  function startSigning(d: NotifyShopData, view: ReturnType<typeof render>): Pending {
    const pending: Pending = { resolve: () => {}, reject: () => {} };
    signMessageAsync.mockImplementationOnce(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.resolve = resolve;
          pending.reject = reject;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'お店に知らせる' }));
    signState.pending = true;
    view.rerender(<NotifyShopButton {...d} tone="panel" />);
    return pending;
  }
  // 署名の要求が返った (断った): wagmi は isPending を false にして描き直す。
  async function rejectSigning(pending: Pending, d: NotifyShopData, view: ReturnType<typeof render>) {
    await act(async () => {
      pending.reject(new Error('User rejected the request.'));
    });
    signState.pending = false;
    view.rerender(<NotifyShopButton {...d} tone="panel" />);
  }
  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }
  const withoutSign = () => screen.queryAllByRole('button', { name: '署名せずに送る' });

  it('署名の要求が 20 秒返らなければ、「署名しています…」のまま「署名せずに送る」も出す', () => {
    vi.useFakeTimers();
    signState.pending = true;
    render(<NotifyShopButton {...data()} tone="panel" />);
    expect(screen.getByRole('button', { name: 'ウォレットで署名しています…' })).toBeDisabled();
    advance(SLOW_MS - 1);
    expect(withoutSign()).toHaveLength(0);
    advance(1);
    expect(withoutSign()).toHaveLength(1);
    // 失敗ではないので「署名できませんでした」は出さず、主ボタンは署名中のまま
    expect(screen.queryByText(/署名できませんでした/)).toBeNull();
    expect(screen.getByRole('button', { name: 'ウォレットで署名しています…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '署名せずに送る' }));
    expect(screen.getByText('署名なしで送ります。お店の確認に時間がかかることがあります。')).toBeInTheDocument();
  });

  it('署名の要求は取り消さない: 署名せずに進んだ後に署名が返れば、署名の入った文になる', async () => {
    vi.useFakeTimers();
    const d = data();
    const view = render(<NotifyShopButton {...d} tone="panel" />);
    const pending = startSigning(d, view);
    expect(signMessageAsync).toHaveBeenCalledTimes(1);
    advance(SLOW_MS);
    fireEvent.click(screen.getByRole('button', { name: '署名せずに送る' }));
    expect(screen.getByText('署名なしで送ります。お店の確認に時間がかかることがあります。')).toBeInTheDocument();
    // 時間切れで要求を出し直さない
    expect(signMessageAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(SIG);
    });
    signState.pending = false;
    view.rerender(<NotifyShopButton {...d} tone="panel" />);
    expect(screen.getByText('確認の署名ができました。お店に送ってください。')).toBeInTheDocument();
  });

  it('待っている間に画面を閉じたら、20 秒のタイマーを残さない', () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    signState.pending = true;
    const view = render(<NotifyShopButton {...data()} tone="panel" />);
    expect(vi.getTimerCount()).toBe(before + 1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('20 秒より前に返って (断って) 押し直したら、押し直してから 20 秒を数え直す (前の回の時間を持ち越さない)', async () => {
    vi.useFakeTimers();
    const d = data();
    const view = render(<NotifyShopButton {...d} tone="panel" />);
    const first = startSigning(d, view);
    advance(10_000);
    await rejectSigning(first, d, view);
    expect(screen.getByRole('status')).toHaveTextContent('署名できませんでした');
    startSigning(d, view);
    // 最初の要求から 20 秒を過ぎても、押し直してからはまだ 10 秒
    advance(10_001);
    expect(withoutSign()).toHaveLength(0);
    advance(SLOW_MS - 10_001);
    expect(withoutSign()).toHaveLength(1);
  });

  it('20 秒を過ぎてから返って (断って) 押し直したら、また 20 秒待つまで「署名せずに送る」を出さない', async () => {
    vi.useFakeTimers();
    const d = data();
    const view = render(<NotifyShopButton {...d} tone="panel" />);
    const first = startSigning(d, view);
    advance(SLOW_MS);
    expect(withoutSign()).toHaveLength(1);
    await rejectSigning(first, d, view);
    // 断ったときは今までどおり「署名できませんでした」と一緒に 1 つだけ
    expect(screen.getByRole('status')).toHaveTextContent('署名できませんでした');
    expect(withoutSign()).toHaveLength(1);
    startSigning(d, view);
    expect(withoutSign()).toHaveLength(0);
    advance(SLOW_MS - 1);
    expect(withoutSign()).toHaveLength(0);
    advance(1);
    expect(withoutSign()).toHaveLength(1);
  });
});

// 第 9 回レビュー D-2・D-5: お客様への案内の文が指すボタンの名前。注文リンクの共有文と払う前の案内は、完了画面で最初に
// 押すボタン (署名の前の名前) と同じ名前を指す: 番号つき =「お店に知らせる」・何度でも使える (ship=ask) =「注文を送る」。
// 払い済みの案内 (読み直した画面) は、上の欄のボタンの名前が状態で変わる (署名の後・JPYC 以外は「送る」「文をコピー」等) ので、
// どのボタンの名前も書かない。
describe('案内の文が指すボタンの名前', () => {
  it.each([
    ['ja', ja, (label: string) => `「${label}」`],
    ['en', en, (label: string) => `“${label}”`],
  ] as const)('%s: 共有文はボタンと同じ名前を指し、払い済みの案内はボタンの名前を書かない', (_locale, messages, quote) => {
    const buttons = messages.SuccessOverlay;
    expect(messages.OrderLinkBuilder.shareText).toContain(quote(buttons.notifyShop));
    expect(messages.OrderLinkBuilder.shareTextReusable).toContain(quote(buttons.sendOrder));
    expect(messages.CheckoutForm.shipAskNote).toContain(quote(buttons.sendOrder));
    expect(messages.CheckoutForm.shipAskNoteWithContact).toContain(quote(buttons.sendOrder));
    for (const label of [
      buttons.notifyShop,
      buttons.sendOrder,
      buttons.send,
      buttons.notifyShopCopy,
      buttons.sendByLine,
      buttons.sendByMail,
      buttons.sendOther,
      buttons.sendWithoutSign,
    ]) {
      expect(messages.CheckoutForm.paidInThisTabNote).not.toContain(quote(label));
    }
  });
});
