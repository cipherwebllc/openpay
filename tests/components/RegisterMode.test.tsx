import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
// 受取先の自動補完 (useReceiverAutofill) が useAccount を読むため最小モック。
// 既定は未接続 = 自動補完もチップも出ない (既存テストの挙動を維持)。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => 'https://test.local',
}));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
const sessionHold = vi.hoisted(() => ({ isSignedIn: false }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: sessionHold.isSignedIn,
    sessionAddress: sessionHold.isSignedIn
      ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      : null,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
  }),
}));
// レジ利用料 flag を切替え可能に (既定 OFF = レジ standard 無料 = 既存テストの挙動不変)。
const envHold = vi.hoisted(() => ({
  enableRegisterFee: false,
  enableShopLive: false,
  enableHandles: false,
  enableMenuOptions: false,
  enableStoreGasWallet: false,
  enableMobileOrder: false,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableRegisterFee() {
        return envHold.enableRegisterFee;
      },
      get enableShopLive() {
        return envHold.enableShopLive;
      },
      get enableHandles() {
        return envHold.enableHandles;
      },
      get enableMenuOptions() {
        return envHold.enableMenuOptions;
      },
      get enableStoreGasWallet() {
        return envHold.enableStoreGasWallet;
      },
      get enableMobileOrder() {
        return envHold.enableMobileOrder;
      },
    },
  };
});

import { RegisterMode } from '@/components/RegisterMode';
import { parseCheckoutParams } from '@/lib/url';
import ja from '@/messages/ja.json';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QR_KEY = 'openpay:qr-settings:v2';

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function seedReceiver() {
  window.localStorage.setItem(
    QR_KEY,
    JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }),
  );
}

// checkout URL は「QRコードを表示する」→ 全画面モーダル内に表示される。モーダルを
// 開いて (再クリックは冪等) URL を取り出す。CTA はデスクトップ右サイドバーとモバイル
// 下部バーの2箇所に描画される (jsdom は CSS 非適用で両方 DOM に居る) ので先頭をクリック。
async function parsedCheckout() {
  const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
  await userEvent.setup().click(btns[0]);
  const el = await screen.findByText(/\/checkout\?/);
  return parseCheckoutParams(new URL(el.textContent!).searchParams);
}


// 2026-10 磨き上げ P3: カートの行にも商品名のボタン (詳細の開閉) があるので、商品のタイルは「商品」の区切りの中で探す。
function tiles() {
  return within(screen.getByRole('region', { name: /^(商品|Products)$/ }));
}
async function findTile(name: RegExp) {
  const region = await screen.findByRole('region', { name: /^(商品|Products)$/ });
  return within(region).findByRole('button', { name });
}
// カートの行は 1 行表示 (名前・数量・金額)。名前を押すと単価・税・メモ・名前・削除が開く。
function orderPanel() {
  return within(screen.getByRole('region', { name: /^(ご注文|Order)$/ }));
}
async function openLine(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const toggle = orderPanel().getByRole('button', { name });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
}

