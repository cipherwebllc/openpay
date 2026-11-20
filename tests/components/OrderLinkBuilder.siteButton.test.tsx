// 「何度でも使える」リンクの「サイトにボタンを設置」(components/order-link/OrderLinkSiteButton.tsx・2026-11-20 運営者の裁定)。
// 固定するもの:
// - 何度でも使えるリンクができたときだけ出し、「この注文だけ」に切り替えると DOM から消える (この注文だけの画面は今のまま)
// - WordPress 用にコピーする URL・HTML の見本の <a> の href・コピーした HTML の <a> の href が、すべて注文リンクの URL と同じ
//   (その URL を /checkout の parser で読むと同じ明細と合計)・作り直した後は最新の URL
// - 見本はコピーする HTML と同じ文字列で描く・& " < > を含む値でも HTML が壊れない
// - コピーの成功の表示・失敗やコピーできない環境で手で写せる欄
// 既存のふるまい (番号・共有・コピー) は tests/components/OrderLinkBuilder.test.tsx が固定している (このファイルでは変えない)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

const resolved = vi.hoisted(() => ({
  value: { data: null as { address: string } | null, isFetching: false, error: null as Error | null },
}));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => resolved.value),
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return {
    ...actual,
    jpycForwarderFor: () => '0x0F4560a777415580F0680F8B56a79B0022C6B848',
    relayGasFeeValue: () => 2n * 10n ** 18n,
  };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, recoverFeeBps: 100, enableJpycEip3009: true } };
});
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
vi.mock('@/hooks/useReceiverChainCheck', () => ({ useReceiverChainCheck: () => ({ status: 'idle' }) }));
vi.mock('@/lib/orderLinkVerify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orderLinkVerify')>();
  return { ...actual, checkOrderLinkPaymentOnChains: vi.fn() };
});

import { OrderLinkBuilder } from '@/components/OrderLinkBuilder';
import { calcCheckoutPayable, parseCheckoutParams } from '@/lib/url/checkout';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const STORAGE_KEY = 'openpay:order-link-settings:v1';
const TITLE = 'サイトにボタンを設置';

function saved(patch: Record<string, unknown> = {}) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ receiver: TO, receiverSource: 'manual', chain: 'polygon', payMode: 'gasless', shipping: '', lastOrderId: '', ...patch }),
  );
}

function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

