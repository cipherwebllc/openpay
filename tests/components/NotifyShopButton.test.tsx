// 「注文を送る / お店に知らせる」: 遠隔の注文の支払いの後、お客様自身の LINE やメールでお店に送る文を、このブラウザの中で
// 作って渡す (OpenPay のサーバーには送らない)。送る前に払ったウォレットで決まった文に署名してもらい (お金は動かない)、
// お店が「文を送った人が払った人か」を確かめられるようにする。署名できなかったときだけ署名せずに送れる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const signMessageAsync = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => ({ address: undefined as string | undefined }));
const publicClient = vi.hoisted(() => ({ value: undefined as { verifyMessage: ReturnType<typeof vi.fn> } | undefined }));
vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync, isPending: false }),
  useAccount: () => ({ address: account.address }),
  usePublicClient: () => publicClient.value,
}));

import { renderWithIntl as render } from '../_helpers/i18n';
import { isRemoteOrderCheckout, notifyShopMessage, NotifyShopButton, type NotifyShopData } from '@/components/NotifyShopButton';
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
});
afterEach(() => {
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