describe('RegisterMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    envHold.enableRegisterFee = false; // 毎テスト OFF 起点 (flag-ON テストが個別に立てる)
    envHold.enableShopLive = false; // Phase 1 flag も OFF 起点
    envHold.enableHandles = false;
    envHold.enableMenuOptions = false; // Phase 2 flag も OFF 起点
    envHold.enableMobileOrder = false;
    sessionHold.isSignedIn = false;
    global.fetch = vi.fn(async () => jsonRes({ ok: false }, 404)) as unknown as typeof fetch;
  });

  it('D3: preset accessible name retains price and in-cart quantity', async () => {
    render(<RegisterMode />);
    const tile = await findTile(/コーヒー/);
    expect(tile).toHaveAccessibleName(/コーヒー.*500.*JPYC/);
    await userEvent.setup().click(tile);
    expect(tile).toHaveAccessibleName(/500.*JPYC/);
    expect(tile).toHaveAccessibleName('コーヒー 500 JPYC カートに 1 点');
  });

  it('初期サンプルプリセットが表示される (コーヒー/Tシャツ/イベント参加費/Tip)', async () => {
    render(<RegisterMode />);
    await waitFor(() =>
      expect(tiles().getByRole('button', { name: /コーヒー/ })).toBeInTheDocument(),
    );
    expect(tiles().getByRole('button', { name: /Tシャツ/ })).toBeInTheDocument();
    expect(tiles().getByRole('button', { name: /Tip/ })).toBeInTheDocument();
  });

  it('プリセットに画像URL(https)があればレジのカードにサムネ表示・無ければ出ない', async () => {
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          {
            id: 'p1',
            name: '限定グッズ',
            unitPrice: '1200',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            image: 'https://example.com/item.png',
            sortOrder: 0,
            enabled: true,
          },
          {
            id: 'p2',
            name: '画像なし商品',
            unitPrice: '300',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            sortOrder: 1,
            enabled: true,
          },
        ],
        receipt: { day: '', n: 0 },
      }),
    );
    render(<RegisterMode />);
    const withImg = await findTile(/限定グッズ/);
    expect(withImg.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/item.png',
    );
    // 画像なしプリセットのカードには img を出さない (条件描画)。
    const noImg = tiles().getByRole('button', { name: /画像なし商品/ });
    expect(noImg.querySelector('img')).toBeNull();
  });

  it('レジの商品画像: no-referrer・lazy と、失敗時の inline display:none・URL を直すと新しい node で再表示 (R7a の網・B-R7)', async () => {
    window.localStorage.setItem('openpay:product-presets:v1', JSON.stringify({
      presets: [{ id: 'p1', name: '画像商品', unitPrice: '500', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, image: 'https://images.example/a.png', sortOrder: 0, enabled: true }],
      receipt: { day: '', n: 0 },
    }));
    render(<RegisterMode />);
    const button = await findTile(/画像商品/);
    const image = button.querySelector('img')!;
    // B-R7: decoding="async" を追加。
    expect(image.outerHTML).toBe('<img alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="mb-2 h-16 w-full rounded-lg object-cover " src="https://images.example/a.png">');
    const following = image.nextElementSibling;
    fireEvent.error(image);
    expect(button.querySelector('img')).toBe(image);
    expect(image).toHaveAttribute('style', 'display: none;');
    expect(image.nextElementSibling).toBe(following);
    fireEvent.click(button);
    expect(button.querySelector('img')).toBe(image);
    expect(image).toHaveAttribute('style', 'display: none;');
    // 同じ画面の商品管理 (「商品を編集」のシート) で URL を直すと新しい node になり、旧 node の display:none は残らない
    // (R7a までは node を使い回し、直した URL も隠れたままだった)。
    fireEvent.click(screen.getByRole('button', { name: '商品を編集' }));
    fireEvent.change(screen.getByLabelText('画像URL(任意)'), { target: { value: 'https://images.example/b.png' } });
    const corrected = button.querySelector('img')!;
    expect(corrected).not.toBe(image);
    expect(corrected).toHaveAttribute('src', 'https://images.example/b.png');
    expect(corrected).not.toHaveAttribute('style');
  });

  it('商品画像表示 ON/OFF トグルで画像を出し分け (既定 ON)', async () => {
    envHold.enableShopLive = true; // 画像トグルは Phase 1 flag 裏
    const user = userEvent.setup();
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          {
            id: 'p1',
            name: '限定グッズ',
            unitPrice: '1200',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            image: 'https://example.com/item.png',
            sortOrder: 0,
            enabled: true,
          },
        ],
        receipt: { day: '', n: 0 },
      }),
    );
    render(<RegisterMode />);
    const card = await findTile(/限定グッズ/);
    expect(card.querySelector('img')).not.toBeNull(); // 既定 ON
    // 画像の表示切替は「商品を編集」のシートの中 (2026-10 磨き上げ P3)。
    await user.click(screen.getByRole('button', { name: '商品を編集' }));
    await user.click(screen.getByLabelText('商品画像を表示'));
    // OFF にするとカードは残るが画像は出ない。
    expect(
      (await findTile(/限定グッズ/)).querySelector('img'),
    ).toBeNull();
  });

  it('カテゴリー絞り込みチップで該当カテゴリーの商品だけ表示', async () => {
    envHold.enableShopLive = true; // カテゴリー絞り込みは Phase 1 flag 裏
    const user = userEvent.setup();
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          {
            id: 'd1',
            name: 'コーラ',
            unitPrice: '200',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            category: 'ドリンク',
            sortOrder: 0,
            enabled: true,
          },
          {
            id: 'f1',
            name: 'ポテト',
            unitPrice: '300',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            category: 'フード',
            sortOrder: 1,
            enabled: true,
          },
        ],
        receipt: { day: '', n: 0 },
      }),
    );
    render(<RegisterMode />);
    await findTile(/コーラ/);
    // チップ: ドリンク / フード が出る。
    expect(screen.getByRole('button', { name: 'ドリンク' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'フード' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ドリンク' }).querySelector('.h-2')).not.toBeNull();
    expect(tiles().getByRole('button', { name: /コーラ/ })).toHaveClass('border-l-4');
    // 「フード」で絞ると コーラ (ドリンク) はグリッドから消え、ポテトは残る。
    await user.click(screen.getByRole('button', { name: 'フード' }));
    expect(tiles().queryByRole('button', { name: /コーラ/ })).toBeNull();
    expect(tiles().getByRole('button', { name: /ポテト/ })).toBeInTheDocument();
  });

  it('公開店舗の live soldOut に含まれる商品へバッジと grayscale を表示し、販売操作は塞がない', async () => {
    envHold.enableShopLive = true;
    envHold.enableHandles = true;
    sessionHold.isSignedIn = true;
    const patchBodies: unknown[] = [];
    global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === '/api/handle') {
        return jsonRes({
          handles: [
            {
              handle: 'shop',
              config: { to: VALID, name: 'Shop' },
              storefront: { chain: 'polygon', mode: 'storefront', feePayer: 'merchant', menu: [] },
            },
          ],
          max: 3,
        });
      }
      if (String(url).startsWith('/api/shop/live')) {
        if (init?.method === 'PATCH') {
          patchBodies.push(JSON.parse(String(init.body)));
          return jsonRes({ live: { soldOut: [], paused: false, updatedAt: 2 } });
        }
        return jsonRes({ live: { soldOut: ['p1'], paused: false, updatedAt: 1 } });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          {
            id: 'p1',
            name: '限定グッズ',
            unitPrice: '1200',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            image: 'https://example.com/item.png',
            sortOrder: 0,
            enabled: true,
          },
        ],
      }),
    );

    render(<RegisterMode />);

    // タイルのバッジ + 商品の編集シートの「売り切れ」切替 (シートを開いて 2 つ)。
    expect(await screen.findAllByText('売り切れ')).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('button', { name: '商品を編集' }));
    expect(await screen.findAllByText('売り切れ')).toHaveLength(2);
    const productButton = tiles().getByRole('button', { name: /限定グッズ/ });
    expect(productButton).toHaveAccessibleName(/売り切れ.*限定グッズ.*1,200.*JPYC/);
    expect(productButton).not.toBeDisabled();
    expect(productButton.querySelector('img')).toHaveClass('grayscale');
    const toggle = screen.getByRole('checkbox', { name: '売り切れ' });
    expect(toggle).toBeChecked();
    await userEvent.setup().click(toggle);
    await waitFor(() =>
      expect(patchBodies).toContainEqual({ op: 'soldOut', itemId: 'p1', value: false }),
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.getAllByText('売り切れ')).toHaveLength(1);
  });

  it('shop-live flag OFF ではサインイン済みでも売り切れ UI を出さない', async () => {
    sessionHold.isSignedIn = true;
    render(<RegisterMode />);
    await findTile(/コーヒー/);
    expect(screen.queryByText('売り切れ')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shop-live flag ON でも未サインインなら売り切れ UI を出さない', async () => {
    envHold.enableShopLive = true;
    envHold.enableHandles = true;
    render(<RegisterMode />);
    await findTile(/コーヒー/);
    expect(screen.queryByText('売り切れ')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shop-live の取得失敗は売り切れ UI を出さずレジ本体へ波及させない', async () => {
    envHold.enableShopLive = true;
    envHold.enableHandles = true;
    sessionHold.isSignedIn = true;
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url) === '/api/handle') {
        return jsonRes({
          handles: [
            {
              handle: 'shop',
              config: { to: VALID, name: 'Shop' },
              storefront: { chain: 'polygon', mode: 'storefront', feePayer: 'merchant', menu: [] },
            },
          ],
          max: 3,
        });
      }
      return jsonRes({ error: 'kv_error' }, 503);
    }) as unknown as typeof fetch;

    render(<RegisterMode />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/shop/live?h=shop', undefined),
    );
    expect(screen.queryByText('売り切れ')).toBeNull();
    expect(tiles().getByRole('button', { name: /コーヒー/ })).toBeEnabled();
  });

  it('オプション付き preset: 選択モーダル → 実効単価(850) + サフィックス名で行追加', async () => {
    envHold.enableMenuOptions = true;
    const user = userEvent.setup();
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          {
            id: 'gy',
            name: '牛丼',
            unitPrice: '500',
            token: 'jpyc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
            sortOrder: 0,
            enabled: true,
            options: [
              {
                id: 'g1',
                name: 'サイズ',
                type: 'single',
                required: true,
                choices: [
                  { id: 's', label: '小盛り', priceDelta: '0' },
                  { id: 'l', label: '大盛り', priceDelta: '200' },
                ],
              },
              {
                id: 'g2',
                name: 'トッピング',
                type: 'multi',
                choices: [{ id: 'ebi', label: 'えび', priceDelta: '150' }],
              },
            ],
          },
        ],
        receipt: { day: '', n: 0 },
      }),
    );
    render(<RegisterMode />);
    // options 付き preset をタップ → 即追加でなくモーダル。
    await user.click(await findTile(/牛丼/));
    await user.click(screen.getByRole('radio', { name: /大盛り/ }));
    await user.click(screen.getByRole('checkbox', { name: /えび/ }));
    await user.click(screen.getByRole('button', { name: 'カートに追加' }));
    // カート行: サフィックス名 + 実効単価 850 が入力欄に反映 (行を開くと編集可)。
    await openLine(user, /牛丼（大盛り・えび）/);
    expect(screen.getByDisplayValue('牛丼（大盛り・えび）')).toBeInTheDocument();
    expect(screen.getByDisplayValue('850')).toBeInTheDocument();
  });

  it('プリセット選択で商品名・単価がレジ入力欄に反映される', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    // 選択前: カートは空 (商品の編集はシートの中で、閉じている間は入力欄を出さない)。
    expect(screen.queryAllByDisplayValue('コーヒー')).toHaveLength(0);
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    // 選択後: カートの行に 1 行・開くと名前と単価の入力欄に反映されている。
    expect(orderPanel().getByRole('button', { name: /コーヒー/ })).toBeInTheDocument();
    await openLine(user, /コーヒー/);
    expect(screen.getAllByDisplayValue('コーヒー')).toHaveLength(1);
    expect(screen.getAllByDisplayValue('500')).toHaveLength(1);
  });

  it('受取先 + プリセット選択 → /checkout URL を生成 (items + 税 + 管理番号)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));

    const r1 = await parsedCheckout();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // 税は per-item (混在税率カート対応) で items に乗る。
    expect(r1.params.items[0]).toMatchObject({
      name: 'コーヒー',
      qty: 1,
      price: '500',
      taxRate: 10,
      taxCategory: 'taxable_10',
    });

    // 採番 → 管理番号が URL に乗る
    await user.click(screen.getByRole('button', { name: '採番' }));
    await waitFor(async () => {
      const r = await parsedCheckout();
      expect(r.ok && r.params.receiptNo).toMatch(/^R-\d{8}-\d{3}$/);
    });
  });

  it('数量を増やすと合計 (items.qty) が再計算される', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));

    expect((await parsedCheckout()).ok).toBe(true);

    await user.click(screen.getByRole('button', { name: '数量を増やす' }));
    await user.click(screen.getByRole('button', { name: '数量を増やす' }));

    await waitFor(async () => {
      const r = await parsedCheckout();
      expect(r.ok && r.params.items[0].qty).toBe(3);
    });
  });

  it('受取先未設定なら QR は生成されない (プレースホルダ表示)', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />); // receiver 未 seed
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    expect(screen.queryByText(/\/checkout\?/)).toBeNull();
  });

  it('複数商品をカートに追加 → checkout items が複数になる', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /Tシャツ/ }));
    await waitFor(async () => {
      const r = await parsedCheckout();
      expect(r.ok && r.params.items).toHaveLength(2);
    });
    const r = await parsedCheckout();
    if (!r.ok) return;
    expect(r.params.items.map((i) => i.name)).toEqual(['コーヒー', 'Tシャツ']);
  });

  it('同一プリセットを再追加すると数量が +1 される', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    await waitFor(async () => {
      const r = await parsedCheckout();
      expect(r.ok && r.params.items).toHaveLength(1);
      expect(r.ok && r.params.items[0].qty).toBe(2);
    });
  });

  it('混在税率 (コーヒー10% + Tip対象外) が per-item で items に乗る', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /Tip/ }));
    await waitFor(async () => {
      const r = await parsedCheckout();
      expect(r.ok && r.params.items).toHaveLength(2);
    });
    const r = await parsedCheckout();
    if (!r.ok) return;
    const coffee = r.params.items.find((i) => i.name === 'コーヒー');
    const tip = r.params.items.find((i) => i.name === 'Tip');
    expect(coffee?.taxRate).toBe(10);
    expect(coffee?.taxCategory).toBe('taxable_10');
    expect(tip?.taxRate).toBe(0);
    expect(tip?.taxCategory).toBe('out_of_scope');
  });

  it('行削除 (×) でカートから外れ、空になると QR が消える', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    expect((await parsedCheckout()).ok).toBe(true);
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    await openLine(user, /コーヒー/);
    await user.click(screen.getByRole('button', { name: 'この商品を削除' }));
    await waitFor(() => expect(screen.queryByText(/\/checkout\?/)).toBeNull());
  });

  it('未入力の行 (＋商品を追加のみ) は checkout items から除外される', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ })); // 有効 1 行
    await user.click(screen.getByRole('button', { name: '自由入力' })); // 空行 (無効)
    const r = await parsedCheckout();
    expect(r.ok && r.params.items).toHaveLength(1); // 空行は除外
  });

  it('手入力 (商品名 + 単価) の行も checkout に乗る', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: '自由入力' }));
    // 自由入力の行は開いた状態で足される (placeholder='0' は単価のみ・名前は "例: コーヒー")。
    await user.type(screen.getAllByPlaceholderText('例: コーヒー')[0], 'おにぎり');
    await user.type(screen.getByPlaceholderText('0'), '120');
    await waitFor(async () => {
      const r = await parsedCheckout();
      expect(r.ok && r.params.items[0]).toMatchObject({
        name: 'おにぎり',
        qty: 1,
        price: '120',
      });
    });
  });

  it('数量 − は 1 未満にならない (clamp)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ })); // qty 1
    await user.click(screen.getByRole('button', { name: '数量を減らす' }));
    await user.click(screen.getByRole('button', { name: '数量を減らす' }));
    const r = await parsedCheckout();
    expect(r.ok && r.params.items[0].qty).toBe(1);
  });

  it('明細は最大 10 件 (自由入力が 10 件で disabled)', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: '自由入力' }));
    const add = () => screen.getByRole('button', { name: '自由入力' });
    for (let i = 0; i < 10; i += 1) await user.click(add());
    expect(add()).toBeDisabled();
  });

  it('異通貨プリセットを同一カートに追加しようとすると警告し追加しない', async () => {
    const user = userEvent.setup();
    seedReceiver();
    // JPYC + USDC のプリセットを seed。
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          { id: 'p-j', name: 'コーヒー', unitPrice: '500', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: 0, enabled: true },
          { id: 'p-u', name: 'USDCグッズ', unitPrice: '5', token: 'usdc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: 1, enabled: true },
        ],
      }),
    );
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ })); // JPYC でカート確定
    await user.click(tiles().getByRole('button', { name: /USDCグッズ/ })); // 異通貨 → 警告
    expect(screen.getByText(/カートは JPYC のみ/)).toBeInTheDocument();
    const r = await parsedCheckout();
    expect(r.ok && r.params.items).toHaveLength(1); // コーヒーのみ
  });

  it('USDC を非既定チェーンで受ける店: JPYC 商品を経由しても USDC は同じチェーン・決済モードに戻る', async () => {
    const user = userEvent.setup();
    // 店主は決済QRタブで USDC を Arbitrum・通常決済にしている (Arc でも同じ経路。テスト環境は Arc flag OFF)。
    window.localStorage.setItem(
      QR_KEY,
      JSON.stringify({ receiver: VALID, token: 'usdc', chain: 'arbitrum', payMode: 'standard' }),
    );
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [
          { id: 'p-j', name: 'コーヒー', unitPrice: '500', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: 0, enabled: true },
          { id: 'p-u', name: 'USDCグッズ', unitPrice: '5', token: 'usdc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: 1, enabled: true },
        ],
      }),
    );
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    // JPYC 商品を打つ → JPYC へ暗黙に切替。会計を終えた想定でカートを空にする。
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    const jpyc = await parsedCheckout();
    // 初めての JPYC は既定のガスレス (直前の USDC の通常決済を引き継がない)。
    expect(jpyc.ok && jpyc.params).toMatchObject({ token: 'jpyc', chain: 'polygon', mode: 'gasless' });
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    await openLine(user, /コーヒー/);
    await user.click(screen.getAllByRole('button', { name: 'この商品を削除' })[0]);
    // 次の客は USDC 商品 → 店主が選んだ Arbitrum・通常決済に戻る (従来は Base に巻き戻っていた)。
    await user.click(tiles().getByRole('button', { name: /USDCグッズ/ }));
    const usdc = await parsedCheckout();
    expect(usdc.ok && usdc.params).toMatchObject({ token: 'usdc', chain: 'arbitrum', mode: 'standard' });
  });

  it('先頭の要約に受取先・支払い方法・「設定」(2026-10 磨き上げ P3: 決済QR と同じ要約と設定シート)', async () => {
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    // 受取先は短縮表示・保存済みなので会計画面に入力欄は出さない。
    expect(screen.getByText('0x8335…2913')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();
    expect(screen.getByText('ガス代不要')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^設定$/ })).toBeInTheDocument();
  });

  it('カートがあっても「設定」はタブを移らずにシートで開く (カートは消えない・確認も出さない)', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    seedReceiver();
    render(<RegisterMode />);
    await user.click(await findTile(/コーヒー/));
    await user.click(screen.getByRole('button', { name: /^設定$/ }));
    const sheet = screen.getByRole('dialog', { name: 'お店の設定' });
    for (const title of ['受け取り', '通貨とチェーン', '支払い方法', '控えとポスター']) {
      expect(within(sheet).getByRole('heading', { name: title })).toBeInTheDocument();
    }
    // レジの明細 QR は自動分配を使わないので、その欄は出さない。
    expect(within(sheet).queryByText(/売上の自動分配/)).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: '完了' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(orderPanel().getByRole('button', { name: /コーヒー/ })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('お店の設定でチェーンを変えると /checkout の chain が変わる (決済QR タブと同じ規則)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await user.click(await findTile(/コーヒー/));
    await user.click(screen.getByRole('button', { name: /^設定$/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'お店の設定' })).getByRole('button', { name: /^Kai/ }));
    await user.click(screen.getByRole('button', { name: '完了' }));
    const r = await parsedCheckout();
    expect(r.ok && r.params).toMatchObject({ token: 'jpyc', chain: 'kaia' });
  });

  it('QR は「QRコードを表示する」→ 全画面モーダルで提示 (×閉じるで戻る)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    // 即時には checkout URL を出さない。
    expect(screen.queryByText(/\/checkout\?/)).toBeNull();
    // ボタン → モーダルで URL / ポスター / コピー が出る (CTA は2箇所描画なので先頭)。
    await user.click(
      screen.getAllByRole('button', { name: /QRコードを表示する/ })[0],
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText(/\/checkout\?/)).toBeInTheDocument();
    // × 閉じる で dialog が消える。
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('B-R11e: 開いた QR の親が再描画されても外側の商品名入力から focus を奪わない', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await user.click(await findTile(/コーヒー/));
    // カートの行を開いておく (商品名の入力欄は QR の外)。
    await openLine(user, /コーヒー/);
    const opener = screen.getAllByRole('button', { name: /QRコードを表示する/ })[0];
    await user.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();

    const input = screen.getAllByRole('textbox', { name: ja.RegisterMode.productNameLabel })[0];
    expect(dialog).not.toContainElement(input);
    // 実際の親 state 更新で inline onClose が変わる。focus trap はこの PR の対象外。
    await user.type(input, 'AB');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('コーヒーAB');
    expect(screen.getByRole('dialog')).toBe(dialog);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input).toHaveFocus();
  });

  it('B-R11e: Copy URL の親 state 更新でボタンから focus を奪わず、閉じると起点へ戻す', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await user.click(await findTile(/コーヒー/));
    const opener = screen.getAllByRole('button', { name: /QRコードを表示する/ })[0];
    await user.click(opener);
    const copy = screen.getByRole('button', { name: ja.RegisterMode.copyUrl });
    await user.click(copy);
    expect(await screen.findByRole('button', { name: ja.RegisterMode.copied })).toBe(copy);
    expect(copy).toHaveFocus();

    await user.click(screen.getByRole('button', { name: ja.RegisterMode.qrModalClose }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('注文パネル (ご注文 + 点数 + 小計/合計) を表示する', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    // 注文パネル: 見出し・点数・小計 (カート = ご注文。旧「ご注文内容」の重複表示は廃止)。
    expect(screen.getByRole('heading', { name: 'ご注文' })).toBeInTheDocument();
    expect(screen.getByText('1 点')).toBeInTheDocument();
    expect(screen.getByText('小計')).toBeInTheDocument();
    expect(orderPanel().getAllByText('500 JPYC').length).toBeGreaterThan(0);
  });

  it('プリセット0件でも「自由入力」を常時描画する (グリッド統合)', async () => {
    // 有効プリセットが空でも空行追加導線は出す (常時描画化のエッジ)。
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({ presets: [] }),
    );
    render(<RegisterMode />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '自由入力' }),
      ).toBeInTheDocument(),
    );
    // サンプルプリセット (コーヒー等) は出ない。
    expect(tiles().queryByRole('button', { name: /コーヒー/ })).toBeNull();
  });

  // レジ システム利用料: flag ON のとき /checkout に feeKind='register' を付け、CheckoutForm が
  // standard 経路の JPYC 決済に recover の OpenPay利用料 % を課金する合図にする。
  describe('モバイル注文への橋 (2026-10 磨き上げ P4)', () => {
    it('モバイル注文が使えて、メニューにできる商品があれば出す・押すとモバイル注文タブへ', async () => {
      envHold.enableMobileOrder = true;
      const onStart = vi.fn();
      const user = userEvent.setup();
      render(<RegisterMode onStartMobileOrder={onStart} />);
      await findTile(/コーヒー/);
      expect(screen.getByText('このメニューで、スマホ注文も受けられます')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'モバイル注文を始める' }));
      expect(onStart).toHaveBeenCalledOnce();
    });

    it('閉じたらこの端末では出さない (次に開いても)', async () => {
      envHold.enableMobileOrder = true;
      const user = userEvent.setup();
      const { unmount } = render(<RegisterMode onStartMobileOrder={vi.fn()} />);
      await findTile(/コーヒー/);
      await user.click(screen.getByRole('button', { name: '閉じる' }));
      expect(screen.queryByText('このメニューで、スマホ注文も受けられます')).toBeNull();
      unmount();
      render(<RegisterMode onStartMobileOrder={vi.fn()} />);
      await findTile(/コーヒー/);
      expect(screen.queryByText('このメニューで、スマホ注文も受けられます')).toBeNull();
    });

    it('モバイル注文が使えない (flag OFF) ・メニューにできる商品 (有効な JPYC) が無いときは出さない', async () => {
      const first = render(<RegisterMode onStartMobileOrder={vi.fn()} />);
      await findTile(/コーヒー/);
      expect(screen.queryByText('このメニューで、スマホ注文も受けられます')).toBeNull();
      first.unmount();
      envHold.enableMobileOrder = true;
      window.localStorage.setItem('openpay:product-presets:v1', JSON.stringify({
        presets: [{ id: 'u', name: 'USDCグッズ', unitPrice: '5', token: 'usdc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: 0, enabled: true }],
        receipt: { day: '', n: 0 },
      }));
      render(<RegisterMode onStartMobileOrder={vi.fn()} />);
      await findTile(/USDCグッズ/);
      expect(screen.queryByText('このメニューで、スマホ注文も受けられます')).toBeNull();
    });

    it('商品の編集シートの先頭に「モバイル注文のメニューにもなる」の 1 行', async () => {
      envHold.enableMobileOrder = true;
      const user = userEvent.setup();
      render(<RegisterMode onStartMobileOrder={vi.fn()} />);
      await findTile(/コーヒー/);
      await user.click(screen.getByRole('button', { name: '商品を編集' }));
      expect(screen.getByText('ここで編集した商品は、モバイル注文のメニューにもなります。')).toBeInTheDocument();
    });
  });

  it('flag ON: レジの /checkout URL に fee_kind=register が付く (standard 課金の合図)', async () => {
    envHold.enableRegisterFee = true;
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    const r = await parsedCheckout();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.feeKind).toBe('register');
  });

  it('flag OFF (既定): レジの /checkout URL に feeKind を付けない (完全 inert・現状維持)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    const r = await parsedCheckout();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.feeKind).toBeUndefined();
  });

  it('お店の端末のガス用ウォレット: flag OFF (既定) では出さない・ON で出す', async () => {
    seedReceiver();
    const { unmount } = render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    expect(screen.queryByText('お店の端末のガス用ウォレット')).toBeNull();
    unmount();
    envHold.enableStoreGasWallet = true;
    try {
      render(<RegisterMode />);
      expect(await screen.findByText('お店の端末のガス用ウォレット')).toBeTruthy();
    } finally {
      envHold.enableStoreGasWallet = false;
    }
  });

  // インボイス: QR タブの共通設定 (店舗名・登録番号) を /checkout に載せ、顧客の控えに出す (表示専用)。
  it('店舗名とインボイス登録番号を /checkout URL に載せる (形式外の番号は載せない)', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      QR_KEY,
      JSON.stringify({
        receiver: VALID,
        token: 'jpyc',
        chain: 'polygon',
        storeName: 'OpenPay Cafe',
        invoiceNo: 't-1234-5678-90123',
      }),
    );
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    const r = await parsedCheckout();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.storeName).toBe('OpenPay Cafe');
    expect(r.params.invoiceNo).toBe('T1234567890123');
  });

  it('登録番号が形式外なら /checkout URL に載せない', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      QR_KEY,
      JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon', invoiceNo: 'T123' }),
    );
    render(<RegisterMode />);
    await waitFor(() => tiles().getByRole('button', { name: /コーヒー/ }));
    await user.click(tiles().getByRole('button', { name: /コーヒー/ }));
    const r = await parsedCheckout();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.invoiceNo).toBeUndefined();
  });
});
