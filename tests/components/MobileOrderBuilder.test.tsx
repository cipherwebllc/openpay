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

  it('flag ON で見出し + seed メニュー + 未充足チェックリストを描画', () => {
    renderWithIntl(<MobileOrderBuilder />);
    expect(screen.getByText('モバイルオーダーを作成')).toBeInTheDocument();
    // seed メニュー 2 件が入力欄に出る
    expect(screen.getByDisplayValue('ブレンドコーヒー')).toBeInTheDocument();
    expect(screen.getByDisplayValue('チーズケーキ')).toBeInTheDocument();
    // 受取先/店名が未入力 → URL は出ず、必要項目リストが出る (ラベルと文言が重複するので
    // チェックリストの箱 (needLabel の親) 内で assert する)。
    const box = screen.getByText('注文ページ URL の発行に必要:').closest('div')!;
    expect(within(box).getByText('受取ウォレットアドレス')).toBeInTheDocument();
    expect(within(box).getByText('店名')).toBeInTheDocument();
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
    // seed メニューが既に有効行なので、受取先 + 店名で config が成立 → URL 表示。
    expect(screen.getByText(/\/order\?s=/)).toBeInTheDocument();
    expect(screen.getByText('コピー')).toBeInTheDocument();
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
