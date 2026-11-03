import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
// 受取チェーンが 2 つ以上のときの受取ウォレットの確認 (チェーンを読む部分は tests/hooks で見る)。
const chainCheck = vi.hoisted(() => ({ value: { status: 'idle' } as { status: string; chains?: string[] } }));
vi.mock('@/hooks/useReceiverChainCheck', () => ({ useReceiverChainCheck: () => chainCheck.value }));
const fetchSpy = vi.hoisted(() => vi.fn());

import { useAccount } from 'wagmi';
import { OrderLinkBuilder } from '@/components/OrderLinkBuilder';
import { chainForSlug } from '@/lib/chains';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x8F16000000000000000000000000000000000001';
const STORAGE_KEY = 'openpay:order-link-settings:v1';

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

function removeClipboard() {
  Reflect.deleteProperty(navigator, 'clipboard');
}

function fillItem() {
  fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
  fireEvent.change(screen.getByLabelText('送料'), { target: { value: '500' } });
}

async function copyLink() {
  fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
  await screen.findAllByRole('button', { name: '次の注文へ' });
}

beforeEach(() => {
  chainCheck.value = { status: 'idle' };
  localStorage.clear();
  resolved.value = { data: null, isFetching: false, error: null };
  vi.mocked(useAccount).mockReturnValue({
    address: undefined,
    isConnected: false,
  } as unknown as ReturnType<typeof useAccount>);
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  removeClipboard();
});

