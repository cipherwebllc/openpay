// MobileOrderBuilder を実描画で検証。flag OFF=非描画 / flag ON=編集→注文URL生成 /
// 料率 (1%・3% 等) を UI に露出しない (P1.2 は設定/URL のみ・課金は P2/P0 ゲート後)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({
  enableMobileOrder: true,
  enableHandles: false,
  enablePreorderTime: false,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableMobileOrder() {
        return h.enableMobileOrder;
      },
      get enableHandles() {
        return h.enableHandles;
      },
      get enablePreorderTime() {
        return h.enablePreorderTime;
      },
    },
  };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('@/components/StorefrontPublishPanel', () => ({
  StorefrontPublishPanel: ({ storefront }: { storefront: unknown }) => (
    <output data-testid="storefront-publish-parts">{JSON.stringify(storefront)}</output>
  ),
}));
// AddressInput: 入力時に onChange + onResolved(ADDR) を発火する軽量スタブ。
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({
    value,
    onChange,
    onResolved,
  }: {
    value: string;
    onChange: (v: string) => void;
    onResolved?: (a: string | null) => void;
  }) => (
    <input
      data-testid="addr"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        onResolved?.(ADDR);
      }}
    />
  ),
}));

import { MobileOrderBuilder } from '@/components/MobileOrderBuilder';

beforeEach(() => {
  window.localStorage.clear();
  h.enableMobileOrder = true;
  h.enableHandles = false;
  h.enablePreorderTime = false;
});