function fillItem(name = 'Tシャツ M') {
  fireEvent.change(screen.getByLabelText('商品名'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
  fireEvent.change(screen.getByLabelText('送料'), { target: { value: '500' } });
}

/** 注文リンクの URL (「開いて確かめる」のリンク先)。 */
function orderLinkUrl(): string {
  return screen.getByRole('link', { name: '開いて確かめる' }).getAttribute('href') ?? '';
}

/** 「サイトにボタンを設置」の欄 (折りたたみ)。開いて返す。 */
async function openSiteButton(): Promise<HTMLElement> {
  const summary = await screen.findByText(TITLE);
  const details = summary.closest('details') as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary);
  // クリックで実際に開いたことを確かめる (代入で開くと、クリックが効かない退行を見逃す)。
  expect(details.open).toBe(true);
  return details;
}

function parseHtml(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

/** コピーした HTML を別の document に入れて、ただ 1 つの <a> を取り出す。 */
function anchorOf(html: string): HTMLAnchorElement {
  const content = parseHtml(html);
  const elements = content.querySelectorAll('*');
  expect(elements).toHaveLength(1);
  expect(elements[0].tagName).toBe('A');
  return elements[0] as HTMLAnchorElement;
}

function previewOf(panel: HTMLElement): HTMLElement {
  return panel.querySelector('[data-site-button-preview]') as HTMLElement;
}

async function startReusable(patch: Record<string, unknown> = {}) {
  saved({ linkKind: 'reusable', ...patch });
  render(<OrderLinkBuilder />);
  await screen.findByRole('button', { name: '設定' });
}

beforeEach(() => {
  localStorage.clear();
  resolved.value = { data: null, isFetching: false, error: null };
  vi.stubGlobal('fetch', vi.fn());
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('注文リンク: サイトにボタンを設置', () => {
  it('「この注文だけ」では出さず、「何度でも使える」でリンクができたときだけ出し、戻すと DOM から消える', async () => {
    saved();
    stubClipboard();
    const { container } = render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    expect(screen.queryByText(TITLE)).toBeNull();
    const singleHtml = container.innerHTML;

    // 何度でも使える: 商品が入るまでは (リンクができるまでは) 出さない
    fireEvent.click(screen.getByRole('button', { name: '何度でも使える' }));
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull());
    expect(screen.queryByText(TITLE)).toBeNull();
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
    await openSiteButton();
    expect(screen.getByRole('button', { name: 'ボタン用URLをコピー' })).toBeInTheDocument();

    // この注文だけに戻すと、設置の操作は DOM から消え、この注文だけの画面は切り替える前と同じ
    fireEvent.click(screen.getByRole('button', { name: 'この注文だけ' }));
    await screen.findByText('受付番号 #A-001');
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'ボタン用URLをコピー' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'HTMLをコピー' })).toBeNull();
    expect(container.querySelector('[data-site-button-preview]')).toBeNull();
    expect(container.innerHTML).toBe(singleHtml);
  });

  it('WordPress 用にコピーする URL・見本の href・コピーした HTML の href は同じ注文リンクで、/checkout で同じ明細と合計になる', async () => {
    const writeText = stubClipboard();
    await startReusable();
    fillItem();
    const panel = await openSiteButton();
    const url = orderLinkUrl();
    expect(new URL(url).searchParams.get('ship')).toBe('ask');

    // WordPress (最初に開く方): 案内の文と、ボタン用URLのコピー
    expect(within(panel).getByRole('button', { name: 'WordPress に設置' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(panel).getByText(
        '例えばブロックエディターなら、商品ページに「ボタン」ブロックを追加し、文字を「JPYCで支払う」にして、コピーした URL をリンク先に貼り付けます。専用のプラグインや HTML の編集は要りません。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'ボタン用URLをコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedUrl = writeText.mock.calls[0][0] as string;
    expect(await within(panel).findByText('コピーしました')).toBeInTheDocument();

    // HTML: 見本とコピー
    fireEvent.click(within(panel).getByRole('button', { name: 'HTML で設置' }));
    expect(within(panel).queryByText('コピーしました')).toBeNull();
    const preview = previewOf(panel);
    const previewAnchor = within(preview).getByRole('link', { name: 'JPYCで支払う' });
    fireEvent.click(within(panel).getByRole('button', { name: 'HTMLをコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const copiedHtml = writeText.mock.calls[1][0] as string;
    expect(await within(panel).findByText('コピーしました')).toBeInTheDocument();
    const copiedAnchor = anchorOf(copiedHtml);

    // すべて同じ (= 注文リンクの URL)
    expect(copiedUrl).toBe(url);
    expect(previewAnchor.getAttribute('href')).toBe(url);
    expect(copiedAnchor.getAttribute('href')).toBe(url);
    // 見本はコピーする HTML と同じ文字列で描く・手で写す欄も同じ文字列
    expect(preview.innerHTML).toBe(parseHtmlInnerHtml(copiedHtml));
    expect(within(panel).getByLabelText('ボタンのHTML')).toHaveValue(copiedHtml);
    expect(copiedAnchor.getAttribute('target')).toBe('_blank');
    expect(copiedAnchor.getAttribute('rel')).toBe('noopener');
    expect(copiedHtml).not.toMatch(/<script|<iframe|<style|<link|class=/i);

    const parsed = parseCheckoutParams(new URL(copiedAnchor.getAttribute('href') ?? '').searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.items).toEqual([
      { name: 'Tシャツ M', qty: 2, price: '3000' },
      { name: '送料', qty: 1, price: '500' },
    ]);
    expect(calcCheckoutPayable(parsed.params, 18)).toBe(6_500n * 10n ** 18n);
    expect(screen.getAllByText('6,500 JPYC').length).toBeGreaterThan(0);

    // ここでのコピーは「リンクを送った」ことにしない (注文の画面の主ボタンは「リンクをコピー」のまま)
    expect(screen.queryByRole('button', { name: '次の注文へ' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
    expect(writeText.mock.calls[2][0]).toBe(url);
    expect((await screen.findAllByRole('button', { name: '次の注文へ' })).length).toBeGreaterThan(0);
  });

  it('商品や送料を変えてリンクが作り直されたら、コピーする URL と HTML は新しいリンクを指し、前のコピーの表示は消える', async () => {
    const writeText = stubClipboard();
    await startReusable();
    fillItem();
    const panel = await openSiteButton();
    const before = orderLinkUrl();
    fireEvent.click(within(panel).getByRole('button', { name: 'ボタン用URLをコピー' }));
    expect(await within(panel).findByText('コピーしました')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('送料'), { target: { value: '800' } });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ L' } });
    await waitFor(() => expect(orderLinkUrl()).not.toBe(before));
    const after = orderLinkUrl();
    expect(within(panel).queryByText('コピーしました')).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'ボタン用URLをコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1][0]).toBe(after);

    fireEvent.click(within(panel).getByRole('button', { name: 'HTML で設置' }));
    expect(within(previewOf(panel)).getByRole('link', { name: 'JPYCで支払う' })).toHaveAttribute('href', after);
    fireEvent.click(within(panel).getByRole('button', { name: 'HTMLをコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
    expect(anchorOf(writeText.mock.calls[2][0] as string).getAttribute('href')).toBe(after);

    const parsed = parseCheckoutParams(new URL(after).searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.items).toEqual([
      { name: 'Tシャツ L', qty: 2, price: '3000' },
      { name: '送料', qty: 1, price: '800' },
    ]);
    expect(calcCheckoutPayable(parsed.params, 18)).toBe(6_800n * 10n ** 18n);
  });

  it('店名・商品名・説明に & " < > があっても HTML が壊れず、取り出した href が注文リンクと一致する', async () => {
    const writeText = stubClipboard();
    await startReusable({ storeName: 'A&B "工房" <shop>' });
    fireEvent.click(screen.getByRole('button', { name: '説明を追加' }));
    fireEvent.change(screen.getByLabelText('説明'), { target: { value: '"秋" & <冬> の販売' } });
    fillItem('T&C <M> "red"');
    const panel = await openSiteButton();
    const url = orderLinkUrl();
    fireEvent.click(within(panel).getByRole('button', { name: 'HTML で設置' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'HTMLをコピー' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const html = writeText.mock.calls[0][0] as string;
    const anchor = anchorOf(html);
    expect(anchor.getAttribute('href')).toBe(url);
    expect(anchor.textContent).toBe('JPYCで支払う');
    expect(within(previewOf(panel)).getByRole('link', { name: 'JPYCで支払う' })).toHaveAttribute('href', url);

    const parsed = parseCheckoutParams(new URL(url).searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.storeName).toBe('A&B "工房" <shop>');
    expect(parsed.params.description).toBe('"秋" & <冬> の販売');
    expect(parsed.params.items[0]).toEqual({ name: 'T&C <M> "red"', qty: 2, price: '3000' });
  });

  it('コピーに失敗したら「コピーできませんでした」と出し、手で写せる欄 (全選択) へ案内する', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    await startReusable();
    fillItem();
    const panel = await openSiteButton();
    const url = orderLinkUrl();
    expect(within(panel).queryByLabelText('ボタン用URL')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'ボタン用URLをコピー' }));
    expect(await within(panel).findByText('コピーできませんでした')).toBeInTheDocument();
    const urlField = within(panel).getByLabelText('ボタン用URL') as HTMLInputElement;
    expect(urlField).toHaveValue(url);
    expect(urlField).toHaveAttribute('readonly');
    await waitFor(() => expect(urlField).toHaveFocus());
    expect([urlField.selectionStart, urlField.selectionEnd]).toEqual([0, url.length]);
    expect(within(panel).queryByText('コピーしました')).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'HTML で設置' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'HTMLをコピー' }));
    expect(await within(panel).findByText('コピーできませんでした')).toBeInTheDocument();
    const htmlField = within(panel).getByLabelText('ボタンのHTML') as HTMLTextAreaElement;
    expect(htmlField).toHaveAttribute('readonly');
    await waitFor(() => expect(htmlField).toHaveFocus());
    expect(anchorOf(htmlField.value).getAttribute('href')).toBe(url);
    expect([htmlField.selectionStart, htmlField.selectionEnd]).toEqual([0, htmlField.value.length]);
  });

  it('続けて 2 回押し、後の試行が先に成功してから前の試行が失敗しても、最新の「コピーしました」を上書きしない', async () => {
    const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
    stubClipboard(
      vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      ),
    );
    await startReusable();
    fillItem();
    const panel = await openSiteButton();
    const button = within(panel).getByRole('button', { name: 'ボタン用URLをコピー' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve();
    expect(await within(panel).findByText('コピーしました')).toBeInTheDocument();
    pending[0].reject(new Error('denied'));
    // 前の試行の失敗は捨てる (表示・手で写す欄・focus を動かさない)。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(panel).getByText('コピーしました')).toBeInTheDocument();
    expect(within(panel).queryByText('コピーできませんでした')).toBeNull();
    expect(within(panel).queryByLabelText('ボタン用URL')).toBeNull();
  });

  it('コピーできない環境では、コピーのボタンを出さず、URL と HTML を手で写す欄を出す', async () => {
    await startReusable();
    fillItem();
    const panel = await openSiteButton();
    const url = orderLinkUrl();
    expect(within(panel).queryByRole('button', { name: 'ボタン用URLをコピー' })).toBeNull();
    expect(within(panel).getByLabelText('ボタン用URL')).toHaveValue(url);
    fireEvent.click(within(panel).getByRole('button', { name: 'HTML で設置' }));
    expect(within(panel).queryByRole('button', { name: 'HTMLをコピー' })).toBeNull();
    expect(anchorOf((within(panel).getByLabelText('ボタンのHTML') as HTMLTextAreaElement).value).getAttribute('href')).toBe(url);
  });

  it('設置の欄に、作り直しの案内・サイトに置く注意・「入金を確かめる」への導線を出し、すぐ下の注意 (届いた額・金額の書き換え) は繰り返さない', async () => {
    await startReusable();
    fillItem();
    const panel = await openSiteButton();
    expect(
      within(panel).getByText('価格や送料を変更したら、注文リンクを作り直し、サイトに設置したボタンのリンク先も更新してください。'),
    ).toBeInTheDocument();
    // 届く額と「お客様は金額を書き換えられます」は、この欄のすぐ下の注意に 1 回だけ出す (欄の中で繰り返さない・2026-11-20 運営者の指摘)。
    expect(within(panel).queryByText('ウォレットに 6,435 JPYC 届いてから発送')).toBeNull();
    expect(screen.getAllByText('ウォレットに 6,435 JPYC 届いてから発送')).toHaveLength(1);
    expect(within(panel).queryByText('お客様は金額を書き換えられます')).toBeNull();
    expect(screen.getAllByText('お客様は金額を書き換えられます')).toHaveLength(1);
    expect(within(panel).getByText('サイトに置いたリンクは、誰でも見られます')).toBeInTheDocument();
    const verify = within(panel).getByRole('link', { name: '入金を確かめる' });
    expect(verify).toHaveAttribute('href', '#order-link-verify-heading');
    expect(document.getElementById('order-link-verify-heading')).toHaveTextContent('入金を確かめる');
  });

  it('英語でも表示でき、ボタンの文字は Pay with JPYC', async () => {
    saved({ linkKind: 'reusable' });
    render(<OrderLinkBuilder />, { locale: 'en' });
    await screen.findByRole('button', { name: 'Settings' });
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Mug' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '1500' } });
    const summary = await screen.findByText('Add a button to your site');
    fireEvent.click(summary);
    const panel = summary.closest('details') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: 'With HTML' }));
    const url = screen.getByRole('link', { name: 'Open and check' }).getAttribute('href');
    expect(within(previewOf(panel)).getByRole('link', { name: 'Pay with JPYC' })).toHaveAttribute('href', url);
  });
});

/** HTML の文字列を parser に通して書き出した形 (見本の innerHTML と比べる・同じ文字列なら同じになる)。 */
function parseHtmlInnerHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.innerHTML;
}