describe('OrderLinkBuilder', () => {
  it('受取先が決まるまでは入力欄を出し、赤くせずに次にやることを伝える', () => {
    render(<OrderLinkBuilder />);
    expect(screen.getByLabelText('受取ウォレット')).toBeInTheDocument();
    expect(screen.getByText('受取ウォレットを入れてください。')).toBeInTheDocument();
    expect(screen.getByText('ウォレットを接続すると自動で入ります。')).toBeInTheDocument();
    expect(screen.getByLabelText('商品名')).not.toHaveAttribute('aria-invalid');
  });

  it('受取先が決まっていれば要約の行に畳み、設定はシートで変える', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    expect(screen.queryByLabelText('受取ウォレット')).toBeNull();
    // 要約の行の名前は店名 (未設定ならそう出して、設定を促す)。
    expect(screen.getByText('店名未設定')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('受取ウォレット')).toHaveValue(TO);
    expect(screen.getByRole('button', { name: /利用料はかかりません/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /利用料はお店の受取から引かれます/ })).toBeInTheDocument();
  });

  it('店名を設定するとお客様の画面の見本とリンク (store) に出て、端末に残る', async () => {
    saved();
    render(<OrderLinkBuilder />);
    fireEvent.click(await screen.findByRole('button', { name: '設定' }));
    fireEvent.change(screen.getByLabelText('店名'), { target: { value: 'OpenPay 工房' } });
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    expect(screen.getAllByText('OpenPay 工房').length).toBeGreaterThanOrEqual(2); // 要約の行と見本
    fillItem();
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('store')).toBe('OpenPay 工房');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').storeName).toBe('OpenPay 工房'));
  });

  it('入力を終えて欄を離れると要約に畳む (打っている途中では畳まない)', async () => {
    render(<OrderLinkBuilder />);
    const receiver = screen.getByLabelText('受取ウォレット');
    await userEvent.type(receiver, TO);
    expect(screen.getByLabelText('受取ウォレット')).toBeInTheDocument();
    fireEvent.blur(receiver);
    // 畳むと受取ウォレットの欄が消え、要約の行 (店名未設定) になる。
    await waitFor(() => expect(screen.queryByLabelText('受取ウォレット')).toBeNull());
    expect(screen.getByText('店名未設定')).toBeInTheDocument();
  });

  it('受取ウォレットの欄が出ている間も「設定」から店名を入れられる (初めての人が店名に辿り着ける)', async () => {
    render(<OrderLinkBuilder />);
    expect(screen.getByLabelText('受取ウォレット')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('店名'), { target: { value: 'OpenPay 工房' } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').storeName).toBe('OpenPay 工房'));
  });

  it('お客様の画面の見本に内訳を出し、届いた額を確かめる案内を常に出す', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    expect(await screen.findByText('受付番号 #A-001')).toBeInTheDocument();
    expect(screen.getByText('6,000 JPYC')).toBeInTheDocument();
    expect(screen.getAllByText('6,500 JPYC').length).toBeGreaterThan(0);
    expect(screen.getByText('ウォレットに 6,435 JPYC 届いてから発送')).toBeInTheDocument();
    expect(screen.getByText('利用料 65 JPYC を引いた額。通常決済で払われたら 6,500 JPYC')).toBeInTheDocument();
    expect(screen.getByText('入金は OpenPay の履歴に出ません')).toBeInTheDocument();
    expect(screen.getByText('同じ額の注文は、お客様の Tx Hash で見分けます')).toBeInTheDocument();
    expect(screen.queryByText(/この注文は通常決済です/)).toBeNull();
    expect(screen.getByText('お店だけに表示')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '開いて確かめる' }).getAttribute('href')).toContain('order_id=A-001');
  });

  it('「何度でも使える」は番号の欄を出さず ship=ask のリンクにし、渡しても番号を進めない (種類は端末に残す)', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    expect(screen.getByRole('button', { name: 'この注文だけ' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '何度でも使える' }));
    expect(screen.queryByLabelText('注文番号')).toBeNull();
    fillItem();
    expect(await screen.findByText('何度でも使えるリンク')).toBeInTheDocument();
    expect(screen.queryByText(/受付番号 #/)).toBeNull();
    expect(screen.getByText('支払いの後、お客様は「注文を送る」でお名前とお届け先を送ります')).toBeInTheDocument();
    const href = screen.getByRole('link', { name: '開いて確かめる' }).getAttribute('href') ?? '';
    expect(new URL(href).searchParams.get('ship')).toBe('ask');
    expect(new URL(href).searchParams.has('order_id')).toBe(false);
    await copyLink();
    // 番号の注意 (使用済み) は出さず、番号も進めない
    expect(screen.queryByText(/使用済み/)).toBeNull();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.linkKind).toBe('reusable');
    expect(stored.lastOrderId).toBe('');
  });

  it('何度でも使えるリンクを共有するときは、SNS に置く向けの文にする', async () => {
    saved({ linkKind: 'reusable' });
    stubClipboard();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('何度でも使えるリンク');
    fireEvent.click(screen.getAllByRole('button', { name: '送る' })[0]);
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0][0].text).toContain('「注文を送る」からお名前とお届け先を送ってください');
    expect(share.mock.calls[0][0].text).not.toContain('ご注文');
    Reflect.deleteProperty(navigator, 'share');
  });

  it('注文の送り先を設定すると contact に入り、形の合わない値ではリンクを作らない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    fireEvent.click(await screen.findByRole('button', { name: '設定' }));
    fireEvent.click(screen.getByRole('button', { name: 'LINE' }));
    fireEvent.change(screen.getByLabelText('送り先'), { target: { value: 'OpenPay' } });
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    fillItem();
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('contact')).toBe('line:@openpay');
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    fireEvent.click(screen.getByRole('button', { name: 'メール' }));
    fireEvent.change(screen.getByLabelText('送り先'), { target: { value: 'shop@' } });
    expect(screen.getByLabelText('送り先')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('注文の送り先の形を確かめてください。').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').contactKind).toBe('mail'));
  });

  it('受取チェーンを 2 つ選ぶと chains のリンクになり (chain は書かない)、見本に選べるチェーンを出す', async () => {
    saved();
    render(<OrderLinkBuilder />);
    fireEvent.click(await screen.findByRole('button', { name: '設定' }));
    const kaia = screen.getByRole('button', { name: new RegExp(chainForSlug('kaia').name) });
    fireEvent.click(kaia);
    expect(kaia).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Safe などコントラクトのウォレットのときは、受取チェーンを 1 つに/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    chainCheck.value = { status: 'ok' };
    fillItem();
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    const url = new URL(link.href);
    expect(url.searchParams.get('chains')).toBe('polygon,kaia');
    expect(url.searchParams.has('chain')).toBe(false);
    expect(screen.getByText(/お客様が選べるチェーン:/)).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').chains).toEqual(['polygon', 'kaia']));
    // 最後の 1 つは外せない
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(chainForSlug('kaia').name) }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(chainForSlug('polygon').name) }));
    expect(screen.getByRole('button', { name: new RegExp(chainForSlug('polygon').name) })).toHaveAttribute('aria-pressed', 'true');
  });

  it('受取ウォレットがどれかのチェーンでコントラクトのウォレットなら、受取チェーンを 1 つにするよう伝えてリンクを作らない', async () => {
    saved({ chains: ['polygon', 'kaia'] });
    chainCheck.value = { status: 'contract', chains: ['kaia'] };
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    expect((await screen.findAllByText(/コントラクトのウォレットです。チェーンごとに持ち主が違うことがあるので/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
  });

  it('前の版の設定 (受取チェーン 1 つの chain) を読み、そのチェーンのリンクを作る', async () => {
    saved({ chain: 'kaia' });
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('chain')).toBe('kaia');
  });

  it('URL の文字列はコピーできる間は見せず、コピーできないときだけ見せる', async () => {
    saved();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    expect(screen.queryByLabelText('お客様に送るリンク')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
    expect(await screen.findByLabelText('お客様に送るリンク')).toBeInTheDocument();
    expect(screen.getByLabelText('お客様に送るリンク')).toHaveFocus();
    expect(screen.getByText('コピーできませんでした', { selector: 'p' })).toBeInTheDocument();
    // 失敗したら番号を進めない。
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('"lastOrderId":"A-001"');
  });

  it('氏名・住所の欄を持たず、説明の欄で URL に入れないよう案内する', () => {
    render(<OrderLinkBuilder />);
    expect(screen.queryByLabelText(/氏名|住所|電話/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '説明を追加' }));
    expect(screen.getByText('氏名・住所は入れないでください。URL に入ります。')).toBeInTheDocument();
  });

  it('リンクを作るだけでは通信しない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('端末に残すのは受取先・送料・最後の番号だけで、商品は残さない', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toContain('"lastOrderId":"A-001"'));
    const stored = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(stored).toContain('"shipping":"500"');
    expect(stored).not.toContain('Tシャツ');
    expect(stored).not.toContain('3000');
  });

  it('開いただけでは番号を進めない', async () => {
    saved({ lastOrderId: 'A-007' });
    const { unmount } = render(<OrderLinkBuilder />);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-008'));
    unmount();
    render(<OrderLinkBuilder />);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-008'));
  });

  it('コピーしても表示中の注文の番号は変わらず、次の注文へで進む (送料は残り、商品名へ移る)', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    expect(screen.getByLabelText('注文番号')).toHaveValue('A-001');
    fireEvent.click(screen.getAllByRole('button', { name: '次の注文へ' })[0]);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-002'));
    expect(screen.getByLabelText('商品名')).toHaveValue('');
    expect(screen.getByLabelText('送料')).toHaveValue('500');
    await waitFor(() => expect(screen.getByLabelText('商品名')).toHaveFocus());
  });

  it('通常決済なら利用料の行を出さず、届く額は合計と同じ', async () => {
    saved({ payMode: 'standard' });
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    expect(await screen.findByText('ウォレットに 6,500 JPYC 届いてから発送')).toBeInTheDocument();
    expect(screen.queryByText(/利用料 .* を引いた額/)).toBeNull();
    expect(screen.getByText('この注文は通常決済です。お客様にガス代が必要です')).toBeInTheDocument();
  });

  it('コピーの後は「コピーしました」を保ち、主ボタンは次の注文へになる', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    expect(screen.getAllByText('コピーしました').length).toBeGreaterThan(0);
    // 表示の時間切れに左右されず、送った状態が残る。
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(screen.getAllByRole('button', { name: '次の注文へ' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('コピーしました').length).toBeGreaterThan(0);
  });

  it('送った後に書き換えたら番号が使用済みだと知らせ、内容を残して番号を進められる', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    expect(screen.queryByText('A-001 は使用済みの番号です')).toBeNull();
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '別の商品' } });
    expect(await screen.findByText('A-001 は使用済みの番号です')).toBeInTheDocument();
    expect(screen.getByLabelText('注文番号')).toHaveValue('A-001');
    // 固定バーは合計に戻る (次の注文へに置き換えない)。
    expect(screen.getByText('合計', { selector: 'div' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '番号を進める' }));
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-002'));
    expect(screen.getByLabelText('商品名')).toHaveValue('別の商品');
    expect(screen.queryByText(/は使用済みの番号です/)).toBeNull();
  });

  it('番号を進めたら、この注文だけの通常決済も戻す', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '機材' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '60000' } });
    fireEvent.click(await screen.findByRole('button', { name: 'この注文だけ通常決済にする' }));
    await screen.findByText('ウォレットに 60,000 JPYC 届いてから発送');
    await copyLink();
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
    fireEvent.click(await screen.findByRole('button', { name: '番号を進める' }));
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-002'));
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('mode')).not.toBe('standard');
  });

  it('コピーの完了を待つ間に内容を変えても、番号が使用済みだと知らせる', async () => {
    saved();
    let finish: () => void = () => {};
    stubClipboard(vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })));
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('注文番号'), { target: { value: 'B-100' } });
    fillItem();
    await screen.findByText('受付番号 #B-100');
    fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '4000' } });
    await act(async () => {
      finish();
    });
    expect(await screen.findByText('B-100 は使用済みの番号です')).toBeInTheDocument();
    expect(screen.getByLabelText('注文番号')).toHaveValue('B-100');
  });

  it('番号を自分で変えたら使用済みの案内を出さない', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    fireEvent.change(screen.getByLabelText('注文番号'), { target: { value: 'B-100' } });
    await screen.findByText('受付番号 #B-100');
    expect(screen.queryByText(/は使用済みの番号です/)).toBeNull();
  });

  it('リンクの欄から手でコピーしても番号を確定し、次の注文へ進める', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    fireEvent.copy(await screen.findByLabelText('お客様に送るリンク'));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toContain('"lastOrderId":"A-001"'));
    fireEvent.click((await screen.findAllByRole('button', { name: '次の注文へ' }))[0]);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-002'));
  });

  it('再コピーに失敗したら「コピーしました」を出さない', async () => {
    saved();
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
    expect(await screen.findAllByText('コピーできませんでした')).not.toHaveLength(0);
    expect(screen.queryByText('コピーしました')).toBeNull();
  });

  it('内容を書き換えたらコピー失敗の表示を消す', async () => {
    saved();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
    await screen.findAllByText('コピーできませんでした');
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '別の商品' } });
    await waitFor(() => expect(screen.queryByText('コピーできませんでした')).toBeNull());
    expect(screen.getByLabelText('お客様に送るリンク')).toBeInTheDocument();
  });

  it('コピーの完了を待つ間に番号を書き換えたら、新しい番号を巻き戻さない', async () => {
    saved();
    let finish: () => void = () => {};
    stubClipboard(vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })));
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    fireEvent.click(screen.getAllByRole('button', { name: 'リンクをコピー' })[0]);
    fireEvent.change(screen.getByLabelText('注文番号'), { target: { value: 'B-100' } });
    await act(async () => {
      finish();
    });
    expect(screen.getByLabelText('注文番号')).toHaveValue('B-100');
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toContain('"lastOrderId":"A-001"'));
  });

  it('次の注文へ進んだ直後の空の注文に「コピーしました」を出さない', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await copyLink();
    fireEvent.click(screen.getAllByRole('button', { name: '次の注文へ' })[0]);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-002'));
    expect(screen.queryByText('コピーしました')).toBeNull();
  });

  it('共有できる端末では主ボタンが「送る」で、送り先の文面に番号と確かめ方が入る', async () => {
    saved();
    stubClipboard();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    fireEvent.click(screen.getAllByRole('button', { name: '送る' })[0]);
    await screen.findAllByRole('button', { name: '次の注文へ' });
    expect(screen.getAllByText('送りました').length).toBeGreaterThan(0);
    expect(share.mock.calls[0][0].text).toContain('ご注文 A-001');
    expect(share.mock.calls[0][0].text).toContain('Tx Hash');
    Reflect.deleteProperty(navigator, 'share');
  });

  it('共有を取り消したら番号を進めない', async () => {
    saved();
    Object.defineProperty(navigator, 'share', {
      value: vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')),
      configurable: true,
    });
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    await screen.findByText('受付番号 #A-001');
    fireEvent.click(screen.getAllByRole('button', { name: '送る' })[0]);
    await act(async () => {});
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('"lastOrderId":"A-001"');
    Reflect.deleteProperty(navigator, 'share');
  });

  it('続きを決められない番号なら、次の注文は番号の欄から始める', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('注文番号'), { target: { value: '秋のイベント' } });
    fillItem();
    await copyLink();
    fireEvent.click(screen.getAllByRole('button', { name: '次の注文へ' })[0]);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue(''));
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveFocus());
  });

  it('自動の番号だけの間は別のタブの設定を取り込む', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByText(/0x52d4/);
    saved({ receiver: OTHER });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await screen.findByText(/0x8F16/);
  });

  it('入力中は別のタブの受取先を取り込まない (注文の内容はそのままで宛先だけ変わるのを防ぐ)', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fillItem();
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toContain('"shipping":"500"'));
    saved({ receiver: OTHER, shipping: '500' });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(new URL(link.href).searchParams.get('to')).toBe(TO));
    expect(link.href).not.toContain(OTHER);
  });

  it('名前の再解決の間はリンクを出さない (期限切れのアドレスをコピーさせない)', async () => {
    resolved.value = { data: { address: TO }, isFetching: true, error: null };
    saved({ receiver: 'shop.eth' });
    render(<OrderLinkBuilder />);
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
    await screen.findByText('受取ウォレットの名前を確かめています。');
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
  });

  it('上限を超えると理由を出してリンクを出さない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '機材' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '60000' } });
    await screen.findByText(/ガス代不要の上限は 50,000 JPYC です/, { selector: 'p' });
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
    // いくら超えたかが分かるよう合計は残す。
    expect(screen.getAllByText('60,000 JPYC').length).toBe(2);
  });

  it('ガス代不要の上限を超えたら、通常決済へ 1 回で切り替えられる', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '機材' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '60000' } });
    fireEvent.click(await screen.findByRole('button', { name: 'この注文だけ通常決済にする' }));
    expect(await screen.findByText('ウォレットに 60,000 JPYC 届いてから発送')).toBeInTheDocument();
    expect(screen.getByText('この注文は通常決済です。お客様にガス代が必要です')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '開いて確かめる' }) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('mode')).toBe('standard');
  });

  it('通常決済への切り替えはこの注文だけで、次の注文と保存した設定には残さない', async () => {
    saved();
    stubClipboard();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '機材' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '60000' } });
    fireEvent.click(await screen.findByRole('button', { name: 'この注文だけ通常決済にする' }));
    await screen.findByText('ウォレットに 60,000 JPYC 届いてから発送');
    await copyLink();
    expect(localStorage.getItem(STORAGE_KEY)).toContain('"payMode":"gasless"');
    fireEvent.click(screen.getAllByRole('button', { name: '次の注文へ' })[0]);
    await waitFor(() => expect(screen.getByLabelText('注文番号')).toHaveValue('A-002'));
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('mode')).not.toBe('standard');
    expect(screen.queryByText(/この注文は通常決済です/)).toBeNull();
  });

  it('通常決済の上限も超えたら切り替えを勧めない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '機材' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '2000000' } });
    await screen.findByText(/1 回の支払いの上限は 50,000 JPYC です/, { selector: 'p' });
    expect(screen.queryByRole('button', { name: 'この注文だけ通常決済にする' })).toBeNull();
  });

  it('単価が入っているのに商品名が無ければ、その欄を示す', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '500' } });
    expect(screen.getByLabelText('商品名')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('単価')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('商品名を入れてください。', { selector: 'p' })).toBeInTheDocument();
  });

  it('数量が 2 以上の行は小計を見せる', () => {
    render(<OrderLinkBuilder />);
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
    expect(screen.queryByText(/× 2 =/)).toBeNull();
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
    expect(screen.queryByText(/× 2 =/)).toBeNull();
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    expect(screen.getByText('単価 3,000 × 2 = 6,000 JPYC')).toBeInTheDocument();
  });

  it('送料の見出しを押すと欄に移れる', () => {
    render(<OrderLinkBuilder />);
    const label = screen.getByText('送料');
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', 'order-link-shipping');
  });

  it('数量の 1.5 を 15 に変えず、欄の誤りとして止める', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '1.5' } });
    expect(screen.getByLabelText('数量')).toHaveValue('1.5');
    expect(screen.getByLabelText('数量')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('数量は 1〜999 で入れてください。', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
  });

  it('全角の数量は半角に直す', () => {
    render(<OrderLinkBuilder />);
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '２' } });
    expect(screen.getByLabelText('数量')).toHaveValue('2');
  });

  it('全角の数字以外は別の数字に変えない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '1²' } });
    expect(screen.getByLabelText('数量')).toHaveValue('1²');
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
  });

  it('負の単価を正の金額に変えず、欄の誤りとして止める', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '-100' } });
    expect(screen.getByLabelText('単価')).toHaveValue('-100');
    expect(screen.getByLabelText('単価')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('link', { name: '開いて確かめる' })).toBeNull();
  });

  it('負の金額を編集しても桁区切りが重ならない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '-1000' } });
    expect(screen.getByLabelText('単価')).toHaveValue('-1,000');
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '-1,0005' } });
    expect(screen.getByLabelText('単価')).toHaveValue('-10,005');
  });

  it('負の送料を正の金額に変えない', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '3000' } });
    fireEvent.change(screen.getByLabelText('送料'), { target: { value: '-500' } });
    expect(screen.getByLabelText('送料')).toHaveValue('-500');
    expect(screen.getByLabelText('送料')).toHaveAttribute('aria-invalid', 'true');
  });

  it('明細が 1 行も出せない誤りも読み上げる', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '0' } });
    expect(screen.getByRole('status')).toHaveTextContent('単価は数字で入れてください。');
  });

  it('「接続中のウォレットを使う」が出ている間は、欄を離れても畳まない', async () => {
    vi.mocked(useAccount).mockReturnValue({
      address: OTHER,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);
    saved({ receiver: '0xabc' });
    render(<OrderLinkBuilder />);
    const receiver = await screen.findByLabelText('受取ウォレット');
    fireEvent.change(receiver, { target: { value: TO } });
    fireEvent.blur(receiver);
    expect(screen.getByRole('button', { name: '接続中のウォレットを使う' })).toBeInTheDocument();
  });

  it('数量は − と ＋ で変えられ、1 より下がらない', async () => {
    render(<OrderLinkBuilder />);
    expect(screen.getByRole('button', { name: '数量を減らす' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '数量を増やす' }));
    expect(screen.getByLabelText('数量')).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: '数量を減らす' }));
    expect(screen.getByLabelText('数量')).toHaveValue('1');
  });

  it('金額は 3 桁区切りで見せ、値は区切りなしで扱う', async () => {
    saved();
    render(<OrderLinkBuilder />);
    await screen.findByRole('button', { name: '設定' });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価'), { target: { value: '12345' } });
    expect(screen.getByLabelText('単価')).toHaveValue('12,345');
    const link = (await screen.findByRole('link', { name: '開いて確かめる' })) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('items')).toContain(':12345');
  });

  it('商品の行を足して消せる', () => {
    render(<OrderLinkBuilder />);
    fireEvent.click(screen.getByRole('button', { name: '商品を追加' }));
    expect(screen.getAllByLabelText('商品名')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'この商品を削除' })[0]);
    expect(screen.getAllByLabelText('商品名')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'この商品を削除' })).toBeNull();
  });

  it('商品名で Enter を押すと単価へ進む', () => {
    render(<OrderLinkBuilder />);
    fireEvent.keyDown(screen.getByLabelText('商品名'), { key: 'Enter' });
    expect(screen.getByLabelText('単価')).toHaveFocus();
  });

  it('英語でも表示できる', () => {
    render(<OrderLinkBuilder />, { locale: 'en' });
    expect(screen.getByText('Enter the receiving wallet.', { selector: 'p' })).toBeInTheDocument();
  });
});
