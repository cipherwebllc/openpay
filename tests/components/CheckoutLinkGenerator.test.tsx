import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({
    data: null,
    isFetching: false,
    error: null,
  })),
}));

import { CheckoutLinkGenerator } from '@/components/CheckoutLinkGenerator';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const STORAGE_KEY = 'openpay:checkout-settings:v1';

describe('CheckoutLinkGenerator', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('初期レンダリング: JPYC が default、chain selector は非表示 (Polygon 固定)', async () => {
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByRole('button', { name: /JPYC/ }));
    const jpycBtn = screen.getByRole('button', { name: /JPYC/ });
    const usdcBtn = screen.getByRole('button', { name: /USDC/ });
    expect(jpycBtn.className).toMatch(/border-brand/);
    expect(usdcBtn.className).not.toMatch(/border-brand/);
    // jpyc default なので chain selector field は表示されない
    expect(screen.queryByText('受取チェーン')).toBeNull();
  });

  it('USDC を選択すると chain selector が表示される', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByRole('button', { name: /USDC/ }));
    await user.click(screen.getByRole('button', { name: /USDC/ }));
    expect(screen.getByText('受取チェーン')).toBeInTheDocument();
    // testnet env では Arbitrum Sepolia=421614 が chain id として出る
    expect(screen.getByText(/id: 421614/)).toBeInTheDocument();
    expect(screen.getByText(/id: 11155420/)).toBeInTheDocument(); // OP Sepolia
  });

  it('items 全空 + receiver 入力 → URL は生成されない', async () => {
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x.../));
    expect(screen.getByText(/受取アドレスと商品を入力/)).toBeInTheDocument();
  });

  it('受取アドレス + 1 item 入力 → URL が生成される', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'T-shirt', qty: '1', price: '25' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() =>
      expect(screen.queryByText(/受取アドレスと商品を入力/)).toBeNull(),
    );
    expect(screen.getByText(/合計 \(プレビュー\):/)).toBeInTheDocument();
    expect(screen.getByText(/25 USDC/)).toBeInTheDocument();
    // URL のコピーボタンが出る
    expect(
      screen.getByRole('button', { name: /URL をコピー/ }),
    ).toBeInTheDocument();
    // URL 自体が DOM に出る (origin は jsdom 既定 https://test.local/)
    expect(
      document.body.textContent ?? '',
    ).toContain('/checkout?to=');
  });

  it('items の qty が 1000 (上限超過) → エラー文言 + URL 非生成', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'T-shirt', qty: '1000', price: '25' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => {
      expect(screen.getByText(/商品 #1:/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/数量は 1〜999 の整数で指定してください/),
    ).toBeInTheDocument();
    // URL は出ない
    expect(screen.queryByRole('button', { name: /URL をコピー/ })).toBeNull();
  });

  it('price が token decimals 超過 (USDC=6 で 7 桁) → エラー', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'A', qty: '1', price: '1.1234567' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByText(/商品 #1:/));
    expect(
      screen.getByText(/単価は正の小数 \(token decimals 以内\) で指定してください/),
    ).toBeInTheDocument();
  });

  it('部分入力 (qty のみ) → empty エラー', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: '', qty: '1', price: '' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByText(/商品 #1:/));
    expect(
      screen.getByText(/商品名 \/ 数量 \/ 単価 を全て入力してください/),
    ).toBeInTheDocument();
  });

  it('USDC → JPYC 切替で chain selector が消える (Polygon 固定)', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByRole('button', { name: /USDC/ }));
    // USDC を選択 → chain field 表示
    await user.click(screen.getByRole('button', { name: /USDC/ }));
    expect(screen.getByText('受取チェーン')).toBeInTheDocument();
    // JPYC に切替 → 受取チェーン Field が DOM から消える
    await user.click(screen.getByRole('button', { name: /JPYC/ }));
    expect(screen.queryByText('受取チェーン')).toBeNull();
  });

  it('+ 商品を追加 で 2 行目を追加できる', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByText(/\+ 商品を追加/));
    const initialNameInputs = screen.getAllByPlaceholderText('商品名');
    expect(initialNameInputs).toHaveLength(1);
    await user.click(screen.getByText(/\+ 商品を追加/));
    expect(screen.getAllByPlaceholderText('商品名')).toHaveLength(2);
  });

  it('全 metadata + items 入力 → URL に order_id / success_url 等が含まれる', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'arbitrum',
        gasMode: 'merchant',
        items: [{ name: 'A', qty: '2', price: '10' }],
        orderId: 'ord-7',
        description: 'Best',
        customerEmail: 'a@b.com',
        successUrl: 'https://shop.example.com/thanks',
        cancelUrl: 'https://shop.example.com/cart',
        webhook: 'https://shop.example.com/hook',
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() =>
      screen.getByRole('button', { name: /URL をコピー/ }),
    );
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/\/checkout\?to=/);
    expect(text).toMatch(/chain=arbitrum/);
    expect(text).toMatch(/gas=merchant/);
    expect(text).toMatch(/order_id=ord-7/);
    expect(text).toMatch(/success_url=https/);
    expect(text).toMatch(/webhook=https/);
  });

  it('security warning が常に表示される', async () => {
    render(<CheckoutLinkGenerator />);
    await waitFor(() => {
      expect(
        screen.getByText(/tx_hash を必ずオンチェーンで再検証/),
      ).toBeInTheDocument();
    });
  });

  it('chain ボタンクリック → setSettings.chain 更新で URL が arbitrum に切替', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'A', qty: '1', price: '5' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() =>
      screen.getByRole('button', { name: /URL をコピー/ }),
    );
    expect(document.body.textContent ?? '').not.toContain('chain=arbitrum');
    // chain id 421614 (Arbitrum Sepolia in testnet env) のボタンをクリック
    const arbBtn = screen.getByText(/id: 421614/).closest('button');
    expect(arbBtn).not.toBeNull();
    await user.click(arbBtn!);
    await waitFor(() =>
      expect(document.body.textContent ?? '').toContain('chain=arbitrum'),
    );
  });

  it('items remove ボタン → 行が削除され、最後の 1 行は空 row になる', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'A', qty: '1', price: '5' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByDisplayValue('A'));
    await user.click(screen.getByRole('button', { name: '削除' }));
    // 1 行が削除されて空の row 1 行が残る
    await waitFor(() => {
      expect(screen.queryByDisplayValue('A')).toBeNull();
    });
    expect(screen.getAllByPlaceholderText('商品名')).toHaveLength(1);
  });

  it('複数行: 中間の 1 行を削除 → 残りの行は維持', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [
          { name: 'A', qty: '1', price: '5' },
          { name: 'B', qty: '2', price: '10' },
          { name: 'C', qty: '3', price: '15' },
        ],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByDisplayValue('B'));
    // 2 番目 (B) の削除ボタンをクリック
    const removeBtns = screen.getAllByRole('button', { name: '削除' });
    expect(removeBtns).toHaveLength(3);
    await user.click(removeBtns[1]);
    // A と C は残る、B は消える
    await waitFor(() => {
      expect(screen.queryByDisplayValue('B')).toBeNull();
    });
    expect(screen.getByDisplayValue('A')).toBeInTheDocument();
    expect(screen.getByDisplayValue('C')).toBeInTheDocument();
  });

  it('全行削除: 最終行 → 空 row 補充 (settings.items を 空配列にしない)', async () => {
    const user = userEvent.setup();
    // 1 行だけの状態から削除 → 空 row が 1 行補充される
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'OnlyOne', qty: '1', price: '1' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByDisplayValue('OnlyOne'));
    await user.click(screen.getByRole('button', { name: '削除' }));
    // 補充された空 row があり、placeholder が出る
    await waitFor(() => {
      expect(screen.queryByDisplayValue('OnlyOne')).toBeNull();
    });
    expect(screen.getAllByPlaceholderText('商品名')).toHaveLength(1);
    // 入力 value は空
    const nameInput = screen.getByPlaceholderText('商品名') as HTMLInputElement;
    expect(nameInput.value).toBe('');
  });

  it('+ 商品を追加 を最大回数まで叩くと、ボタンが消える (10 件上限)', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByText('+ 商品を追加'));
    // 1 → 10 件まで足す (+9 回)
    for (let i = 0; i < 9; i++) {
      await user.click(screen.getByText('+ 商品を追加'));
    }
    expect(screen.getAllByPlaceholderText('商品名')).toHaveLength(10);
    // 10 件で「+ 商品を追加」は消える
    expect(screen.queryByText('+ 商品を追加')).toBeNull();
  });

  it('order_id / description / customer_email / cancel_url 入力 → setSettings 経由で localStorage 反映', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'A', qty: '1', price: '5' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/ord-12345/));
    const orderIdInput = screen.getByPlaceholderText(/ord-12345/);
    await user.type(orderIdInput, 'my-order');
    await waitFor(() => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      expect(raw).toContain('my-order');
    });
  });

  it('全 input handler 経路を exercise (description / email / cancel / webhook / success)', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'A', qty: '1', price: '5' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/ord-12345/));

    await user.type(
      screen.getByPlaceholderText(/ご注文ありがとうございます/),
      'desc',
    );
    await user.type(
      screen.getByPlaceholderText('alice@example.com'),
      'a@b.com',
    );
    await user.type(
      screen.getByPlaceholderText(/shop\.example\.com\/thanks/),
      'https://shop.example.com/thanks',
    );
    await user.type(
      screen.getByPlaceholderText(/shop\.example\.com\/cart/),
      'https://shop.example.com/cart',
    );
    await user.type(
      screen.getByPlaceholderText(/openpay-webhook/),
      'https://shop.example.com/hook',
    );

    await waitFor(() => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      expect(raw).toContain('desc');
      expect(raw).toContain('a@b.com');
      expect(raw).toContain('shop.example.com/thanks');
      expect(raw).toContain('shop.example.com/cart');
      expect(raw).toContain('shop.example.com/hook');
    });
  });

  it('items の name / qty / price input → 文字種フィルタ + state 更新', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByPlaceholderText('商品名'));
    const nameInput = screen.getByPlaceholderText('商品名');
    const qtyInput = screen.getByPlaceholderText('数量');
    const priceInput = screen.getByPlaceholderText('単価');

    await user.type(nameInput, 'T-shirt');
    // qty に英字を入れても数字に絞られる
    await user.type(qtyInput, '5abc');
    // price に小数点 OK、英字は除外
    await user.type(priceInput, '12.5xyz');

    expect((nameInput as HTMLInputElement).value).toBe('T-shirt');
    expect((qtyInput as HTMLInputElement).value).toBe('5');
    expect((priceInput as HTMLInputElement).value).toBe('12.5');
  });

  it('gas customer / merchant トグル → state が切替', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() =>
      screen.getByRole('button', { name: /顧客が gas 負担/ }),
    );
    const merchantBtn = screen.getByRole('button', { name: /店主が gas 負担/ });
    await user.click(merchantBtn);
    expect(merchantBtn.className).toMatch(/border-brand/);
  });

  it('JPYC token 切替 → settings.token / chain が変わる (LocalStorage 反映)', async () => {
    const user = userEvent.setup();
    render(<CheckoutLinkGenerator />);
    await waitFor(() => screen.getByRole('button', { name: /JPYC/ }));
    await user.click(screen.getByRole('button', { name: /JPYC/ }));
    await waitFor(() => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      expect(raw).toContain('"token":"jpyc"');
      expect(raw).toContain('"chain":"polygon"');
    });
  });

  it('URL コピーボタン → navigator.clipboard.writeText に URL が渡る', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'usdc',
        chain: 'base',
        items: [{ name: 'A', qty: '1', price: '5' }],
      }),
    );
    render(<CheckoutLinkGenerator />);
    await waitFor(() =>
      screen.getByRole('button', { name: /URL をコピー/ }),
    );
    await user.click(screen.getByRole('button', { name: /URL をコピー/ }));
    expect(writeText).toHaveBeenCalledOnce();
    const arg = writeText.mock.calls[0][0] as string;
    expect(arg).toContain('/checkout?to=');
    // ボタン文言が「コピー済み」に変わる
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /コピー済み/ })).toBeInTheDocument(),
    );
  });
});
