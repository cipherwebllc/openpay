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
const fetchSpy = vi.hoisted(() => vi.fn());

import { OrderLinkBuilder } from '@/components/OrderLinkBuilder';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x8F16000000000000000000000000000000000001';
const STORAGE_KEY = 'openpay:order-link-settings:v1';

beforeEach(() => {
  localStorage.clear();
  resolved.value = { data: null, isFetching: false, error: null };
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

async function fillOrder() {
  await userEvent.type(screen.getByLabelText('受取ウォレット'), TO);
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
    // ガスレスは利用料が引かれ、お客様が通常決済に切り替えると満額が届く。どちらの額も案内する。
    expect(screen.getByText(/ガスレスなら 6435 JPYC、お客様が通常決済に切り替えたときは 6500 JPYC/)).toBeInTheDocument();
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

  it('通常決済は満額が届く案内にする', async () => {
    render(<OrderLinkBuilder />);
    await fillOrder();
    fireEvent.click(screen.getByRole('button', { name: /通常決済/ }));
    await screen.findByText(/6500 JPYC が届いたことを確かめてから/);
    expect(screen.getByText('OpenPay 利用料（お店の負担）').nextElementSibling).toHaveTextContent('0 JPYC');
  });

  it('入力中は別のタブの受取先を取り込まない (注文の内容はそのままで宛先だけ変わるのを防ぐ)', async () => {
    render(<OrderLinkBuilder />);
    await fillOrder();
    const link = (await screen.findByLabelText('お客様に送るリンク')) as HTMLTextAreaElement;
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toContain(TO));
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ receiver: OTHER, receiverSource: 'manual', chain: 'polygon', payMode: 'gasless' }),
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(new URL(link.value).searchParams.get('to')).toBe(TO));
    expect(link.value).not.toContain(OTHER);
  });

  it('名前の再解決の間はリンクを出さない (期限切れのアドレスをコピーさせない)', async () => {
    resolved.value = { data: { address: TO }, isFetching: true, error: null };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ receiver: 'shop.eth', receiverSource: 'manual', chain: 'polygon', payMode: 'gasless' }),
    );
    render(<OrderLinkBuilder />);
    fireEvent.change(screen.getByLabelText('注文番号'), { target: { value: 'A-001' } });
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Tシャツ M' } });
    fireEvent.change(screen.getByLabelText('単価 (JPYC)'), { target: { value: '3000' } });
    await screen.findByText('受取ウォレットの名前を確かめています。');
    expect(screen.queryByLabelText('お客様に送るリンク')).toBeNull();
  });

  it('上限を超えると理由を出す', async () => {
    render(<OrderLinkBuilder />);
    await fillOrder();
    fireEvent.change(screen.getByLabelText('単価 (JPYC)'), { target: { value: '60000' } });
    await screen.findByText(/1 回の支払いの上限は 50000 JPYC です/);
    expect(screen.queryByLabelText('お客様に送るリンク')).toBeNull();
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
