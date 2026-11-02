import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
const fetchSpy = vi.hoisted(() => vi.fn());

import { OrderLinkBuilder } from '@/components/OrderLinkBuilder';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

beforeEach(() => {
  localStorage.clear();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

async function fillOrder() {
  await userEvent.type(screen.getByPlaceholderText(/0x/), TO);
  fireEvent.change(screen.getByLabelText('注文番号'), { target: { value: 'A-001' } });
  fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('単価 (JPYC)'), { target: { value: '3000' } });
  fireEvent.change(screen.getByLabelText('送料 (JPYC)'), { target: { value: '500' } });
}

describe('OrderLinkBuilder', () => {
  it('入力が揃うまでリンクを出さず、足りないものを伝える', () => {
    render(<OrderLinkBuilder />);
    expect(screen.getByText('受取ウォレットを入れてください。')).toBeInTheDocument();
    expect(screen.queryByLabelText('お客様に送るリンク')).toBeNull();
  });

  it('リンクと金額の内訳を出し、発送の前に届いた額を確かめる案内を添える', async () => {
    render(<OrderLinkBuilder />);
    await fillOrder();
    const link = (await screen.findByLabelText('お客様に送るリンク')) as HTMLTextAreaElement;
    const url = new URL(link.value);
    expect(url.pathname).toBe('/checkout');
    expect(url.searchParams.get('order_id')).toBe('A-001');
    expect(url.searchParams.get('to')).toBe(TO);
    expect(screen.getByText('お客様の支払額').nextElementSibling).toHaveTextContent('6500 JPYC');
    expect(screen.getByText('発送の前に')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '開いて確かめる' })).toHaveAttribute('href', link.value);
  });

  it('氏名・住所の欄を持たず、URL に入れないよう案内する', () => {
    render(<OrderLinkBuilder />);
    expect(screen.queryByLabelText(/氏名|住所|電話/)).toBeNull();
    expect(screen.getByText(/お客様の氏名や住所は入れないでください/)).toBeInTheDocument();
  });

  it('リンクを作るだけでは通信しない', async () => {
    render(<OrderLinkBuilder />);
    await fillOrder();
    await screen.findByLabelText('お客様に送るリンク');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('注文番号は端末に残さない (受取先と設定だけを保存する)', async () => {
    render(<OrderLinkBuilder />);
    await fillOrder();
    await waitFor(() => {
      expect(localStorage.getItem('openpay:order-link-settings:v1')).toContain(TO);
    });
    const saved = localStorage.getItem('openpay:order-link-settings:v1') ?? '';
    expect(saved).not.toContain('A-001');
    expect(saved).not.toContain('Tシャツ');
  });

  it('商品の行を足して消せる', () => {
    render(<OrderLinkBuilder />);
    fireEvent.click(screen.getByRole('button', { name: '商品を追加' }));
    expect(screen.getAllByLabelText('商品名')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'この商品を削除' })[0]);
    expect(screen.getAllByLabelText('商品名')).toHaveLength(1);
  });

  it('英語でも表示できる', () => {
    render(<OrderLinkBuilder />, { locale: 'en' });
    expect(screen.getByText('Enter the receiving wallet.')).toBeInTheDocument();
  });
});
