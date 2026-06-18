import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
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
// レジ利用料 flag を切替え可能に (既定 OFF = レジ standard 無料 = 既存テストの挙動不変)。
const envHold = vi.hoisted(() => ({
  enableRegisterFee: false,
  enableShopLive: false,
  enableMenuOptions: false,
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
      get enableMenuOptions() {
        return envHold.enableMenuOptions;
      },
    },
  };
});

import { RegisterMode } from '@/components/RegisterMode';
import { parseCheckoutParams } from '@/lib/url';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QR_KEY = 'openpay:qr-settings:v2';

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

describe('RegisterMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    envHold.enableRegisterFee = false; // 毎テスト OFF 起点 (flag-ON テストが個別に立てる)
    envHold.enableShopLive = false; // Phase 1 flag も OFF 起点
    envHold.enableMenuOptions = false; // Phase 2 flag も OFF 起点
  });

  it('初期サンプルプリセットが表示される (コーヒー/Tシャツ/イベント参加費/Tip)', async () => {
    render(<RegisterMode />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /コーヒー/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Tシャツ/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tip/ })).toBeInTheDocument();
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
    const withImg = await screen.findByRole('button', { name: /限定グッズ/ });
    expect(withImg.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/item.png',
    );
    // 画像なしプリセットのカードには img を出さない (条件描画)。
    const noImg = screen.getByRole('button', { name: /画像なし商品/ });
    expect(noImg.querySelector('img')).toBeNull();
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
    const card = await screen.findByRole('button', { name: /限定グッズ/ });
    expect(card.querySelector('img')).not.toBeNull(); // 既定 ON
    await user.click(screen.getByLabelText('商品画像を表示'));
    // OFF にするとカードは残るが画像は出ない。
    expect(
      (await screen.findByRole('button', { name: /限定グッズ/ })).querySelector('img'),
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
    await screen.findByRole('button', { name: /コーラ/ });
    // チップ: ドリンク / フード が出る。
    expect(screen.getByRole('button', { name: 'ドリンク' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'フード' })).toBeInTheDocument();
    // 「フード」で絞ると コーラ (ドリンク) はグリッドから消え、ポテトは残る。
    await user.click(screen.getByRole('button', { name: 'フード' }));
    expect(screen.queryByRole('button', { name: /コーラ/ })).toBeNull();
    expect(screen.getByRole('button', { name: /ポテト/ })).toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: /牛丼/ }));
    await user.click(screen.getByRole('radio', { name: /大盛り/ }));
    await user.click(screen.getByRole('checkbox', { name: /えび/ }));
    await user.click(screen.getByRole('button', { name: 'カートに追加' }));
    // カート行: サフィックス名 + 実効単価 850 が入力欄に反映 (行は編集可)。
    expect(screen.getByDisplayValue('牛丼（大盛り・えび）')).toBeInTheDocument();
    expect(screen.getByDisplayValue('850')).toBeInTheDocument();
  });

  it('プリセット選択で商品名・単価がレジ入力欄に反映される', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    // 選択前: プリセット管理 (折りたたみ内) の行に 1 件だけ存在。
    expect(screen.getAllByDisplayValue('コーヒー')).toHaveLength(1);
    expect(screen.getAllByDisplayValue('500')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    // 選択後: レジ入力欄にも反映され 2 件になる。
    expect(screen.getAllByDisplayValue('コーヒー')).toHaveLength(2);
    expect(screen.getAllByDisplayValue('500')).toHaveLength(2);
  });

  it('受取先 + プリセット選択 → /checkout URL を生成 (items + 税 + 管理番号)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));

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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));

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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    expect(screen.queryByText(/\/checkout\?/)).toBeNull();
  });

  it('複数商品をカートに追加 → checkout items が複数になる', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /Tシャツ/ }));
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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /Tip/ }));
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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    expect((await parsedCheckout()).ok).toBe(true);
    await user.click(screen.getByRole('button', { name: 'この商品を削除' }));
    await waitFor(() => expect(screen.queryByText(/\/checkout\?/)).toBeNull());
  });

  it('未入力の行 (＋商品を追加のみ) は checkout items から除外される', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ })); // 有効 1 行
    await user.click(screen.getByRole('button', { name: '＋ カスタム追加' })); // 空行 (無効)
    const r = await parsedCheckout();
    expect(r.ok && r.params.items).toHaveLength(1); // 空行は除外
  });

  it('手入力 (商品名 + 単価) の行も checkout に乗る', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: '＋ カスタム追加' }));
    // カート行の入力欄 (placeholder='0' は単価のみ・名前は DOM 先頭の "例: コーヒー")。
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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ })); // qty 1
    await user.click(screen.getByRole('button', { name: '数量を減らす' }));
    await user.click(screen.getByRole('button', { name: '数量を減らす' }));
    const r = await parsedCheckout();
    expect(r.ok && r.params.items[0].qty).toBe(1);
  });

  it('明細は最大 10 件 (＋カスタム追加が 10 件で disabled)', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: '＋ カスタム追加' }));
    const add = () => screen.getByRole('button', { name: '＋ カスタム追加' });
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
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ })); // JPYC でカート確定
    await user.click(screen.getByRole('button', { name: /USDCグッズ/ })); // 異通貨 → 警告
    expect(screen.getByText(/カートは JPYC のみ/)).toBeInTheDocument();
    const r = await parsedCheckout();
    expect(r.ok && r.params.items).toHaveLength(1); // コーヒーのみ
  });

  it('受取先/通貨/決済設定を読み取り表示 +「決済QRの受取先で変更」リンク', async () => {
    seedReceiver();
    render(<RegisterMode onEditCurrency={vi.fn()} />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    // 受取先は静的短縮表示 (編集 input は無い)。
    expect(screen.getByText(/0x8335.*2913/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();
    // 決済設定サマリ (gasless 既定 = ガス代:お客様負担)。
    expect(
      screen.getByText(/ガスレス決済 \/ ガス代：お客様負担/),
    ).toBeInTheDocument();
    // 受取先ラベル + コンパクトな「変更」リンク。
    expect(screen.getByText('受取先:')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '変更' }),
    ).toBeInTheDocument();
  });

  it('空カートでも非空カートでも「決済QRの受取先で変更」→ onEditCurrency (非空は確認)', async () => {
    const user = userEvent.setup();
    const onEditCurrency = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedReceiver();
    render(<RegisterMode onEditCurrency={onEditCurrency} />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    // 非空カート → 確認ダイアログ → OK で遷移。
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: '変更' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onEditCurrency).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('QR は「QRコードを表示する」→ 全画面モーダルで提示 (×閉じるで戻る)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
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

  it('右サイドバーに注文サマリ (ご注文内容 + 小計/合計) を表示する', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    // POS サマリ: 見出し + 小計ラベルが描画される (旧・単独サマリボックスから刷新)。
    expect(screen.getByText('ご注文内容')).toBeInTheDocument();
    expect(screen.getByText('小計')).toBeInTheDocument();
    // 確定行がサマリ明細に出る (商品名 ×数量)。
    expect(screen.getByText('×1')).toBeInTheDocument();
  });

  it('プリセット0件でも「＋ カスタム追加」を常時描画する (グリッド統合)', async () => {
    // 有効プリセットが空でも空行追加導線は出す (常時描画化のエッジ)。
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({ presets: [] }),
    );
    render(<RegisterMode />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '＋ カスタム追加' }),
      ).toBeInTheDocument(),
    );
    // サンプルプリセット (コーヒー等) は出ない。
    expect(screen.queryByRole('button', { name: /コーヒー/ })).toBeNull();
  });

  // レジ システム利用料: flag ON のとき /checkout に feeKind='register' を付け、CheckoutForm が
  // standard 経路の JPYC 決済に recover の OpenPay利用料 % を課金する合図にする。
  it('flag ON: レジの /checkout URL に fee_kind=register が付く (standard 課金の合図)', async () => {
    envHold.enableRegisterFee = true;
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    const r = await parsedCheckout();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.feeKind).toBe('register');
  });

  it('flag OFF (既定): レジの /checkout URL に feeKind を付けない (完全 inert・現状維持)', async () => {
    const user = userEvent.setup();
    seedReceiver();
    render(<RegisterMode />);
    await waitFor(() => screen.getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: /コーヒー/ }));
    const r = await parsedCheckout();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.feeKind).toBeUndefined();
  });
});
