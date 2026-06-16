// MobileOrderBuilder を実描画で検証。flag OFF=非描画 / flag ON=編集→注文URL生成 /
// 料率 (1%・3% 等) を UI に露出しない (P1.2 は設定/URL のみ・課金は P2/P0 ゲート後)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({ enableMobileOrder: true }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableMobileOrder() {
        return h.enableMobileOrder;
      },
    },
  };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
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
});

describe('MobileOrderBuilder', () => {
  it('flag OFF では何も描画しない', () => {
    h.enableMobileOrder = false;
    const { container } = renderWithIntl(<MobileOrderBuilder />);
    expect(container).toBeEmptyDOMElement();
  });

  it('flag ON で見出し + レジ商品由来メニュー + 未充足チェックリストを描画', () => {
    renderWithIntl(<MobileOrderBuilder />);
    expect(screen.getByText('モバイルオーダーを作成')).toBeInTheDocument();
    // メニューはレジの有効な JPYC 商品 (useProductPresets の seed: コーヒー等) を読み取り表示。
    expect(
      screen.getByText('メニューは「レジ」タブの有効な JPYC 商品です（画像・税率も共有）。'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('コーヒー').length).toBeGreaterThanOrEqual(1); // 一覧 + プレビュー
    // 受取先/店名 未入力 → URL は出ず必要項目リスト (menu は seed 済みなので needMenu は出ない)。
    const box = screen.getByText('注文ページ URL の発行に必要:').closest('div')!;
    expect(within(box).getByText('受取ウォレットアドレス')).toBeInTheDocument();
    expect(within(box).getByText('店名')).toBeInTheDocument();
    expect(within(box).queryByText('有効な JPYC 商品（レジで管理）を 1 件以上')).toBeNull();
  });

  it('受取チェーン select (JPYC) を描画 — 既定 Polygon + Kaia', () => {
    renderWithIntl(<MobileOrderBuilder />);
    const chainSelect = screen.getByRole('combobox', { name: '受取チェーン' }) as HTMLSelectElement;
    expect(chainSelect.value).toBe('polygon'); // 既定
    expect(within(chainSelect).getByRole('option', { name: 'Polygon' })).toBeInTheDocument();
    expect(within(chainSelect).getByRole('option', { name: 'Kaia' })).toBeInTheDocument();
  });

  it('受取先 + 店名を入力すると注文ページ URL (/order?s=) が生成される', () => {
    renderWithIntl(<MobileOrderBuilder />);
    fireEvent.change(screen.getByTestId('addr'), { target: { value: ADDR } });
    fireEvent.change(screen.getByPlaceholderText(/珈琲スタンド/), {
      target: { value: 'テスト店舗' },
    });
    // メニュー = レジ商品 seed (有効) なので、受取先 + 店名で config 成立 → URL 表示。
    expect(screen.getByText(/\/order\?s=/)).toBeInTheDocument();
    expect(screen.getByText('コピー')).toBeInTheDocument();
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