describe('MobileOrderBuilder', () => {
  it('編集画面のアバター・カバー・メニュー画像: no-referrer・lazy・失敗時は壊れ画像を出さず fallback・URL を直すと再試行 (R7a の網・B-R7)', () => {
    window.localStorage.setItem('openpay:product-presets:v1', JSON.stringify({
      presets: [{ id: 'p1', name: '画像商品', unitPrice: '500', token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, image: 'https://images.example/menu.png', sortOrder: 0, enabled: true }],
      receipt: { day: '', n: 0 },
    }));
    const { container } = renderWithIntl(<MobileOrderBuilder />);
    fireEvent.change(screen.getByLabelText('店名'), { target: { value: 'Cafe' } });
    const inputs = screen.getAllByPlaceholderText('https://');
    fireEvent.change(inputs[0], { target: { value: 'https://images.example/avatar.png' } });
    fireEvent.change(inputs[1], { target: { value: 'https://images.example/cover.png' } });
    fireEvent.click(screen.getByRole('button', { name: /登録中のメニュー/ }));
    // [kind, class, 失敗後に img があった位置へ出るもの (avatar = 頭文字・cover = 同寸の装飾枠・menu = 何も出さず商品名を残す)]
    const cases = [
      ['avatar', 'h-full w-full object-cover', '<span aria-hidden="true">C</span>'],
      // 入力欄の真上なので、枠ごと消すと打鍵のたびに入力欄が跳ねる → 画像と同じ箱 (h-24 w-full rounded-lg) を残す。
      ['cover', 'h-24 w-full rounded-lg object-cover', '<div aria-hidden="true" class="h-24 w-full rounded-lg bg-slate-100"></div>'],
      ['menu', 'h-7 w-7 rounded object-cover', ''],
    ] as const;
    // 右のライブプレビュー (MobileOrderView) にも同じ URL の画像があるので、編集欄の画像を alt+class で特定する。
    const editorImage = (url: string, className: string) =>
      container.querySelector(`img[alt=""][class="${className}"][src="${url}"]`);
    for (const [kind, className, fallback] of cases) {
      const image = editorImage(`https://images.example/${kind}.png`, className)!;
      // B-R7: 編集画面の URL を Referer として画像ホストへ送らない・画面外なら遅延・decode は非同期。
      expect(image.outerHTML).toBe(`<img alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="${className}" src="https://images.example/${kind}.png">`);
      const parent = image.parentElement!;
      const before = parent.innerHTML;
      fireEvent.error(image);
      expect(editorImage(`https://images.example/${kind}.png`, className)).toBeNull();
      expect(parent.innerHTML).toBe(before.replace(image.outerHTML, fallback));
    }
    // cover の装飾枠は画像と同じ箱 (高さ・幅・角丸) を持ち、失敗しても入力欄の位置が変わらない。
    const coverPlaceholder = inputs[1].previousElementSibling!;
    const imageBox = cases[1][1].split(' ').filter((c) => c !== 'object-cover');
    expect(coverPlaceholder).toHaveClass(...imageBox);
    // URL を直すと (失敗した URL だけを記録しているので) 新しい画像を再試行する。
    fireEvent.change(inputs[0], { target: { value: 'https://images.example/avatar2.png' } });
    fireEvent.change(inputs[1], { target: { value: 'https://images.example/cover2.png' } });
    expect(editorImage('https://images.example/avatar2.png', cases[0][1])).not.toBeNull();
    expect(editorImage('https://images.example/cover2.png', cases[1][1])).not.toBeNull();
  });

  it('D3: menu toggle accessible name contains the visible item count', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const toggle = screen.getByRole('button', { name: /登録中のメニュー/ });
    expect(toggle).toHaveAccessibleName(new RegExp(toggle.querySelector('span:not(.sr-only)')!.textContent!));
  });

  it('flag OFF では何も描画しない', () => {
    h.enableMobileOrder = false;
    const { container } = renderWithIntl(<MobileOrderBuilder />);
    expect(container).toBeEmptyDOMElement();
  });

  it('flag ON で見出し + レジ商品由来メニューを描画 (?s= 注文URLは前面に出さない)', () => {
    renderWithIntl(<MobileOrderBuilder />);
    expect(screen.getByText('モバイルオーダーを作成')).toBeInTheDocument();
    // メニューはレジの有効な JPYC 商品 (useProductPresets の seed: コーヒー等) を読み取り表示。
    expect(
      screen.getByText('メニューは「レジ」タブの有効な JPYC 商品です（画像・税率も共有）。'),
    ).toBeInTheDocument();
    // メニュー一覧は折りたたみ → トグルを開いて商品名 (seed: コーヒー) を確認。
    fireEvent.click(screen.getByRole('button', { name: /登録中のメニュー/ }));
    expect(screen.getAllByText('コーヒー').length).toBeGreaterThanOrEqual(1);
    // 共有は @handle 公開のみ。長い ?s= 注文 URL は出さず、プレビューは実際の店舗ページ (WYSIWYG)。
    expect(screen.queryByText(/\/order\?s=/)).toBeNull();
    expect(screen.getByText(/実際の見え方/)).toBeInTheDocument();
  });

  it('受取チェーンは複数選択 (チェックボックス)・既定 Polygon・最低1件を維持', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const polygon = screen.getByRole('checkbox', { name: 'JPYC (Polygon)' }) as HTMLInputElement;
    const kaia = screen.getByRole('checkbox', { name: 'JPYC (Kaia)' }) as HTMLInputElement;
    expect(polygon.checked).toBe(true); // 既定
    expect(kaia.checked).toBe(false);
    fireEvent.click(kaia); // Kaia 追加 → 両方
    expect(kaia.checked).toBe(true);
    expect(polygon.checked).toBe(true);
    fireEvent.click(polygon); // Polygon 解除 (Kaia 残る)
    expect(polygon.checked).toBe(false);
    fireEvent.click(kaia); // 最後の1件は外せない (最低1件維持)
    expect(kaia.checked).toBe(true);
  });

  it('受取先 + 店名を入力しても ?s= 注文 URL は前面に出さない (@handle 公開のみ)', () => {
    renderWithIntl(<MobileOrderBuilder />);
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    fireEvent.change(screen.getByPlaceholderText(/珈琲スタンド/), {
      target: { value: 'テスト店舗' },
    });
    expect(screen.queryByText(/\/order\?s=/)).toBeNull();
  });

  it('店舗情報 (住所/営業時間/電話) の入力欄を描画する', () => {
    renderWithIntl(<MobileOrderBuilder />);
    expect(screen.getByPlaceholderText(/東京都渋谷区/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/水曜定休/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例: 03-1234-5678')).toBeInTheDocument();
  });

  it('店舗設定を 5 つの小グループ見出しで順番どおりに区分する', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const headings = ['基本', '画像（任意）', '店舗情報（任意）', '受け渡し', 'SNS（任意）'].map(
      (name) => screen.getByRole('heading', { level: 3, name }),
    );
    headings.slice(0, -1).forEach((heading, index) => {
      expect(
        heading.compareDocumentPosition(headings[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it('@handle 公開 parts に lastOrder / minLeadMinutes を載せる', () => {
    h.enableHandles = true;
    h.enablePreorderTime = true;
    const { container } = renderWithIntl(<MobileOrderBuilder />);

    const timeInputs = container.querySelectorAll<HTMLInputElement>('input[type="time"]');
    expect(timeInputs).toHaveLength(2);
    fireEvent.change(timeInputs[0], {
      target: { value: '09:30' },
    });
    fireEvent.change(timeInputs[1], {
      target: { value: '21:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: '事前モバイルオーダー' }));
    const minLeadInput = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(minLeadInput).not.toBeNull();
    fireEvent.change(minLeadInput!, {
      target: { value: '20' },
    });

    const parts = JSON.parse(
      screen.getByTestId('storefront-publish-parts').textContent ?? '{}',
    );
    expect(parts).toMatchObject({
      openFrom: '09:30',
      lastOrder: '21:30',
      minLeadMinutes: 20,
    });
  });

  it('@handle 公開 parts は時間系の空値を省略する', () => {
    h.enableHandles = true;
    h.enablePreorderTime = true;
    renderWithIntl(<MobileOrderBuilder />);

    const parts = JSON.parse(
      screen.getByTestId('storefront-publish-parts').textContent ?? '{}',
    );
    expect(parts).not.toHaveProperty('openFrom');
    expect(parts).not.toHaveProperty('lastOrder');
    expect(parts).not.toHaveProperty('minLeadMinutes');
  });

  it('受付トグルを切替えると aria-checked と表示が変わる (既定=受付中)', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const sw = screen.getByRole('switch', { name: '注文の受付' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveTextContent('受付中');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveTextContent('停止中');
  });

  it('③メニュー一覧は既定で折りたたみ、トグルで開閉できる (レジ管理・長くなる対策)', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const toggle = screen.getByRole('button', { name: /登録中のメニュー/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false'); // 既定は閉
    // 一覧の「価格 JPYC」行は閉じている間は出ない (プレビューは価格のみで "JPYC" を付けない)。
    expect(screen.queryByText(/ JPYC$/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(/ JPYC$/).length).toBeGreaterThanOrEqual(1);
  });

  it('SNS リンクを 追加・入力・▼で並び替え・×で削除 できる (@handle と同型)', () => {
    renderWithIntl(<MobileOrderBuilder />);
    // 既定は SNS ゼロ → 「SNS リンクを追加」ボタンから行を増やす (Field の label 内ゆえ
    // 追加ボタンには aria-label が無く名前は label に吸われるので text で取得)。
    fireEvent.click(screen.getByText(/SNS リンクを追加/));
    fireEvent.click(screen.getByText(/SNS リンクを追加/));
    const inputs = screen.getAllByPlaceholderText('https://x.com/yourshop') as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0], { target: { value: 'https://a.example' } });
    fireEvent.change(inputs[1], { target: { value: 'https://b.example' } });
    // 1 行目を「下へ移動」(aria-label は名前として優先される) → 並びが入れ替わる。
    fireEvent.click(screen.getAllByRole('button', { name: '下へ移動' })[0]);
    expect(
      (screen.getAllByPlaceholderText('https://x.com/yourshop') as HTMLInputElement[]).map(
        (i) => i.value,
      ),
    ).toEqual(['https://b.example', 'https://a.example']);
    // 1 行目 (×) を削除 → 残り 1 件。
    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0]);
    expect(
      (screen.getAllByPlaceholderText('https://x.com/yourshop') as HTMLInputElement[]).map(
        (i) => i.value,
      ),
    ).toEqual(['https://a.example']);
  });

  it('店舗アイコン URL を入力するとプレビュー (円形 img) に反映される', () => {
    const { container } = renderWithIntl(<MobileOrderBuilder />);
    // アバター/カバー入力は placeholder 'https://' (SNS は 'https://x.com/yourshop' で別物)。
    // アバターが先頭 (カバーはその次) なので [0] を取る。
    const avatarInput = screen.getAllByPlaceholderText('https://')[0] as HTMLInputElement;
    fireEvent.change(avatarInput, { target: { value: 'https://img.example/icon.png' } });
    const matched = Array.from(container.querySelectorAll('img')).filter(
      (i) => i.getAttribute('src') === 'https://img.example/icon.png',
    );
    // 入力欄横プレビュー + 右カラムのプレビューカード。最低 1 箇所に出れば配線 OK。
    expect(matched.length).toBeGreaterThanOrEqual(1);
  });

  it('提供形態トグル: 既定テイクアウト・店内に切替えると aria-pressed が反転', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const takeout = screen.getByRole('button', { name: 'テイクアウト' });
    const dineIn = screen.getByRole('button', { name: '店内' });
    expect(takeout).toHaveAttribute('aria-pressed', 'true'); // 既定はテイクアウト
    expect(dineIn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(dineIn);
    expect(dineIn).toHaveAttribute('aria-pressed', 'true');
    expect(takeout).toHaveAttribute('aria-pressed', 'false');
  });

  it('事前モバイルオーダー: 提供形態トグルを隠しテイクアウト固定 (店内選択も解除)', () => {
    renderWithIntl(<MobileOrderBuilder />);
    // まず店内 (dineIn=true) を選択。
    fireEvent.click(screen.getByRole('button', { name: '店内' }));
    expect(screen.getByRole('button', { name: '店内' })).toHaveAttribute('aria-pressed', 'true');
    // 事前モバイルオーダーへ切替 → 来店前ゆえテーブル予約不可。toggle は消え、テイクアウト注記のみ。
    fireEvent.click(screen.getByRole('button', { name: '事前モバイルオーダー' }));
    expect(screen.queryByRole('button', { name: '店内' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'テイクアウト' })).toBeNull();
    expect(screen.getByText(/事前モバイルオーダーはテイクアウトのみ/)).toBeInTheDocument();
    // 店頭へ戻すと toggle が復活し、dineIn は解除済み (テイクアウトが選択状態)。
    fireEvent.click(screen.getByRole('button', { name: '店頭・券売機' }));
    expect(screen.getByRole('button', { name: 'テイクアウト' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '店内' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('プレビュー: SNS は店舗情報より前 (公開ページと同じヘッダー位置)', () => {
    const { container } = renderWithIntl(<MobileOrderBuilder />);
    // 営業時間 (店舗情報) + SNS を 1 件ずつ入力。
    fireEvent.change(screen.getByPlaceholderText(/水曜定休/), { target: { value: '11:00-22:00' } });
    fireEvent.click(screen.getByText(/SNS リンクを追加/));
    fireEvent.change(screen.getByPlaceholderText('https://x.com/yourshop'), {
      target: { value: 'https://x.com/myshop' },
    });
    // プレビューの SNS アンカー (SocialIconLinks) と店舗情報テキスト。
    const sns = container.querySelector('a[href="https://x.com/myshop"]');
    const hours = screen.getByText('11:00-22:00'); // プレビューの営業時間行 (input は value で別物)
    expect(sns).not.toBeNull();
    // SNS が DOM 上で店舗情報より前 = ヘッダー内 (店名/チェーン直下) の正しい位置。
    expect(sns!.compareDocumentPosition(hours) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('既定 (店頭モード) では手数料の負担トグルを出さない', () => {
    renderWithIntl(<MobileOrderBuilder />);
    expect(screen.queryByText('手数料の負担')).toBeNull();
  });

  it('事前モバイルオーダーに切替えると手数料の負担トグルが出る', () => {
    renderWithIntl(<MobileOrderBuilder />);
    fireEvent.click(screen.getByRole('button', { name: '事前モバイルオーダー' }));
    expect(screen.getByText('手数料の負担')).toBeInTheDocument();
    expect(screen.getByText('店舗が負担する')).toBeInTheDocument();
  });

  it('料率 (％つき数値) を UI に露出しない (課金は P2/P0 ゲート後)', () => {
    const { container } = renderWithIntl(<MobileOrderBuilder />);
    // 店頭・事前どちらのモードでも数値+％ の文言が出ないこと。
    fireEvent.click(screen.getByRole('button', { name: '事前モバイルオーダー' }));
    expect(container.textContent ?? '').not.toMatch(/\d\s*%/);
  });
});
